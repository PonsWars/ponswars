import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import {
  debrisField,
  districtBlocks,
  islandCrags,
  reshuffleFrame,
  selectDetail,
  SETTLED_WORLD,
  type CameraState,
  type DetailLevel,
  type BlockForm,
  type DistrictShape,
  type ReshuffleFrame,
} from '@ponswars/world-runtime';
import { useFrame, useThree } from '@react-three/fiber';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { BackSide, Color, Object3D, ShaderMaterial } from 'three';
import type { Group, InstancedMesh, Mesh, PerspectiveCamera, PointLight } from 'three';
import { currentZoom, nowUtc, useSession, type ClientBattle } from '../state/session.js';
import {
  MARKET_CORE,
  SECTOR_ISLAND_RADIUS,
  SECTOR_PLATFORM_TOP,
  LOD_THRESHOLDS,
  SECTOR_POSITIONS,
  SECTOR_SKYLINE_HEIGHT,
} from './layout.js';
import { RESHUFFLE, RESHUFFLE_REDUCED, VIEWPORT_FIT, VOID_SKY } from './navigation-config.js';
import { SectorLabel } from './SectorLabel.js';
import { WorldInput } from './WorldInput.js';
import { WorldLighting } from './WorldLighting.js';

/**
 * The persistent world scene (§37.9, §38).
 *
 * §37.9 is the rule this file is built around: *"The world scene should remain
 * persistent across battle focus changes ... Do not destroy/recreate the full
 * world on every navigation action."* Nothing here unmounts when the player
 * moves between levels — what changes is the camera, the level of detail and
 * the HUD.
 *
 * The geometry is placeholder. §33 of the visual guide is explicit that the
 * delivered PNGs are art direction and *"production UI must be recreated as
 * semantic, responsive components"* with real assets; standing in a primitive
 * now is how the spatial behaviour gets proven before any of that exists.
 */

/** How many segments a sector platform gets at each detail level (§82.2). */
const SEGMENTS: Readonly<Record<DetailLevel, number>> = {
  FULL: 48,
  REDUCED: 20,
  SILHOUETTE: 8,
  CULLED: 3,
};

/**
 * The envelope a side's district is generated into.
 *
 * `OPEN` production tuning (§59.4), sized to the staging platform it stands on.
 * The generator keeps every structure inside these half-extents, so the number
 * that matters is this one: a district wider than its own ground overhangs it,
 * and that is the first thing that reads as broken from the sector camera.
 */
/** The height of a district's own platform, above the sector's ground. */
const DISTRICT_DECK = 10;

const DISTRICT_SHAPE: DistrictShape = {
  halfWidth: 22,
  halfDepth: 45,
  // Derived, not chosen. `SECTOR_SKYLINE_HEIGHT` is what the camera poses keep
  // clear of, and a peak set independently of it is the same fact written in
  // two places — which is how the battlefield pose ended up inside a building.
  peakHeight: SECTOR_SKYLINE_HEIGHT - SECTOR_PLATFORM_TOP - DISTRICT_DECK,
  edgeHeight: 26,
  minFootprint: 5,
  maxFootprint: 10,
  spacing: 1.4,
};

/** How much of a district gets built at each detail level (§82.2). */
const DISTRICT_DENSITY: Readonly<Record<DetailLevel, number>> = {
  FULL: 17,
  REDUCED: 7,
  SILHOUETTE: 0,
  CULLED: 0,
};

/** How many rocks hang under one plateau. */
const CRAGS_PER_ISLAND = 8;

/**
 * The width of the contested ground between the two districts (§38.3).
 *
 * The frontline travels across exactly this, so the two are one number. It used
 * to travel 124 units on a strip of ground 26 wide: at anything but an even
 * battle the marker stood inside a district, passing through buildings, which
 * reads as a rendering fault rather than as ground being taken.
 *
 * Sized to the gap the districts leave: they are 48 across and centred 62 out,
 * so their inner edges face each other 76 apart.
 */
const CONTESTED_WIDTH = 76;

/**
 * The seed a piece of terrain is generated from.
 *
 * A property of the *place* — which sector, which side — and of nothing else.
 * Seeding it from the battle would tie the skyline to the matchup, and §38.3
 * keeps a sector neutral: factions deploy into it, they do not own it. It would
 * also make the world rebuild itself at every reshuffle, which is exactly the
 * landmark §38.4 asks to keep.
 */
function terrainSeed(index: number, part: number): number {
  return index * 977 + part * 13;
}

/**
 * One instance of a shape, in the coordinate space of the field it belongs to.
 *
 * Positions rather than a scene graph, because these go through an
 * `InstancedMesh`: a hundred boxes as a hundred meshes is a hundred draw calls,
 * and §82.2 puts a frame budget on a world that has five of these fields in it
 * at once.
 */
interface Placement {
  readonly position: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
}

/**
 * A field of one shape, drawn in a single call.
 *
 * The geometry and material come in as children, so the same helper draws
 * buildings, their lit crowns, the rock under an island and the debris around
 * the world — four fields that differ in what they are made of and not at all
 * in how they are placed.
 *
 * Matrices are written in a layout effect rather than per frame: none of this
 * moves. Nothing here is animated, so nothing here costs anything after the
 * first commit.
 */
function InstancedField({
  placements,
  children,
}: {
  readonly placements: readonly Placement[];
  readonly children: readonly JSX.Element[];
}): JSX.Element | null {
  const field = useRef<InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = field.current;
    if (mesh === null) {
      return;
    }
    const step = new Object3D();
    for (const [index, placement] of placements.entries()) {
      step.position.set(...placement.position);
      step.rotation.set(...placement.rotation);
      step.scale.set(...placement.scale);
      step.updateMatrix();
      mesh.setMatrixAt(index, step.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // The renderer culls against bounds it did not compute: the matrices were
    // set here, so the sphere it inherited from a unit cube is wrong until it
    // is told. Without this a field vanishes as soon as its centre leaves frame.
    mesh.computeBoundingSphere();
  }, [placements]);

  if (placements.length === 0) {
    return null;
  }

  return (
    <instancedMesh ref={field} args={[undefined, undefined, placements.length]}>
      {children}
    </instancedMesh>
  );
}

