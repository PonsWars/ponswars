import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useContext, useEffect, useMemo, useRef, type JSX, type ReactNode } from 'react';
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
  type Group,
  type Object3D,
} from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { MomentumState } from '@ponswars/shared-types';
import type { DetailLevel } from '@ponswars/world-runtime';
import {
  CLIPS,
  leanFor,
  marching,
  MODELS,
  pickClip,
  postureFor,
  stanceFor,
  type Posture,
  type UnitKind,
} from './army-rules.js';
import { FormationContext, type FormationMotion } from './formation-context.js';
import { Tracers } from './Tracers.js';

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
 * a source of it. What an army does is decided in `army-rules.ts`, from the two
 * things the public stream already carries (§48.3) — a momentum state and a
 * normalized frontline — and nothing here computes a score, infers a winner, or
 * feeds anything back. It cannot: `ClientBattle` has no score field.
 *
 * The rule that keeps it honest is that an army never says anything the
 * frontline marker does not already say. It leans into a push it is winning by
 * a few units — never across the line, which stays the authoritative readout —
 * and the fire it throws lands on that line and nowhere else.
 *
 * ## What keeps it affordable
 *
 * A skinned mesh cannot be instanced the way the districts are: every unit
 * needs its own skeleton, so it is a real object with a real draw call. §37.6
 * ties density to zoom, which is what makes that survivable — a full army only
 * exists on a sector the camera is close to, and there are none at all on one
 * that is a silhouette.
 */

/**
 * How many of each stand on a side, by how close the camera is (§37.6, §82).
 *
 * `FULL` is the sector a player is looking at. `REDUCED` is a neighbour in
 * frame — enough units to read as an army, few enough that five of them
 * together are not the frame budget. A `SILHOUETTE` island is an outline, and
 * an outline has no soldiers in it.
 *
 * Drones only up close. They are the smallest thing on the field and the one
 * furthest from the ground, and at a neighbour's distance a drone is a speck
 * that costs a skeleton.
 */
