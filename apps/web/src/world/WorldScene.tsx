import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import {
  selectDetail,
  type CameraState,
  type DetailLevel,
  type LodThresholds,
} from '@ponswars/world-runtime';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type JSX } from 'react';
import type { Group, PerspectiveCamera } from 'three';
import { currentZoom, nowUtc, useSession, type ClientBattle } from '../state/session.js';
import { MARKET_CORE, SECTOR_POSITIONS } from './layout.js';
import { SectorLabel } from './SectorLabel.js';
import { WorldInput } from './WorldInput.js';

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

/**
 * LOD distances.
 *
 * `OPEN` production tuning (§59.4). Sized so the *default* global view — the
 * pose `RESET VIEW` returns to, about 1 200 units out — renders the world in
 * full. The first values were set when a sector was a disc and two boxes, and
 * put every sector at silhouette range from the one camera position a player
 * starts at: the world degraded before anyone had seen it undegraded.
 *
 * Five platforms with a handful of boxes each is not a budget worth defending;
 * §82.2's tiers exist for the cinematic and battlefield levels where far more is
 * on screen.
 */
const LOD_THRESHOLDS: LodThresholds = { full: 1_500, reduced: 2_400, silhouette: 4_000 };

/** How many segments a sector platform gets at each detail level (§82.2). */
const SEGMENTS: Readonly<Record<DetailLevel, number>> = {
  FULL: 48,
  REDUCED: 20,
  SILHOUETTE: 8,
  CULLED: 3,
};

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

function MarketCore(): JSX.Element {
  const core = useRef<Group>(null);

  // §38.10: a permanent dark cinematic atmosphere whose lighting shifts by
  // phase, and §36.14 keeps the world subtly alive through slow rotation rather
  // than particles. A steady drift, not a spin.
  useFrame((_, delta) => {
    if (core.current !== null) {
      core.current.rotation.y += delta * 0.06;
    }
  });

  return (
    <group ref={core} position={[MARKET_CORE.x, MARKET_CORE.y, MARKET_CORE.z]}>
      {/* The plateau the core stands on: §38.9 asks for verticality through
          plateaus and raised structures rather than a flat disc. */}
      <mesh position={[0, -14, 0]}>
        <cylinderGeometry args={[92, 118, 28, 6]} />
        <meshStandardMaterial color="#0d161d" metalness={0.5} roughness={0.8} />
      </mesh>

      {/* A spire cluster, tallest at the centre. The Market Core is the
          orientation anchor (§38.2), and a landmark has to be tall enough to
          find from anywhere in the ring — a sphere reads as an object, a
          skyline reads as a place. */}
      {CORE_SPIRES.map((spire, index) => (
        <mesh key={index} position={[spire.x, spire.height / 2, spire.z]}>
          <boxGeometry args={[spire.width, spire.height, spire.width]} />
          <meshStandardMaterial
            color="#16222c"
            metalness={0.85}
            roughness={0.3}
            emissive="#0e3040"
            emissiveIntensity={0.35}
          />
        </mesh>
      ))}

      {/* The beacon at the summit. One bright point the eye returns to. */}
      <mesh position={[0, 208, 0]}>
        <sphereGeometry args={[5, 12, 12]} />
        <meshBasicMaterial color="#7fe3c4" />
      </mesh>
      <pointLight position={[0, 200, 0]} color="#5fd3b4" intensity={340} distance={620} />

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

interface SectorProps {
  readonly index: number;
  readonly battle: ClientBattle | undefined;
  readonly detail: DetailLevel;
  readonly isFocused: boolean;
  readonly onSelect: (index: number) => void;
}

function Sector({ index, battle, detail, isFocused, onSelect }: SectorProps): JSX.Element | null {
  const position = SECTOR_POSITIONS[index];
  if (position === undefined || detail === 'CULLED') {
    return null;
  }

  // Faction accents mark the two staging areas. Design tokens §3: identity cues
  // and local highlights, never a fill across the UI — and §36.7 keeps the
  // faction identifiable without colour anyway.
  const leftAccent = battle === undefined ? '#3a4a55' : FACTION_ACCENT[battle.left];
  const rightAccent = battle === undefined ? '#3a4a55' : FACTION_ACCENT[battle.right];

  return (
    <group position={[position.x, position.y, position.z]}>
      {/* The neutral sector platform. No faction owns it (§38.3).
          A solid with depth rather than a disc: these are floating land masses
          (§38.1), and a flat circle reads as a dial on a control panel. */}
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onSelect(index);
        }}
      >
        <cylinderGeometry args={[120, 96, 22, SEGMENTS[detail]]} />
        <meshStandardMaterial
          color={isFocused ? '#16242e' : '#0f1a22'}
          metalness={0.6}
          roughness={0.7}
        />
      </mesh>

      {/* The underside, tapering into the void. What makes an island float. */}
      {detail !== 'SILHOUETTE' ? (
        <mesh position={[0, -46, 0]}>
          <coneGeometry args={[92, 74, SEGMENTS[detail]]} />
          <meshStandardMaterial color="#070d12" metalness={0.3} roughness={0.95} />
        </mesh>
      ) : null}

      {/* Two staging areas with a contested centre between them (§38.3). */}
      <StagingArea side={-1} accent={leftAccent} detail={detail} />
      <StagingArea side={1} accent={rightAccent} detail={detail} />

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
        <mesh position={[(battle.frontline - 0.5) * 124, 22, 0]}>
          <boxGeometry args={[3, 28, 104]} />
          <meshBasicMaterial color="#d7e6ee" transparent opacity={0.8} />
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
 * One side's staging ground: a raised platform with a few structures on it.
 *
 * §38.9 asks for verticality, and §36.5 keeps faction colour an accent rather
 * than a wash — so the buildings are dark and the accent is the platform edge
 * and the emissive glow, not the whole mass.
 */
function StagingArea({
  side,
  accent,
  detail,
}: {
  readonly side: -1 | 1;
  readonly accent: string;
  readonly detail: DetailLevel;
}): JSX.Element {
  return (
    <group position={[side * 62, 11, 0]}>
      <mesh position={[0, 5, 0]}>
        <boxGeometry args={[46, 10, 96]} />
        <meshStandardMaterial
          color="#111d26"
          metalness={0.5}
          roughness={0.6}
          emissive={accent}
          emissiveIntensity={0.22}
        />
      </mesh>
      {detail !== 'SILHOUETTE'
        ? STAGING_BLOCKS.map((block, index) => (
            <mesh key={index} position={[side * block.x, 10 + block.height / 2, block.z]}>
              <boxGeometry args={[block.width, block.height, block.width]} />
              <meshStandardMaterial
                color="#16242e"
                metalness={0.7}
                roughness={0.4}
                emissive={accent}
                emissiveIntensity={0.3}
              />
            </mesh>
          ))
        : null}
    </group>
  );
}

/** Structures on a staging platform. Fixed, so a sector is recognisable. */
const STAGING_BLOCKS: readonly { x: number; z: number; width: number; height: number }[] = [
  { x: -8, z: -30, width: 12, height: 34 },
  { x: 9, z: -8, width: 9, height: 22 },
  { x: -6, z: 18, width: 11, height: 28 },
  { x: 10, z: 36, width: 8, height: 16 },
];

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
      <ambientLight intensity={0.22} />
      <directionalLight position={[400, 900, 300]} intensity={1.05} />
      {/* A cold rim from the opposite side, so a silhouette separates from the
          background instead of dissolving into it. */}
      <directionalLight position={[-600, 300, -500]} intensity={0.45} color="#5c8fb8" />

      <Starfield />

      <WorldInput />

      <MarketCore />

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