/**
 * The Market Core's skyline, tallest at the centre.
 *
 * Written out rather than generated, because these are the shape of a landmark
 * rather than a pattern: §38.2 makes the core the thing a player orients by, and
 * a silhouette worth recognising is designed, not sampled from a random seed.
 */
const CORE_SPIRES: readonly { x: number; z: number; width: number; height: number }[] = [
  { x: 0, z: 0, width: 34, height: 200 },
  { x: -46, z: -18, width: 22, height: 138 },
  { x: 44, z: 12, width: 26, height: 154 },
  { x: -18, z: 48, width: 20, height: 108 },
  { x: 22, z: -50, width: 18, height: 122 },
  { x: -68, z: 44, width: 16, height: 76 },
  { x: 66, z: -44, width: 15, height: 84 },
];

/**
 * Reads the reshuffle at whatever instant the caller asks about (§15).
 *
 * Every part of the sequence is drawn from a pure function of elapsed time, so
 * the honest way to animate it is to ask what the world looks like *now*, once
 * per frame, in the component that moves.
 *
 * It was a value passed down as props, and that was a bug this file could not
 * see: props only change when React re-renders, and nothing here re-renders
 * per frame — the camera reducer deliberately returns the same object when the
 * camera has not moved, so a still camera does not re-render the tree sixty
 * times a second. A reshuffle watched with a still camera therefore advanced
 * only when something unrelated happened to re-render, which in practice meant
 * once a second when the next round snapshot arrived. The choreography was
 * correct and nobody was seeing it.
 *
 * A reader rather than a shared mutable frame, because `useFrame` callbacks run
 * in subscription order and subscription order is mount order — a writer in the
 * parent would run *after* its children and hand them the previous frame. The
 * reducer is pure and costs a few multiplications, so every caller computing it
 * for itself is both cheaper to reason about and exactly consistent.
 */
function useReshuffleReader(): () => ReshuffleFrame {
  const startedAt = useSession((state) => state.reshuffleStartedAt);
  const clockOffsetMs = useSession((state) => state.clockOffsetMs);
  const reducedMotion = useSession((state) => state.reducedMotion);

  return useCallback(
    () =>
      startedAt === null
        ? SETTLED_WORLD
        : reshuffleFrame(
            nowUtc() - startedAt - clockOffsetMs,
            reducedMotion ? RESHUFFLE_REDUCED : RESHUFFLE,
          ),
    [startedAt, clockOffsetMs, reducedMotion],
  );
}

/**
 * The bands of light up the core's spires.
 *
 * Derived from `CORE_SPIRES` rather than placed beside it, so a spire that
 * moves or changes height takes its lights with it. Spaced by height rather
 * than by count: a short spire with as many bands as a tall one reads as a
 * different kind of building.
 */
const CORE_LIGHTS: readonly Placement[] = CORE_SPIRES.flatMap((spire) => {
  const bands = Math.max(2, Math.round(spire.height / 34));
  return Array.from({ length: bands }, (_, index) => ({
    // Evenly up the shaft, stopping short of the roof so the top edge stays a
    // silhouette against the sky.
    position: [spire.x, ((index + 1) / (bands + 0.4)) * spire.height, spire.z] as const,
    scale: [spire.width * 1.04, 2.4, spire.width * 1.04] as const,
    rotation: [0, 0, 0] as const,
  }));
});

function MarketCore(): JSX.Element {
  const core = useRef<Group>(null);
  const beacon = useRef<Mesh>(null);
  const glow = useRef<PointLight>(null);
  const readReshuffle = useReshuffleReader();

  // §38.10: a permanent dark cinematic atmosphere whose lighting shifts by
  // phase, and §36.14 keeps the world subtly alive through slow rotation rather
  // than particles. A steady drift, not a spin.
  //
  // The pulse rides along here rather than arriving as a prop, so it moves at
  // frame rate like the rotation beside it.
  useFrame((_, delta) => {
    if (core.current !== null) {
      core.current.rotation.y += delta * 0.06;
    }
    const pulse = readReshuffle().corePulse;
    beacon.current?.scale.setScalar(1 + pulse * 2.4);
    if (glow.current !== null) {
      glow.current.intensity = 340 + pulse * 900;
      glow.current.distance = 620 + pulse * 700;
    }
  });

  return (
    <group ref={core} position={[MARKET_CORE.x, MARKET_CORE.y, MARKET_CORE.z]}>
      {/* The plateau the core stands on: §38.9 asks for verticality through
          plateaus and raised structures rather than a flat disc. */}
      <mesh position={[0, -14, 0]}>
        <cylinderGeometry args={[92, 118, 28, 6]} />
        <meshStandardMaterial color="#0d161d" metalness={0.2} roughness={0.88} />
      </mesh>

      {/* A spire cluster, tallest at the centre. The Market Core is the
          orientation anchor (§38.2), and a landmark has to be tall enough to
          find from anywhere in the ring — a sphere reads as an object, a
          skyline reads as a place. */}
      {CORE_SPIRES.map((spire, index) => (
        <mesh key={index} position={[spire.x, spire.height / 2, spire.z]}>
          <boxGeometry args={[spire.width, spire.height, spire.width]} />
          <meshStandardMaterial
            color="#1e3140"
            metalness={0.22}
            roughness={0.48}
            emissive="#0e3040"
            emissiveIntensity={0.42}
          />
        </mesh>
      ))}

      {/* Lit bands up every spire.
          §38.2 makes the core the thing a player orients by, and a landmark is
          found by its light before it is read by its shape. Unlit, the tallest
          structure in the world was also the dullest object in it — five
          islands with glowing decks around a grey silhouette. The colour is the
          core's own: it belongs to no faction, and §38.3 keeps it that way. */}
      <InstancedField placements={CORE_LIGHTS}>
        <boxGeometry key="core-band" args={[1, 1, 1]} />
        <meshBasicMaterial key="core-band-material" color="#4fd8c0" transparent opacity={0.72} />
      </InstancedField>

      {/* The beacon at the summit. One bright point the eye returns to, and
          the thing that swells while the rest of the world is apart (§15 step
          5) — the core is what survives every round. */}
      <mesh ref={beacon} position={[0, 208, 0]}>
        <sphereGeometry args={[5, 12, 12]} />
        <meshBasicMaterial color="#7fe3c4" />
      </mesh>
      <pointLight
        ref={glow}
        position={[0, 200, 0]}
        color="#5fd3b4"
        intensity={340}
        distance={620}
      />

      {/* Routing pulses out into the sectors (§38.2). */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -26, 0]}>
        <ringGeometry args={[128, 133, 64]} />
        <meshBasicMaterial color="#1d3f4d" transparent opacity={0.55} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -26, 0]}>
        <ringGeometry args={[168, 170, 64]} />
        <meshBasicMaterial color="#16323d" transparent opacity={0.35} />
      </mesh>
    </group>
  );
}

