import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type JSX } from 'react';
import {
  AnimationMixer,
  Box3,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  SkinnedMesh,
  Vector3,
  type AnimationAction,
  type AnimationClip,
  type Group,
  type Object3D,
} from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { MomentumState } from '@ponswars/shared-types';
import type { DetailLevel } from '@ponswars/world-runtime';

/**
 * The armies standing on a sector (§38.3, §38.5, §36.2).
 *
 * Everything else in this world is arithmetic — boxes, cylinders, instanced
 * fields, a shader for the void. These are the one thing that could not be:
 * a shape that reads as a machine is a modelled, rigged asset, and no amount of
 * primitives produces one. They are CC0 models, listed with their sources in
 * `docs/operations/third-party-models.md`.
 *
 * ## They visualise the battle; they never decide it
 *
 * §13 makes the battlefield a visualisation of authoritative momentum and never
 * a source of it. So an army *reads* momentum and the frontline — the two
 * things the public stream already carries (§48.3) — and turns them into a
 * posture: holding, advancing, or assaulting. Nothing here computes a score,
 * infers a winner, or feeds anything back. It cannot: `ClientBattle` has no
 * score field, and §24 keeps the exact figure off the wire for the whole live
 * battle.
 *
 * The rule that keeps it honest is that an army never says anything the
 * frontline marker does not already say. It leans into a push it is winning by
 * a few units — never across the line, which stays the authoritative readout.
 *
 * ## What keeps it affordable
 *
 * A skinned mesh cannot be instanced the way the districts are: every unit
 * needs its own skeleton, so it is a real object with a real draw call. §37.6
 * ties density to zoom, which is what makes that survivable — a full army only
 * exists on a sector the camera is close to, and there are none at all on one
 * that is a silhouette.
 */

/** Where the models are served from. Built by `tools/build-models.mjs`. */
const MODELS = {
  mech: ['/models/units/mech-a.glb', '/models/units/mech-c.glb'],
  trooper: [
    '/models/units/trooper-a.glb',
    '/models/units/trooper-b.glb',
    '/models/units/trooper-c.glb',
  ],
  walker: ['/models/units/walker-large.glb'],
} as const;

/**
 * How many of each stand on a side, by how close the camera is (§37.6, §82).
 *
 * `FULL` is the sector a player is looking at. `REDUCED` is a neighbour in
 * frame — enough units to read as an army, few enough that five of them
 * together are not the frame budget. A `SILHOUETTE` island is an outline, and
 * an outline has no soldiers in it.
 */
interface Strength {
  readonly mechs: number;
  readonly troopers: number;
  readonly walkers: number;
}

const STRENGTH: Readonly<Record<DetailLevel, Strength>> = {
  FULL: { mechs: 2, troopers: 7, walkers: 1 },
  REDUCED: { mechs: 1, troopers: 2, walkers: 0 },
  SILHOUETTE: { mechs: 0, troopers: 0, walkers: 0 },
  CULLED: { mechs: 0, troopers: 0, walkers: 0 },
};

/**
 * The ground an army stands on.
 *
 * Its own district's deck, along the edge facing the fight — never the
 * contested strip between them. That strip is deliberately kept clear: it is
 * the ground the frontline marker moves across, and §36.15 asks a player to
 * read who holds what instantly, which a crowd standing over the line would
 * undo.
 *
 * The district sits at `x = side * 62` with a deck 48 wide and 96 deep whose
 * surface is at `y = 21`. So a side's ranks run from its inner edge —
 * `side * 40` — backward into its own ground.
 */
const DECK_Y = 21;
/** Distance from the sector's centre line to the first rank. */
const FRONT_RANK = 40;
/** How much further back each rank behind it stands. */
const RANK_SPACING = 14;
/** How wide a rank spreads along the deck. Inside the deck's 96. */
const RANK_SPREAD = 84;