const STRENGTH: Readonly<Record<DetailLevel, Readonly<Record<UnitKind, number>>>> = {
  FULL: { trooper: 7, mech: 2, walker: 1, drone: 2 },
  REDUCED: { trooper: 2, mech: 1, walker: 0, drone: 0 },
  SILHOUETTE: { trooper: 0, mech: 0, walker: 0, drone: 0 },
  CULLED: { trooper: 0, mech: 0, walker: 0, drone: 0 },
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
 * surface is at `y = 21`. Its buildings stand on the outer half of that deck
 * (`ARMY_GROUND` in `WorldScene.tsx`), so the army's ground runs from the inner
 * edge at 38 to 62 — and every rank has to stand inside it, or it stands in a
 * building.
 */
const DECK_Y = 21;
/**
 * Distance from the sector's centre line to the first rank.
 *
 * Just behind the standards at 41, so the banners fly in front of the army
 * rather than out of the middle of its front rank.
 */
const FRONT_RANK = 45;
/**
 * How much further back each rank behind it stands.
 *
 * The walker is the one heavy unit and stands in the second rank between the
 * two mechs rather than behind them: a third rank would put it at the district's
 * wall.
 */
const RANK_SPACING = 9;
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
const HEIGHT: Readonly<Record<UnitKind, number>> = { trooper: 14, mech: 25, walker: 31, drone: 10 };

/**
 * Where a drone flies: above the ranks rather than among them, and never still.
 *
 * High enough to clear a mech's head, low enough to read as part of the army it
 * is flying with rather than as traffic between sectors — which is what the
 * dropships on the routes are for.
 */
const DRONE_HOVER = { lift: 40, sway: 1.8 } as const;

/**
 * How long one clip takes to become another.
 *
 * §114.2's timing classes put a state change in the quarter-second band. Long
 * enough that the blend is visible as a movement, short enough that an army
 * reacting to a momentum swing still reads as reacting to it.
 */
const CROSSFADE_SECONDS = 0.28;

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

function pick(urls: readonly string[], seed: number): string {
  return urls[Math.floor(pseudo(seed) * urls.length) % urls.length] ?? urls[0] ?? '';
}

export function Army({
  side,
  accent,
  detail,
  seed,
  momentum,
  frontline,
  live,
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
  /**
   * Whether the round is being fought (§22).
   *
   * An army stands through the pick phase and fires only once the battle is
   * live — fire over a field nobody is fighting on would say a fight had
   * started before it had.
   */
  readonly live: boolean;
}): JSX.Element | null {
  // Indexed rather than looked up conditionally: the record covers every
  // member of the union, so a level added to `DetailLevel` fails to compile
  // here rather than silently fielding no army.
  const strength = STRENGTH[detail];

  const placements = useMemo(
    () => ({
      // Infantry at the front, armour behind it. That is the order every
      // delivered sector frame is drawn in, and it is also the readable one:
      // the big silhouettes stay visible over the small ones.
      trooper: rank(seed + 100, side, strength.trooper, 0, RANK_SPREAD),
      mech: rank(seed, side, strength.mech, 1, RANK_SPREAD * 0.6),
      walker: rank(seed + 200, side, strength.walker, 1, 24),
      drone: rank(seed + 300, side, strength.drone, 1, RANK_SPREAD * 0.7),
    }),
    [seed, side, strength],
  );

  const posture = postureFor(side, momentum, frontline);

  if (strength.trooper + strength.mech + strength.walker + strength.drone === 0) {
    return null;
  }

  const units = (kind: UnitKind, salt: number): JSX.Element[] =>
    placements[kind].map((placement, index) => (
      <Unit
        key={`${kind}-${String(index)}`}
        kind={kind}
        url={pick(MODELS[kind], seed + salt + index * 3)}
        placement={placement}
        accent={accent}
        posture={posture}
        height={HEIGHT[kind]}
        {...(kind === 'drone' ? { hover: DRONE_HOVER } : {})}
      />
    ));

  return (
    <Formation side={side} frontline={frontline}>
      {units('trooper', 0)}
      {units('mech', 1)}
      {units('walker', 2)}
      {units('drone', 4)}
      {/* The army's fire, inside the formation so it leaves from the front of
          the army as it actually stands rather than as it stood before it
          leaned. */}
      {live ? (
        <Tracers
          side={side}
          accent={accent}
          detail={detail}
          frontline={frontline}
          seed={seed + 900}
        />
      ) : null}
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
 * It only ever *follows* the authoritative number and never leads it. What it
 * has actually done — how far it has leaned and whether it is still moving — is
 * shared with everything standing in it through `FormationContext`.
 */
function Formation({
  side,
  frontline,
  children,
}: {
  readonly side: -1 | 1;
  readonly frontline: number;
  readonly children: ReactNode;
}): JSX.Element {
  const group = useRef<Group | null>(null);
  const motion = useMemo<FormationMotion>(
    () => ({ lean: { current: 0 }, moving: { current: false } }),
    [],
  );

  useFrame((_, delta) => {
    const node = group.current;
    if (node === null) {
      return;
    }
    const before = motion.lean.current;
    const after = before + (leanFor(side, frontline) - before) * Math.min(1, delta * 1.6);
    motion.lean.current = after;
    // A frame with no time in it has no speed, and dividing by it would say
    // the army moved infinitely fast. The previous answer stands.
    if (delta > 0) {
      motion.moving.current = marching(motion.moving.current, (after - before) / delta);
    }
    node.position.x = after;
  });

  return (
    <FormationContext.Provider value={motion}>
      <group ref={group}>{children}</group>
    </FormationContext.Provider>
  );
}

/**
 * One unit: a cloned rig, its own mixer, and this world's materials.
 *
 * `SkeletonUtils`' clone rather than `scene.clone()`, which is not optional for
 * a skinned mesh: an ordinary clone copies the mesh and keeps a reference to
 * the *original* skeleton, so every unit on the field animates as one body.
 */
function Unit({
  kind,
  url,
  placement,
  accent,
  posture,
  height,
  hover,
}: {
  readonly kind: UnitKind;
  readonly url: string;
  readonly placement: Placement;
  readonly accent: string;
  readonly posture: Posture;
  /** How tall this unit stands in world units. See `HEIGHT`. */
  readonly height: number;
  /** For something that flies: how high above the deck, and how much it bobs. */
  readonly hover?: { readonly lift: number; readonly sway: number };
}): JSX.Element {
  const gltf = useGLTF(url);
  const group = useRef<Group | null>(null);
  const motion = useContext(FormationContext);

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
      // The pack's own material, read only for its texture. `Mesh.material` is
      // typed loosely enough that reading it directly gives `any`; taking the
      // value and testing what it actually is keeps the type honest instead of
      // asserting one.
      const source: unknown = Array.isArray(node.material) ? node.material[0] : node.material;
      const atlas = source instanceof MeshStandardMaterial ? source.map : null;
      node.material = new MeshStandardMaterial({
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
      node.castShadow = false;
      node.receiveShadow = false;
    });
  }, [model, accent]);

  const mixer = useMemo(() => new AnimationMixer(model), [model]);
  const available = useMemo(() => gltf.animations.map((clip) => clip.name), [gltf.animations]);

  // The action in charge and the clip it plays, so the next one can fade in
  // over it rather than replace it. A rank that snapped from a walk to a
  // firing pose would read as a slideshow of poses; a quarter-second blend is
  // what makes a change of stance look like a decision (§114).
  const current = useRef<AnimationAction | null>(null);
  const playing = useRef<string | null>(null);

  // Where in each loop this unit starts. Without it a rank breathes in perfect
  // unison, which reads as one object copied rather than as several soldiers
  // standing near each other — most of all on a walk, where a dozen legs in
  // lockstep is unmistakable.
  const offset = pseudo(placement.z + placement.x);

  useEffect(() => {
    return () => {
      mixer.stopAllAction();
      current.current = null;
      playing.current = null;
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

  useFrame((state, delta) => {
    // Decided every frame rather than when a prop changes, because half of the
    // decision — whether the formation is still moving — changes without any
    // prop changing at all.
    const stance = stanceFor(posture, motion?.moving.current ?? false);
    const name = pickClip(available, CLIPS[kind][stance]);
    if (name !== undefined && name !== playing.current) {
      const clip = gltf.animations.find((candidate) => candidate.name === name);
      if (clip !== undefined) {
        const next = mixer.clipAction(clip);
        const previous = current.current;
        next.reset();
        next.time = offset * clip.duration;
        next.enabled = true;
        next.setEffectiveWeight(1);
        next.play();
        if (previous !== null && previous !== next) {
          // The old action keeps running through the blend and is stopped by
          // the mixer when its weight reaches zero.
          previous.crossFadeTo(next, CROSSFADE_SECONDS, false);
        }
        current.current = next;
        playing.current = name;
      }
    }
    mixer.update(delta);

    if (hover !== undefined && group.current !== null) {
      group.current.position.y =
        DECK_Y +
        hover.lift +
        Math.sin(state.clock.elapsedTime * 1.4 + offset * Math.PI * 2) * hover.sway;
    }
  });

  return (
    <group
      ref={group}
      position={[placement.x, DECK_Y + (hover?.lift ?? 0), placement.z]}
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
for (const urls of Object.values(MODELS)) {
  for (const url of urls) {
    useGLTF.preload(url);
  }
}