/**
 * The lines from the Market Core out to the five sectors (§38.2, §15).
 *
 * §38.2 describes the core as routing out into the sectors and §15 makes those
 * routes something a player watches connect and disconnect across a reshuffle.
 * Until now the core had two rings around it and nothing joined it to anything:
 * five islands in a circle read as five islands, not as one world with a centre.
 *
 * A pulse travels each route on a loop. §36.14 asks for a world kept subtly
 * alive rather than one full of particles, and a signal moving outward from the
 * core is the difference between a diagram and a place that is running.
 */
function Routes({ battles }: { readonly battles: readonly ClientBattle[] }): JSX.Element {
  // `undefined` is in the type because it is in the array: a slot whose ref
  // callback has not run yet holds nothing, and typing it as only `Group | null`
  // would make the guard below look like dead code while still being needed.
  const pulses = useRef<(Group | null | undefined)[]>([]);
  const rails = useRef<(Mesh | null | undefined)[]>([]);
  const readReshuffle = useReshuffleReader();

  useFrame((state) => {
    const extension = readReshuffle().route;

    for (const [index, rail] of rails.current.entries()) {
      const target = SECTOR_POSITIONS[index];
      if (rail === null || rail === undefined || target === undefined) {
        continue;
      }
      // Grows from the core outward rather than fading, so a route reaching a
      // sector is something a player watches arrive (§15 step 8). Half the
      // extension in position and all of it in scale — that is what keeps the
      // near end pinned to the core.
      //
      // Scaled rather than rebuilt. The length used to be a geometry argument,
      // which meant a new `BoxGeometry` allocated and uploaded for every value
      // it took: tolerable at the once-a-second it actually redrew at, and five
      // allocations a frame once it moved at frame rate.
      rail.position.set(
        (target.x * extension) / 2,
        (target.y * extension) / 2 + 2,
        (target.z * extension) / 2,
      );
      rail.scale.z = Math.max(extension, 0.0001);
      rail.visible = extension > 0.001;
    }

    for (const [index, pulse] of pulses.current.entries()) {
      const target = SECTOR_POSITIONS[index];
      if (pulse === null || pulse === undefined || target === undefined) {
        continue;
      }
      // A signal travels a finished route, not one still being laid.
      pulse.visible = extension > 0.999;
      // Staggered, so the five do not leave the core in lockstep — that reads
      // as a machine cycling rather than as traffic.
      const travel = (state.clock.elapsedTime * 0.28 + index * 0.2) % 1;
      pulse.position.set(target.x * travel, target.y * travel + 4, target.z * travel);
      // Fading in and out at both ends, so a pulse arrives rather than
      // disappearing at the edge of the platform.
      const fade = Math.sin(travel * Math.PI);
      pulse.scale.setScalar(0.6 + fade * 0.9);
    }
  });

  return (
    <group>
      {SECTOR_POSITIONS.map((position, index) => {
        const accent =
          battles[index] === undefined ? '#2a4553' : FACTION_ACCENT[battles[index].left];
        const length = Math.hypot(position.x, position.z);
        return (
          <group key={index}>
            <mesh
              // Laid along the route rather than rotated into place by hand:
              // the sectors sit at fixed angles, and an angle written twice is
              // an angle that can disagree with itself.
              //
              // Built at full length and scaled by the reshuffle each frame;
              // where it reaches is decided in `useFrame` above.
              ref={(node) => {
                rails.current[index] = node;
              }}
              rotation={[0, Math.atan2(position.x, position.z), 0]}
            >
              <boxGeometry args={[2.5, 1, length]} />
              <meshBasicMaterial color="#1b3a48" transparent opacity={0.5} />
            </mesh>
            <group
              ref={(node) => {
                pulses.current[index] = node;
              }}
            >
              <mesh>
                <sphereGeometry args={[4.5, 10, 10]} />
                <meshBasicMaterial color={accent} transparent opacity={0.85} />
              </mesh>
            </group>
          </group>
        );
      })}
    </group>
  );
}

interface SectorProps {
  readonly index: number;
  readonly battle: ClientBattle | undefined;
  readonly detail: DetailLevel;
  readonly isFocused: boolean;
  readonly onSelect: (index: number) => void;
}