/**
 * How tall each kind of unit stands, in world units.
 *
 * Read against the things around them: the deck is 48 across, its towers reach
 * about 100, and the frontline marker is 19 high. Deliberately large — the
 * sector camera stands well back so that both staging areas and the line
 * between them are in one frame (§36.2), and at that distance a
 * correctly-proportioned soldier is four pixels of debris on a plate. These are
 * the numbers that decide whether an army reads as an army, so they are stated
 * here rather than buried in a scale factor per model.
 */
const HEIGHT = { trooper: 11, mech: 22, walker: 27 } as const;

interface Placement {
  readonly x: number;
  readonly z: number;
  readonly turn: number;
  readonly scale: number;
}

/**
 * Where one rank stands.
 *
 * Deterministic from the sector and the side, so a unit does not jump when the
 * detail level changes and the component re-renders with a different count —
 * the first six of a rank are the same six positions whether the rank is six or
 * three.
 */
function rank(seed: number, side: -1 | 1, count: number, row: number, spread: number): Placement[] {
  const out: Placement[] = [];
  for (let index = 0; index < count; index += 1) {
    const noise = pseudo(seed + index * 7.13 + row * 31.7);
    const along = count === 1 ? 0.5 : index / (count - 1);
    out.push({
      // Positioned in world terms rather than inside a mirrored group. A group
      // scaled by `[side, 1, 1]` is the tidier expression and the wrong one: a
      // negative scale flips handedness, which turns a skinned model inside out
      // and lights it from the wrong face.
      x: side * (FRONT_RANK + row * RANK_SPACING + noise * 3),
      z: (along - 0.5) * spread + (pseudo(seed + index * 3.9) - 0.5) * 6,
      // Facing the centre, give or take. A rank turned to exactly the same
      // angle reads as a row of statues; a few degrees of variation reads as
      // soldiers who happen to be standing together.
      turn: -side * (Math.PI / 2) + (pseudo(seed + index * 11.3) - 0.5) * 0.5,
      scale: 0.94 + noise * 0.12,
    });
  }
  return out;
}

/** A stable value in [0, 1) from a number. Same generator the terrain uses. */
function pseudo(value: number): number {
  const x = Math.sin(value * 127.1) * 43_758.545_312;
  return x - Math.floor(x);
}

/**
 * What an army is doing, from the two things the public stream carries.
 *
 * §48.3 sends a momentum state and a normalized frontline and deliberately no
 * score, so these three postures are everything an army can honestly show. The
 * mapping is written to be read rather than tuned:
 *
 * - `CONTESTED` is a fight neither side is winning. Both assault.
 * - Any other state has a side with the advantage — the frontline says which —
 *   and that side advances while the other holds under fire.
 *
 * `COMEBACK` needs no special case. §13 describes it as a reversal, and the
 * frontline is already where the reversal has got to; the side it now favours
 * is the side advancing, which is exactly what a comeback looks like.
 */
export type Posture = 'HOLDING' | 'ADVANCING' | 'ASSAULTING';

export function postureFor(side: -1 | 1, momentum: MomentumState, frontline: number): Posture {
  if (momentum === 'CONTESTED') {
    return 'ASSAULTING';
  }
  // `frontline` is the share held by the LEFT faction, which is `side: -1`.
  const advantage = side === -1 ? frontline - 0.5 : 0.5 - frontline;
  return advantage > 0 ? 'ADVANCING' : 'HOLDING';
}

/**
 * The clip each kind of unit plays for a posture.
 *
 * Only clips `tools/build-models.mjs` keeps are named here — the build drops
 * the rest of the rig's vocabulary, so a name that is not in `KEEP_CLIPS`
 * would silently fall back to whatever the file happens to list first.
 */
const CLIPS: Readonly<Record<Posture, { trooper: string; mech: string }>> = {
  HOLDING: { trooper: 'Idle_Gun', mech: 'Idle' },
  ADVANCING: { trooper: 'Walk_Gun', mech: 'Walk' },
  ASSAULTING: { trooper: 'Run_Gun_Shoot', mech: 'Shoot_Big' },
};

