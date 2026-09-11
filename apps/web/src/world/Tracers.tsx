import { useFrame } from '@react-three/fiber';
import { useContext, useMemo, useRef, type JSX } from 'react';
import { Color, Object3D, type InstancedMesh } from 'three';
import type { DetailLevel } from '@ponswars/world-runtime';
import { FormationContext } from './formation-context.js';

/**
 * Fire crossing the contested ground (§36.2, §38.3, §13).
 *
 * The armies stand and the frontline moves, and between them was nothing: a
 * lit floor with a white marker sliding across it. Every delivered battle frame
 * has the air between two lines full of it, and tracer fire is the cheapest
 * honest way to say a fight is happening — it is light, so it blooms, and it
 * moves, so a still frame of this world stops looking like a diagram.
 *
 * ## It says nothing the frontline does not
 *
 * Each round flashes at the front of the army that fired it, crosses to the
 * frontline marker, and flares there. That is the whole of the information in
 * it, and it is information the marker already carries — §13 makes the
 * battlefield a visualisation of authoritative momentum, so fire that reached
 * past the line, or fell short of it, would be a second and wrong answer to the
 * question the marker settles.
 *
 * Nothing is hit. There is no damage model here and there must not be one: the
 * outcome of a battle is §12's scoring, computed on the server from market
 * data, and a client that resolved anything on screen would be inventing a
 * fight beside the real one.
 *
 * ## Where it is drawn from
 *
 * Inside the army's formation group, so a round leaves from the front of the
 * army as it actually stands — the formation leans toward a push it is winning,
 * and fire that stayed where the army used to be would leave from inside it.
 * The line is a place on the ground rather than on the army, so it is taken
 * back out of the lean.
 *
 * ## Cost
 *
 * One `InstancedMesh` per side, so one draw call each however many rounds are
 * in the air. Positions are written straight into the instance matrices from a
 * frame loop — nothing re-renders, nothing allocates.
 */

/** How many rounds are in the air per side, by how close the camera is. */
const ROUNDS: Readonly<Record<DetailLevel, number>> = {
  FULL: 14,
  REDUCED: 5,
  SILHOUETTE: 0,
  CULLED: 0,
};

/** Where a side's fire starts: just in front of its first rank, which is at 40. */
const MUZZLE = 38;

/** Half the width of the ground fire crosses, matching the contested strip. */
const REACH = 38;

/** How far apart rounds sit along the line, inside the deck's own 96. */
const LANE_SPREAD = 78;

/**
 * How much of each round's cycle is a muzzle flash, and how much an impact.
 *
 * Fire that appeared from nowhere read as a stream from the deck edge rather
 * than as shots from soldiers, and fire that vanished at the line read as
 * rounds falling short. A flash at one end and a flare at the other are what
 * make it read as two armies reaching each other — the whole claim the tracers
 * are making.
 */
const MUZZLE_SHARE = 0.08;
const IMPACT_SHARE = 0.16;

/**
 * How long one round takes to cross, in seconds.
 *
 * §114.2's fastest timing class. Slower reads as a firework and faster is a
 * flicker nobody resolves; this is about the speed a tracer reads as a tracer.
 */
const FLIGHT = 0.42;

export function Tracers({
  accent,
  side,
  detail,
  frontline,
  seed,
}: {
  readonly accent: string;
  readonly side: -1 | 1;
  readonly detail: DetailLevel;
  /** Share of the field held by the LEFT faction, in `[0, 1]`. */
  readonly frontline: number;
  readonly seed: number;
}): JSX.Element | null {
  const count = ROUNDS[detail];
  const mesh = useRef<InstancedMesh | null>(null);
  const step = useMemo(() => new Object3D(), []);
  const motion = useContext(FormationContext);
  // Above the bloom threshold on purpose, so the pass that exists for §38.10
  // picks it up and the air over the field carries the glow.
  const glow = useMemo(() => new Color(accent).multiplyScalar(1.7), [accent]);

  /**
   * One lane and one phase per round, fixed for the life of the field.
   *
   * Deterministic from the sector and the side, so fire does not reshuffle
   * itself every time the component re-renders — and staggered, because rounds
   * leaving in lockstep read as a machine cycling rather than as a firefight.
   */
  const lanes = useMemo(
    () =>
      Array.from({ length: count }, (_, index) => ({
        z: (pseudo(seed + index * 5.3) - 0.5) * LANE_SPREAD,
        phase: pseudo(seed + index * 9.7),
        height: 15 + pseudo(seed + index * 2.1) * 9,
        // A little variation in speed, so two rounds in neighbouring lanes do
        // not travel as a pair.
        rate: 0.86 + pseudo(seed + index * 13.1) * 0.3,
      })),
    [count, seed],
  );

  useFrame((state) => {
    const field = mesh.current;
    if (field === null) {
      return;
    }

    // Local to the formation, which has already leaned by `lean`. The muzzle
    // rides with it for free; the line is a place on the ground, so the lean
    // comes back out of it — the same expression the marker is positioned by.
    const lean = motion?.lean.current ?? 0;
    const line = (frontline - 0.5) * (REACH * 2) - lean;
    const from = side * MUZZLE;
    const flight = 1 - MUZZLE_SHARE - IMPACT_SHARE;

    for (const [index, lane] of lanes.entries()) {
      const cycle = (state.clock.elapsedTime / FLIGHT + lane.phase) * lane.rate;
      const along = cycle - Math.floor(cycle);

      if (along < MUZZLE_SHARE) {
        // The flash at the front of the army, opening and closing where the
        // round leaves.
        const flash = Math.sin((along / MUZZLE_SHARE) * Math.PI);
        step.position.set(from, lane.height, lane.z);
        step.scale.setScalar(0.4 + flash * 2.2);
      } else if (along > 1 - IMPACT_SHARE) {
        // The flare at the line. Nothing is hit — §12 decides a battle on the
        // server from market data, and there is no damage model here to be
        // wrong.
        const burst = (along - (1 - IMPACT_SHARE)) / IMPACT_SHARE;
        step.position.set(line, lane.height, lane.z);
        step.scale.setScalar(0.6 + Math.sin(burst * Math.PI) * 3.4);
      } else {
        const travel = (along - MUZZLE_SHARE) / flight;
        step.position.set(from + (line - from) * travel, lane.height, lane.z);
        // Stretched along its own flight and thin across it: a round is read as
        // a streak, and a streak is a shape rather than a dot that moved.
        step.scale.set(7, 0.5, 0.5);
      }

      step.rotation.set(0, 0, 0);
      step.updateMatrix();
      field.setMatrixAt(index, step.matrix);
    }
    field.instanceMatrix.needsUpdate = true;
  });

  if (count === 0) {
    return null;
  }

  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, count]}
      // The bounds never change — fire stays over the contested strip — and
      // computing them from matrices written every frame would be work for an
      // answer that is always the same.
      frustumCulled={false}
    >
      <boxGeometry args={[1, 1, 1]} />
      {/* Basic rather than standard: this is light, not a surface. */}
      <meshBasicMaterial color={glow} toneMapped={false} />
    </instancedMesh>
  );
}

/** A stable value in [0, 1). The generator the terrain and the army use. */
function pseudo(value: number): number {
  const x = Math.sin(value * 127.1) * 43_758.545_312;
  return x - Math.floor(x);
}