function Sector({ index, battle, detail, isFocused, onSelect }: SectorProps): JSX.Element | null {
  const bases = useRef<(Group | null)[]>([]);
  const frontline = useRef<Mesh | null>(null);
  const readReshuffle = useReshuffleReader();
  const [hovered, setHovered] = useState(false);
  const gl = useThree((state) => state.gl);
  const position = SECTOR_POSITIONS[index];
  const held = battle?.frontline ?? 0.5;
  // Where the marker is standing, as opposed to where the server last said the
  // line is. Starts on the authoritative value so the first frame is not an
  // animation from the middle of the field.
  const shown = useRef(held);

  // What the reshuffle moves on a sector: the two forward bases folding away
  // and the frontline collapsing to the centre (§15 steps 3, 4 and 9). Driven
  // here rather than through props for the reason `useReshuffleReader` gives —
  // props do not change between renders, and there are no renders between
  // frames.
  useFrame((_, delta) => {
    const frame = readReshuffle();

    for (const base of bases.current) {
      if (base === null) {
        continue;
      }
      // Folds down into its own footing rather than shrinking to a point: the
      // footing is what was landed, and the mast unfolds from it.
      base.scale.y = Math.max(frame.forwardBase, 0.0001);
      base.visible = frame.forwardBase > 0.001;
    }

    const marker = frontline.current;
    if (marker !== null) {
      const showing = frame.frontline > 0.001;
      if (showing) {
        // Eased toward the authoritative position rather than snapped to it.
        // The line arrives about once a second on the realtime stream, and a
        // marker that teleports each time reads as a readout refreshing rather
        // than as ground being taken (§13.4, §36.14).
        //
        // It only ever *approaches* the server's value and never leads it, so
        // this is smoothing of an authoritative number and not a prediction of
        // one — §13 keeps the battlefield a visualisation of momentum, never a
        // source of it.
        shown.current += (held - shown.current) * Math.min(1, delta * 4);
      } else {
        // Hidden through the reshuffle, and the sector is about to hold a
        // different battle. Sliding across the field to the new one when it
        // reappears would animate a fight that never happened.
        shown.current = held;
      }
      // Collapses toward the centre as it goes, rather than fading in place:
      // §15 calls the frontline a connection, and a connection comes apart.
      marker.position.x = (shown.current - 0.5) * CONTESTED_WIDTH * frame.frontline;
      marker.scale.set(1, Math.max(frame.frontline, 0.0001), Math.max(frame.frontline, 0.0001));
      marker.visible = showing;
      const material = marker.material;
      if (!Array.isArray(material) && 'opacity' in material) {
        material.opacity = 0.72 * frame.frontline;
      }
    }
  });

  // A sector is the one thing in the world a click does something to, and on a
  // desktop the cursor is how that is advertised. Written from an effect rather
  // than from the handlers so the canvas cannot be left holding a pointer
  // cursor if the sector unmounts — an LOD change or a reshuffle is enough.
  useEffect(() => {
    if (!hovered) {
      return;
    }
    gl.domElement.style.cursor = 'pointer';
    return () => {
      gl.domElement.style.cursor = 'auto';
    };
  }, [hovered, gl]);

  if (position === undefined || detail === 'CULLED') {
    return null;
  }

  // Faction accents mark the two staging areas. Design tokens §3: identity cues
  // and local highlights, never a fill across the UI — and §36.7 keeps the
  // faction identifiable without colour anyway.
  const leftAccent = battle === undefined ? '#3a4a55' : FACTION_ACCENT[battle.left];
  const rightAccent = battle === undefined ? '#3a4a55' : FACTION_ACCENT[battle.right];

  return (
    <group
      position={[position.x, position.y, position.z]}
      // Turned to face the camera that flies to it.
      //
      // The two districts sit either side of the island's local x axis, and the
      // sector poses approach along the radius from the Market Core. With the
      // island unrotated those two directions agreed only by accident: on most
      // sectors the camera looked *along* the axis between the districts, so
      // one army stood behind the other and the frontline ran across the view
      // instead of into it. §36.2 asks for both staging areas readable and the
      // frontline always understandable, which is a statement about this angle.
      //
      // Rotating the local x axis onto the tangent puts the two sides left and
      // right of the frame on every sector, with the line between them running
      // away from the camera — which is the arrangement every delivered sector
      // frame is drawn from.
      rotation={[0, -(Math.atan2(position.z, position.x) + Math.PI / 2), 0]}
    >
      {/* The neutral sector platform. No faction owns it (§38.3).
          A solid with depth rather than a disc: these are floating land masses
          (§38.1), and a flat circle reads as a dial on a control panel. */}
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onSelect(index);
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => {
          setHovered(false);
        }}
      >
        <cylinderGeometry
          args={[
            SECTOR_ISLAND_RADIUS,
            SECTOR_ISLAND_RADIUS * 0.8,
            SECTOR_PLATFORM_TOP * 2,
            SEGMENTS[detail],
          ]}
        />
        <meshStandardMaterial
          // Lifting under the pointer, a step below the focused tone: the world
          // should answer a hover before it answers a click (§37.3).
          color={isFocused ? '#22394a' : hovered ? '#1e3342' : '#1a2d3a'}
          metalness={0.22}
          roughness={0.8}
        />
      </mesh>

      {/* The underside, tapering into the void. What makes an island float. */}
      <mesh position={[0, -46, 0]}>
        <coneGeometry args={[92, 74, SEGMENTS[detail]]} />
        <meshStandardMaterial color="#070d12" metalness={0.3} roughness={0.95} />
      </mesh>

      {/* Broken rock around that taper. Kept at silhouette range too: it is
          part of the outline, and the outline is the whole of what a distant
          island is. */}
      <Crags seed={terrainSeed(index, 3)} />

      {detail !== 'SILHOUETTE' ? (
        <>
          {/* The road around the rim. A closed loop, because that is what says
              the plateau is one place rather than two platforms sharing a disc. */}
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 11.4, 0]}>
            <torusGeometry args={[104, 1.5, 5, SEGMENTS[detail]]} />
            <meshBasicMaterial color="#1d3a46" transparent opacity={0.5} />
          </mesh>

          {/* The contested ground between the two sides (§38.3). Neutral, and
              inset rather than raised — it is the ground the frontline moves
              across, and anything standing on it would be in the way of the one
              reading §36.15 asks a player to take in instantly. */}
          <mesh position={[0, 11.2, 0]}>
            <boxGeometry args={[CONTESTED_WIDTH, 0.6, 150]} />
            <meshBasicMaterial color="#0b1a22" transparent opacity={0.85} />
          </mesh>

          {/* Lit paving across it. Every delivered frame has a floor that
              carries light — it is what tells you the ground is built rather
              than poured, and with bloom on it is what puts light under the
              armies instead of only above them.

              Dim on purpose: kept under the bloom threshold so the floor reads
              as lit rather than as another source. What glows here is what
              stands on it. */}
          <InstancedField placements={CONTESTED_PAVING}>
            <boxGeometry key="paving" args={[1, 1, 1]} />
            <meshBasicMaterial key="paving-material" color="#2f6f86" transparent opacity={0.4} />
          </InstancedField>
        </>
      ) : null}

      {/* Two districts with that contested centre between them (§38.3). */}
      <District side={-1} accent={leftAccent} detail={detail} seed={terrainSeed(index, 1)} />
      <District side={1} accent={rightAccent} detail={detail} seed={terrainSeed(index, 2)} />

      {/* Each side's forward base (§38.5).
          Temporary by definition: deployed into whichever sector the round
          assigned this faction and retracted at reshuffle, which is why it
          stands on the staging platform rather than being part of the island.
          A permanent structure here would make a neutral sector look owned. */}
      {battle !== undefined && detail === 'FULL' ? (
        <>
          <ForwardBase
            side={-1}
            accent={leftAccent}
            innerRef={(node) => {
              bases.current[0] = node;
            }}
          />
          <ForwardBase
            side={1}
            accent={rightAccent}
            innerRef={(node) => {
              bases.current[1] = node;
            }}
          />
        </>
      ) : null}

      {/* A beacon per sector, so a live war is findable from the global view
          (§38.6). Dim while nothing is focused, brighter when it is. */}
      <pointLight
        position={[0, 54, 0]}
        color={isFocused ? '#9fd8ff' : '#4d7f9c'}
        intensity={isFocused ? 220 : 90}
        distance={340}
      />

      {/*
        The frontline marker. Its position is the normalized frontline from the
        realtime stream — §13 makes the battlefield a visualisation of
        authoritative momentum, never a source of it.
      */}
      {detail !== 'SILHOUETTE' && battle !== undefined ? (
        <mesh ref={frontline} position={[0, 22, 0]}>
          {/* Narrow and low enough to read across a district that now has a
              skyline behind it. The first pass was a 28-unit wall in flat
              white, and from the sector camera it hid the battlefield it was
              drawn to explain (§36.2). */}
          <boxGeometry args={[2.4, 19, 108]} />
          <meshBasicMaterial color="#cfe2ec" transparent opacity={0.72} />
        </mesh>
      ) : null}

      {/* The matchup, readable without opening a panel (§2.1).
          At every detail level, including silhouette. Geometry is what should
          drop away with distance; the label is what makes a distant world
          legible at all — §37.2's level one is *"the complete world"*, and the
          delivered global-view mockup carries exactly these labels. */}
      {battle !== undefined ? (
        <SectorLabel
          battle={battle}
          index={index}
          onFocus={() => {
            onSelect(index);
          }}
        />
      ) : null}
    </group>
  );
}