/**
 * How far an army leans into a push, in world units.
 *
 * Small on purpose. The frontline marker is the readout; this is body language,
 * and an army that walked as far as the line would be a second, competing
 * answer to the question §36.15 says a player must be able to settle instantly.
 */
const LEAN = 9;

/**
 * How long one posture takes to become another.
 *
 * §114.2's timing classes put a state change in the quarter-second band. Long
 * enough that the blend is visible as a movement, short enough that an army
 * reacting to a momentum swing still reads as reacting to it.
 */
const CROSSFADE_SECONDS = 0.28;

export function Army({
  side,
  accent,
  detail,
  seed,
  momentum,
  frontline,
}: {
  readonly side: -1 | 1;
  /** The faction's colour. Carried as a rim, never as a coat of paint (§36.5). */
  readonly accent: string;
  readonly detail: DetailLevel;
  readonly seed: number;
  /** §48.3's qualitative state. Never a score — there is none to have. */
  readonly momentum: MomentumState;
  /** Share of the field held by the LEFT faction, in `[0, 1]`. */
  readonly frontline: number;
}): JSX.Element | null {
  // Indexed rather than looked up conditionally: the record covers every
  // member of the union, so a level added to `DetailLevel` fails to compile
  // here rather than silently fielding no army.
  const strength: Strength = STRENGTH[detail];

  const placements = useMemo(
    () => ({
      // Infantry at the front, armour behind it. That is the order every
      // delivered sector frame is drawn in, and it is also the readable one:
      // the big silhouettes stay visible over the small ones.
      troopers: rank(seed + 100, side, strength.troopers, 0, RANK_SPREAD),
      mechs: rank(seed, side, strength.mechs, 1, RANK_SPREAD * 0.6),
      walkers: rank(seed + 200, side, strength.walkers, 2, 24),
    }),
    [seed, side, strength],
  );

  const posture = postureFor(side, momentum, frontline);

  if (strength.mechs + strength.troopers + strength.walkers === 0) {
    return null;
  }

  return (
    <Formation side={side} frontline={frontline}>
      {placements.mechs.map((placement, index) => (
        <Unit
          key={`mech-${String(index)}`}
          url={pick(MODELS.mech, seed + index)}
          placement={placement}
          accent={accent}
          clip={CLIPS[posture].mech}
          height={HEIGHT.mech}
        />
      ))}
      {placements.troopers.map((placement, index) => (
        <Unit
          key={`trooper-${String(index)}`}
          url={pick(MODELS.trooper, seed + index * 3)}
          placement={placement}
          accent={accent}
          clip={CLIPS[posture].trooper}
          height={HEIGHT.trooper}
        />
      ))}
      {placements.walkers.map((placement, index) => (
        <Unit
          key={`walker-${String(index)}`}
          url={MODELS.walker[0]}
          placement={placement}
          accent={accent}
          clip={CLIPS[posture].mech}
          height={HEIGHT.walker}
        />
      ))}
    </Formation>
  );
}

/**
 * The whole army, leaning toward the line it is winning or losing.
 *
 * Eased in a frame loop rather than set from a prop, for the same reason the
 * frontline marker is: the value arrives about once a second on the realtime
 * stream, and a formation that teleported on each one would read as a readout
 * refreshing rather than as ground being taken (§13.4, §36.14).
 *
 * It only ever *follows* the authoritative number and never leads it.
 */
function Formation({
  side,
  frontline,
  children,
}: {
  readonly side: -1 | 1;
  readonly frontline: number;
  readonly children: React.ReactNode;
}): JSX.Element {
  const group = useRef<Group | null>(null);
  const shown = useRef(0);

  useFrame((_, delta) => {
    const node = group.current;
    if (node === null) {
      return;
    }
    // Positive when this side is winning ground, so a winning army moves
    // toward the centre and a losing one gives way.
    const advantage = side === -1 ? frontline - 0.5 : 0.5 - frontline;
    const target = -side * advantage * 2 * LEAN;
    shown.current += (target - shown.current) * Math.min(1, delta * 1.6);
    node.position.x = shown.current;
  });

  return <group ref={group}>{children}</group>;
}