/**
 * One side's staging ground: a raised deck carrying a district.
 *
 * §38.9 asks for verticality — plateaus and raised structures, a place with a
 * skyline — and four boxes on a slab was a diagram of one. The structures are
 * generated (`districtBlocks`) rather than written out, because a city block is
 * more geometry than anyone places by hand and a *generated* one is still the
 * same city block on every client and in every round: the seed is the sector
 * and the side, and nothing else can reach it.
 *
 * §36.5 keeps faction colour an accent rather than a wash, so the mass is dark
 * and the accent is the deck edge and a lit band near the top of the tall
 * buildings — the thing that makes a skyline read at night.
 */
function District({
  side,
  accent,
  detail,
  seed,
}: {
  readonly side: -1 | 1;
  readonly accent: string;
  readonly detail: DetailLevel;
  readonly seed: number;
}): JSX.Element {
  const blocks = useMemo(
    () => districtBlocks(seed, DISTRICT_SHAPE, DISTRICT_DENSITY[detail]),
    [seed, detail],
  );

  // Grouped by how each structure is built, because each form is a different
  // geometry and an instanced draw carries one. Three groups of masses and
  // three of crowns, so a crown always matches the wall it rings — a square
  // band around an octagonal tower reads as a mistake at any distance.
  const built = useMemo(() => {
    const masses = new Map<BlockForm, Placement[]>();
    const crowns = new Map<BlockForm, Placement[]>();

    for (const block of blocks) {
      const rotation: readonly [number, number, number] = [
        0,
        // The cylinder forms put their first vertex on the axis, so a four-sided
        // one is a diamond until it is turned an eighth of a turn.
        block.rotation + (block.form === 'BLOCK' ? 0 : Math.PI / 4),
        0,
      ];

      (masses.get(block.form) ?? masses.set(block.form, []).get(block.form) ?? []).push({
        position: [block.x, DISTRICT_DECK + block.height / 2, block.z],
        scale: [block.width, block.height, block.depth],
        rotation,
      });

      if (block.lit) {
        (crowns.get(block.form) ?? crowns.set(block.form, []).get(block.form) ?? []).push({
          // A band just below the roof line, slightly proud of the wall, so it
          // reads as a lit ring on the building rather than as its roof.
          position: [block.x, DISTRICT_DECK + block.height - 3.4, block.z],
          scale: [block.width * 1.1, 2.6, block.depth * 1.1],
          rotation,
        });
      }
    }

    return { masses, crowns };
  }, [blocks]);

  return (
    <group position={[side * 62, 11, 0]}>
      {/* The apron, then the deck: two steps rather than one slab. Every
          delivered frame of a sector is a terraced citadel, and a single plate
          with towers on it reads as a model base. */}
      <mesh position={[0, 2, 0]}>
        <boxGeometry args={[56, 4, 104]} />
        <meshStandardMaterial color="#121f29" metalness={0.22} roughness={0.82} />
      </mesh>
      <mesh position={[0, 6, 0]}>
        <boxGeometry args={[48, 8, 96]} />
        <meshStandardMaterial color="#182733" metalness={0.24} roughness={0.7} />
      </mesh>

      {/* The lit edge, and the only place faction colour touches the ground.
          §36.5 keeps it an accent: a deck painted in it reads as a coloured
          plate rather than as territory a faction is standing on. */}
      {/* Sunk below the deck's own surface and a little wider than it, so what
          shows is a lit ledge running round the outside. Sitting it level with
          the deck instead covers the deck: from above the wider plate simply
          wins, and the whole district turns into a coloured rectangle. */}
      <mesh position={[0, 9.1, 0]}>
        <boxGeometry args={[49.8, 1, 97.8]} />
        <meshBasicMaterial color={accent} transparent opacity={0.5} />
      </mesh>

      {BLOCK_FORMS.map((form) => (
        <InstancedField key={`mass-${form}`} placements={built.masses.get(form) ?? []}>
          <BlockGeometry key={`mass-geometry-${form}`} form={form} />
          {/* Barely metallic, and that is not a compromise. A metal has no
              diffuse response at all — it is entirely what it reflects — so in
              a dark void raising metalness makes a surface *darker*, not
              richer. Pushing these to 0.45 once the environment existed put the
              district back to the near-black it started at, for the opposite
              reason.

              The probe gives them a sheen along their lit edges. What lights
              them is the key. */}
          <meshStandardMaterial
            key={`mass-material-${form}`}
            color="#2b4152"
            metalness={0.18}
            roughness={0.52}
            emissive="#0d2634"
            emissiveIntensity={0.34}
          />
        </InstancedField>
      ))}

      {BLOCK_FORMS.map((form) => (
        <InstancedField key={`crown-${form}`} placements={built.crowns.get(form) ?? []}>
          <BlockGeometry key={`crown-geometry-${form}`} form={form} />
          <meshBasicMaterial
            key={`crown-material-${form}`}
            color={accent}
            transparent
            opacity={0.85}
          />
        </InstancedField>
      ))}

      {/* The army's standards, along the edge it faces the fight from.
          Every delivered battlefield frame hangs these either side of a sector,
          and they are what tells you at a glance whose half you are looking at —
          the district's own colour is a lit ledge and a few crowns, which reads
          as lighting rather than as ownership.

          Only at full detail: they are identity, not information, and §37.6
          ties density to zoom. */}
      {detail === 'FULL'
        ? BANNER_POSTS.map((z) => (
            // Negated: inside this group the axes are the world's, so the edge
            // facing the contested centre is `-side`. At `+side` they stood
            // along the back of each district, with their own army between them
            // and the fight.
            <group key={z} position={[-side * 21, DISTRICT_DECK, z]}>
              <mesh position={[0, 26, 0]}>
                <cylinderGeometry args={[0.6, 0.6, 52, 5]} />
                <meshStandardMaterial color="#25333d" metalness={0.3} roughness={0.6} />
              </mesh>
              {/* The crossbar the cloth hangs from, across the frontline axis so
                  the banner faces the camera that approaches the sector. */}
              <mesh position={[0, 50, 0]}>
                <boxGeometry args={[0.9, 0.9, 15]} />
                <meshStandardMaterial color="#2d3d48" metalness={0.3} roughness={0.6} />
              </mesh>
              <mesh position={[0, 36, 0]}>
                <boxGeometry args={[0.4, 27, 13]} />
                <meshStandardMaterial
                  color={accent}
                  emissive={accent}
                  emissiveIntensity={0.5}
                  metalness={0.1}
                  roughness={0.8}
                />
              </mesh>
            </group>
          ))
        : null}
    </group>
  );
}

/**
 * The lit paving on the contested ground.
 *
 * A grid rather than a texture: there are no image assets in this app, and a
 * few dozen thin boxes through one instanced draw cost less than the texture
 * would have. Laid out here rather than generated because it is a grid — the
 * generator in `world-runtime` exists for things that should differ between
 * sectors, and a paved floor is the same floor everywhere.
 */
const CONTESTED_PAVING: readonly Placement[] = [
  // Along the frontline axis.
  ...[-30, -15, 15, 30].map((x) => ({
    position: [x, 11.55, 0] as const,
    scale: [0.7, 0.4, 148] as const,
    rotation: [0, 0, 0] as const,
  })),
  // Across it, every fifteen units.
  ...Array.from({ length: 11 }, (_, index) => ({
    position: [0, 11.55, -75 + index * 15] as const,
    scale: [CONTESTED_WIDTH - 4, 0.4, 0.7] as const,
    rotation: [0, 0, 0] as const,
  })),
];

/** Where the standards stand along a district's inner edge. */
const BANNER_POSTS: readonly number[] = [-30, 0, 30];

/** The three forms, in one place so nothing iterates a subset of them. */
const BLOCK_FORMS: readonly BlockForm[] = ['BLOCK', 'TAPER', 'TOWER'];

/**
 * The geometry one form is built from, at unit size.
 *
 * A block is a box. A taper is a four-sided frustum, which puts a diagonal in
 * the outline. A tower is an eight-sided prism, which puts a shoulder in it.
 * All three are a unit across and a unit tall, so one placement scales any of
 * them the same way.
 */
function BlockGeometry({ form }: { readonly form: BlockForm }): JSX.Element {
  switch (form) {
    case 'BLOCK':
      return <boxGeometry args={[1, 1, 1]} />;
    case 'TAPER':
      return <cylinderGeometry args={[0.34, 0.5, 1, 4]} />;
    case 'TOWER':
      return <cylinderGeometry args={[0.46, 0.5, 1, 8]} />;
  }
}

/**
 * The rock hanging under a plateau (§38.1).
 *
 * A cone alone reads as a spinning top. What says *floating island* is the
 * ragged edge: shards breaking away around the rim with the point at the
 * middle, which is the silhouette every one of the delivered world frames has.
 */