function pick(urls: readonly string[], seed: number): string {
  return urls[Math.floor(pseudo(seed) * urls.length) % urls.length] ?? urls[0] ?? '';
}

/**
 * One unit: a cloned rig, its own mixer, and this world's materials.
 *
 * `SkeletonUtils`' clone rather than `scene.clone()`, which is not optional for
 * a skinned mesh: an ordinary clone copies the mesh and keeps a reference to
 * the *original* skeleton, so every unit on the field animates as one body.
 */
function Unit({
  url,
  placement,
  accent,
  clip,
  height,
}: {
  readonly url: string;
  readonly placement: Placement;
  readonly accent: string;
  readonly clip: string;
  /** How tall this unit stands in world units. See `HEIGHT`. */
  readonly height: number;
}): JSX.Element {
  const gltf = useGLTF(url);
  const group = useRef<Group | null>(null);

  const model = useMemo(() => cloneSkinned(gltf.scene), [gltf.scene]);

  /**
   * Scaled to a stated height rather than by a multiplier.
   *
   * A pack's own units are its own business — these arrive about a fifth of a
   * world unit tall, which is a number with no meaning outside the file it came
   * from. Measuring the model and fitting it to a height this world chose means
   * `HEIGHT.mech` is a design decision that reads as one, and swapping a model
   * for a differently-scaled one changes nothing.
   */
  const fit = useMemo(() => {
    // Measured with the skeleton applied, not from the raw attributes.
    //
    // A glTF rig keeps its vertices in whatever space the exporter used and
    // relies on the bind matrices to place them: these arrive with a geometry
    // three hundred units across that renders about a fifth of one unit tall.
    // `Box3.setFromObject` reads the attributes and knows nothing about
    // skinning, so it measures the first number — which is how a first attempt
    // scaled an army to invisibility.
    //
    // `SkinnedMesh.computeBoundingBox` applies the bone transforms, which is
    // the size a viewer actually sees.
    model.updateWorldMatrix(true, true);
    const bounds = new Box3();
    model.traverse((node: Object3D) => {
      if (node instanceof SkinnedMesh) {
        node.computeBoundingBox();
        // Read back through `unknown` and tested, like the material is: three's
        // types are loose enough here that reading straight off the node hands
        // back `any`, and an `any` that turns out to be undefined is a silent
        // scale of one.
        const box: unknown = node.boundingBox;
        if (box instanceof Box3) {
          bounds.union(box);
        }
        return;
      }
      if (node instanceof Mesh) {
        const geometry: unknown = node.geometry;
        if (geometry instanceof BufferGeometry) {
          geometry.computeBoundingBox();
          const box: unknown = geometry.boundingBox;
          if (box instanceof Box3) {
            bounds.union(box);
          }
        }
      }
    });

    const size = bounds.isEmpty() ? new Vector3() : bounds.getSize(new Vector3());
    return size.y > 0.0001 ? height / size.y : 1;
  }, [model, height]);

  // Retextured to this world rather than shipped as it came. The packs are lit
  // and coloured for a bright stylised game; §36 fixes the direction here as
  // dark, matte and restrained, and a unit in its own palette would read as
  // something dropped in from another product — which is exactly what it is.
  //
  // The atlas stays as the base map. It carries the panel lines and the
  // detail that makes the silhouette legible; what changes is the tone it is
  // multiplied by, the response to light, and a faint emissive in the faction's
  // colour so a side is identifiable at a glance (§36.5, §36.7).
  useEffect(() => {
    const tint = new Color(accent);
    model.traverse((node: Object3D) => {
      // `SkinnedMesh` extends `Mesh`, so one check covers both — and checking
      // for the union instead widens `material` to `any`, which is how a
      // texture would silently go missing.
      if (!(node instanceof Mesh)) {
        return;
      }
      // The pack's own material, read only for its texture. `node.material` is
      // typed as a union that includes arrays, and a multi-material export
      // would take the first — these have one each.
      // `Mesh.material` is typed loosely enough that reading it directly gives
      // `any`; taking the value and testing what it actually is keeps the type
      // honest instead of asserting one.
      const source: unknown = Array.isArray(node.material) ? node.material[0] : node.material;
      const atlas = source instanceof MeshStandardMaterial ? source.map : null;
      const material = new MeshStandardMaterial({
        map: atlas,
        color: new Color('#8ea2ae'),
        metalness: 0.3,
        roughness: 0.62,
        emissive: tint,
        // Barely there. Enough that a side reads at a distance, far short of
        // the glow that would put a unit above the bloom threshold and turn an
        // army into a row of lamps.
        emissiveIntensity: 0.14,
      });
      node.material = material;
      node.castShadow = false;
      node.receiveShadow = false;
    });
  }, [model, accent]);

  const mixer = useMemo(() => new AnimationMixer(model), [model]);

  // The action currently in charge, so the next one can fade in over it rather
  // than replacing it. A rank that snapped from a walk to a firing pose the
  // instant momentum changed would read as a slideshow of poses; §114 asks for
  // motion with intent, and a quarter-second blend is what makes a posture
  // change look like a decision.
  const current = useRef<AnimationAction | null>(null);

  useEffect(() => {
    const found: AnimationClip | undefined =
      gltf.animations.find((animation) => animation.name === clip) ?? gltf.animations[0];
    if (found === undefined) {
      return;
    }

    const next = mixer.clipAction(found);
    const previous = current.current;
    if (previous === next) {
      return;
    }

    next.reset();
    // Started at a point of its own. Without it a rank breathes in perfect
    // unison, which reads as one object copied rather than as several soldiers
    // standing near each other — and it matters most on a walk, where a dozen
    // legs in lockstep is unmistakable.
    next.time = pseudo(placement.z + placement.x) * found.duration;
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();

    if (previous !== null) {
      // The old action keeps running through the blend and is stopped by the
      // mixer when its weight reaches zero.
      previous.crossFadeTo(next, CROSSFADE_SECONDS, false);
    }
    current.current = next;
  }, [mixer, gltf.animations, clip, placement.x, placement.z]);

  useEffect(() => {
    return () => {
      mixer.stopAllAction();
      current.current = null;
    };
  }, [mixer]);

  /**
   * Everything this clone owns, released when it goes.
   *
   * This is not housekeeping. A unit is unmounted and remounted every time its
   * sector changes detail level, which happens continuously as the camera
   * moves — and each clone owns a `Skeleton`, which owns a bone texture on the
   * GPU. Without this the world lost its WebGL context outright after a minute
   * of flying around: `THREE.WebGLRenderer: Context Lost`, a black canvas, and
   * no error anywhere to explain it.
   *
   * Only what the clone owns. `SkeletonUtils.clone` shares geometry with the
   * original — every unit of a kind draws the same mesh — so disposing that
   * would take the geometry out from under every other copy on the field.
   */
  useEffect(() => {
    return () => {
      mixer.uncacheRoot(model);
      model.traverse((node: Object3D) => {
        if (node instanceof SkinnedMesh) {
          node.skeleton.dispose();
        }
        if (node instanceof Mesh) {
          const material: unknown = node.material;
          if (material instanceof MeshStandardMaterial) {
            material.dispose();
          }
        }
      });
    };
  }, [mixer, model]);

  useFrame((_, delta) => {
    mixer.update(delta);
  });

  return (
    <group
      ref={group}
      position={[placement.x, DECK_Y, placement.z]}
      rotation={[0, placement.turn, 0]}
      scale={placement.scale * fit}
    >
      <primitive object={model} />
    </group>
  );
}

// Fetched with the world chunk rather than when a sector first needs one. A
// unit that appears three seconds after the island it stands on is worse than
// one that arrives with it.
for (const url of [...MODELS.mech, ...MODELS.trooper, ...MODELS.walker]) {
  useGLTF.preload(url);
}