function Crags({ seed }: { readonly seed: number }): JSX.Element | null {
  const crags = useMemo(() => islandCrags(seed, 88, CRAGS_PER_ISLAND), [seed]);

  const placements = useMemo<readonly Placement[]>(
    () =>
      crags.map((crag) => ({
        position: [crag.x, -14 - crag.length / 2, crag.z],
        scale: [crag.radius, crag.length, crag.radius],
        // Turned over so the point hangs downward, then leaned outward from the
        // axis — which is the way rock breaks away from a mass.
        rotation: [Math.PI + crag.tiltX, 0, crag.tiltZ],
      })),
    [crags],
  );

  return (
    <InstancedField placements={placements}>
      <coneGeometry key="crag" args={[1, 1, 5]} />
      <meshStandardMaterial key="crag-material" color="#080f15" metalness={0.25} roughness={0.95} />
    </InstancedField>
  );
}

/**
 * Loose rock in the space between the islands (§38.1, §36.14).
 *
 * Stars are infinitely far away, so they never move against the camera: a world
 * with nothing between it and them reads as a model on a black table however
 * many points are behind it. These are what the camera passes, and what gives
 * the drag at the global view a sense of depth.
 *
 * The field turns as one, slowly. §36.14 asks for a world kept subtly alive
 * rather than one full of particles.
 */
function Debris(): JSX.Element {
  const field = useRef<Group>(null);

  const placements = useMemo<readonly Placement[]>(
    () =>
      debrisField(4_207, 620, 1_500, 72).map((rock) => ({
        position: [rock.x, rock.y, rock.z],
        scale: [rock.radius, rock.radius * 0.8, rock.radius],
        rotation: [rock.tilt, rock.tilt * 1.7, rock.tilt * 0.4],
      })),
    [],
  );

  useFrame((_, delta) => {
    if (field.current !== null) {
      field.current.rotation.y += delta * 0.004;
    }
  });

  return (
    <group ref={field}>
      <InstancedField placements={placements}>
        <icosahedronGeometry key="rock" args={[1, 0]} />
        <meshStandardMaterial
          key="rock-material"
          color="#0b131a"
          metalness={0.2}
          roughness={0.98}
        />
      </InstancedField>
    </group>
  );
}

/**
 * A forward operating base (§38.5).
 *
 * A mast on a footing, at the outer edge of its own staging ground. Deliberately
 * light: it is the one thing on the platform that is *not* permanent, and a
 * heavy fortress would read as the faction having settled there.
 */
function ForwardBase({
  side,
  accent,
  innerRef,
}: {
  readonly side: -1 | 1;
  readonly accent: string;
  /**
   * Handed back to the sector, which drives the deployment each frame (§15
   * steps 4 and 9). It is the sector that knows where the reshuffle stands, and
   * a base that read it for itself would be a second subscription to the same
   * clock.
   */
  readonly innerRef: (node: Group | null) => void;
}): JSX.Element {
  return (
    <group ref={innerRef} position={[side * 92, 11, 0]}>
      <mesh position={[0, 3, 0]}>
        <cylinderGeometry args={[10, 13, 6, 6]} />
        <meshStandardMaterial color="#111d26" metalness={0.22} roughness={0.6} />
      </mesh>
      <mesh position={[0, 20, 0]}>
        <cylinderGeometry args={[1.4, 1.4, 28, 6]} />
        <meshStandardMaterial color="#243745" metalness={0.24} roughness={0.45} />
      </mesh>
      <mesh position={[0, 35, 0]}>
        <octahedronGeometry args={[4, 0]} />
        <meshBasicMaterial color={accent} />
      </mesh>
    </group>
  );
}

/**
 * The void itself, before anything is in it (§38.1, §38.10).
 *
 * A flat clear colour is not a void, it is a background — nothing about it says
 * *deep*, because depth is read from a gradient and there was none. §38.10 asks
 * for a permanent dark cinematic atmosphere, and every delivered frame has a
 * horizon in it somewhere: light gathered low and away, dark overhead.
 *
 * A shader on the inside of a sphere rather than an image. There are no texture
 * assets in this app, and two mixes over the vertical axis are cheaper than
 * fetching one would be. It sits outside the starfield and outside the fog, so
 * nothing dims it and nothing is drawn behind it.
 */
function Void(): JSX.Element {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          top: { value: new Color(VOID_SKY.top) },
          horizon: { value: new Color(VOID_SKY.horizon) },
          bottom: { value: new Color(VOID_SKY.bottom) },
        },
        vertexShader: `
          varying float vHeight;
          void main() {
            // The unit height of this vertex on the sphere, which is all the
            // gradient needs and is stable however large the sphere is.
            vHeight = normalize(position).y;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 top;
          uniform vec3 horizon;
          uniform vec3 bottom;
          varying float vHeight;
          void main() {
            // Two mixes rather than one, so the light can gather at the horizon
            // instead of only at an end. A single mix from top to bottom is a
            // wash; a world needs somewhere the light comes from.
            vec3 sky = vHeight > 0.0
              ? mix(horizon, top, smoothstep(0.0, 0.55, vHeight))
              : mix(horizon, bottom, smoothstep(0.0, 0.4, -vHeight));
            gl_FragColor = vec4(sky, 1.0);
          }
        `,
      }),
    [],
  );

  useEffect(
    () => () => {
      material.dispose();
    },
    [material],
  );

  return (
    <mesh material={material} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[7_000, 24, 16]} />
    </mesh>
  );
}

/**
 * The void the world floats in (§38.1, §38.10).
 *
 * Points rather than a texture: there are no image assets in this app, and a
 * field of points is the one way to give the camera something to move against
 * without one. Without it, panning at the global view moves a world across a
 * flat black rectangle and reads as a picture being dragged rather than a place
 * being explored.
 *
 * Seeded from a fixed sequence, so the sky is the same sky on every load — a
 * random one would shift under the player between sessions.
 */
function Starfield(): JSX.Element {
  const positions = useMemo(() => {
    const count = 1_400;
    const points = new Float32Array(count * 3);
    // A small deterministic generator. The world's own PRNG lives in
    // `battle-math` and is keyed for evidence; borrowing it for scenery would
    // tie a visual detail to the audit path.
    let seed = 0x9e3779b9;
    const next = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0xffffffff;
    };
    for (let index = 0; index < count; index += 1) {
      // On a shell well outside the world boundary, so stars never intersect
      // geometry and never come closer as the camera pulls back.
      const theta = next() * Math.PI * 2;
      const phi = Math.acos(2 * next() - 1);
      const radius = 5_200 + next() * 2_400;
      points[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
      points[index * 3 + 1] = radius * Math.cos(phi) * 0.45;
      points[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    return points;
  }, []);

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      {/* `fog={false}`: the fog exists to fade the *world*, and a sky that
          faded with it would leave the far side of the scene empty. */}
      <pointsMaterial
        size={3.2}
        color="#8fa8bd"
        sizeAttenuation={false}
        transparent
        opacity={0.55}
        fog={false}
      />
    </points>
  );
}

/** Points a camera at a pose. The one place the two are joined. */
function aim(active: PerspectiveCamera, pose: CameraState['pose']): void {
  active.position.set(pose.position.x, pose.position.y, pose.position.z);
  active.lookAt(pose.target.x, pose.target.y, pose.target.z);
}

export function WorldScene(): JSX.Element {
  const camera = useSession((state) => state.camera);
  const battles = useSession((state) => state.battles);
  const quality = useSession((state) => state.quality);
  const focusSector = useSession((state) => state.focusSector);
  const tick = useSession((state) => state.tick);
  const three = useThree();

  // One clock drives both the camera reducer and the render. The reducer takes
  // an absolute timestamp, so a dropped frame advances further along the same
  // curve rather than leaving the camera short (§114.3).
  useFrame(() => {
    tick(nowUtc());
    aim(three.camera as PerspectiveCamera, camera.pose);
  });

  // The lens widens on a window taller than it is wide, so the ring still fits
  // across the frame (§37.4). Reads the renderer's own size rather than the
  // window's: the canvas is what the projection has to match, and on a split
  // view or an embedded pane those are not the same number.
  useEffect(() => {
    const active = three.camera as PerspectiveCamera;
    const aspect = three.size.width / Math.max(three.size.height, 1);
    const wanted =
      (2 *
        Math.atan(Math.tan((VIEWPORT_FIT.horizontalFov * Math.PI) / 360) / Math.max(aspect, 0.05)) *
        180) /
      Math.PI;
    const fov = Math.min(Math.max(wanted, VIEWPORT_FIT.minFov), VIEWPORT_FIT.maxFov);
    if (Math.abs(active.fov - fov) > 0.01) {
      active.fov = fov;
      active.updateProjectionMatrix();
    }
  }, [three.camera, three.size.width, three.size.height]);

  // And again whenever the pose changes, outside the loop.
  //
  // `Canvas` places the camera at the global anchor but cannot aim it, so until
  // a frame runs it looks along −Z at empty space above the world. Any page that
  // paints without the loop settling — a hidden tab, a screenshot, a throttled
  // background — showed a correctly positioned camera pointing at nothing, and
  // the world looked like it had failed to load. Aiming on change makes the
  // first painted frame the right one.
  useEffect(() => {
    aim(three.camera as PerspectiveCamera, camera.pose);
  }, [three.camera, camera.pose]);

  const zoom = currentZoom({ camera });

  const details = useMemo(
    () =>
      SECTOR_POSITIONS.map((sectorPosition, index) =>
        selectDetail({
          camera: camera.pose,
          sectorPosition,
          isFocused: battles[index]?.battleId === camera.focusedBattleId,
          thresholds: LOD_THRESHOLDS,
          tier: quality,
        }),
      ),
    [camera.pose, camera.focusedBattleId, battles, quality],
  );

  return (
    <>
      {/* §36.5: a dark neutral scene with restrained emissive accents. Faction
          colour is an accent, never a full-screen wash. */}
      <color attach="background" args={['#05080b']} />
      {/* Depth through atmosphere: the far edge of the world fades into the
          void rather than ending at a hard line (§38.10). Pulled in from 3000
          so the boundary is felt before it is reached. */}
      <fog attach="fog" args={['#05080b', 700, 2_600]} />
      <ambientLight intensity={0.34} />
      {/* The key. Raised with the tone mapping: a filmic curve rolls the
          midtones off, so a light calibrated against a linear output leaves the
          structures reading as silhouettes. */}
      <directionalLight position={[400, 900, 300]} intensity={1.7} />
      {/* A cold rim from the opposite side, so a silhouette separates from the
          background instead of dissolving into it. */}
      <directionalLight position={[-600, 300, -500]} intensity={0.7} color="#5c8fb8" />

      <WorldLighting />

      <Void />
      <Starfield />
      {/* Between the stars and the islands, so the void has a middle distance. */}
      <Debris />

      <WorldInput />

      <MarketCore />
      <Routes battles={battles} />

      {SECTOR_POSITIONS.map((_, index) => (
        <Sector
          key={index}
          index={index}
          battle={battles[index]}
          detail={details[index] ?? 'SILHOUETTE'}
          isFocused={battles[index]?.battleId === camera.focusedBattleId}
          onSelect={(selected) => {
            // A pan that happens to end over a sector is not a click on it.
            // Without this, dragging across the world flies the camera to
            // whatever the finger was over when it lifted.
            if (useSession.getState().dragMoved) {
              return;
            }
            // Tapping a sector node flies to it (§37.3, §37.4). At the sector
            // level a second tap descends to the battlefield.
            const now = nowUtc();
            if (zoom >= 2 && battles[selected]?.battleId === camera.focusedBattleId) {
              useSession.getState().enterBattlefield(selected, now);
            } else {
              focusSector(selected, now);
            }
          }}
        />
      ))}
    </>
  );
}
