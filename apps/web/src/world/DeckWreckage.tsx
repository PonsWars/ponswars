import type { DetailLevel } from '@ponswars/world-runtime';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, type JSX } from 'react';
import { MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { useSession } from '../state/session.js';
import { InstancedField } from './InstancedField.js';
import { sectorWreckage } from './wreckage.js';

/**
 * The broken market infrastructure on a sector's deck (§36.4).
 *
 * `wreckage.ts` decides what is broken and where; this draws it in two calls —
 * the wrecks, and whatever on them still has power.
 *
 * The lit parts flicker together, like a circuit that is failing rather than a
 * sign that is animated. Irregular on purpose: a steady pulse reads as design,
 * and this is meant to read as damage. Under reduced motion (§83.3) they hold
 * steady at their dim level.
 *
 * Neutral (§38.3): the hull is the world's dark metal and the light is its
 * warm amber, never a faction's colour.
 */

/** The broken board's metal, darker than the deck it lies on. */
const HULL = '#161b20';

/** What still has power: the world's warm amber, under the bloom threshold. */
const LIVE = '#c9913a';
const OPACITY = 0.7;

/** Scenery goes first as detail drops (§37.6, §82.1). */
const DRAWS: Readonly<Record<DetailLevel, boolean>> = {
  FULL: true,
  REDUCED: true,
  SILHOUETTE: false,
  CULLED: false,
};

export function DeckWreckage({
  index,
  detail,
}: {
  readonly index: number;
  readonly detail: DetailLevel;
}): JSX.Element | null {
  const reducedMotion = useSession((state) => state.reducedMotion);
  const draws = DRAWS[detail];

  const { hull, lit } = useMemo(() => {
    const wrecks = sectorWreckage(index);
    return {
      hull: wrecks.flatMap((wreck) => wreck.hull),
      lit: wrecks.flatMap((wreck) => wreck.lit),
    };
  }, [index]);

  const hullMaterial = useMemo(
    () => new MeshStandardMaterial({ color: HULL, metalness: 0.45, roughness: 0.55 }),
    [],
  );
  const liveMaterial = useMemo(
    () =>
      new MeshBasicMaterial({
        color: LIVE,
        transparent: true,
        opacity: OPACITY,
        depthWrite: false,
      }),
    [],
  );

  useEffect(
    () => () => {
      hullMaterial.dispose();
      liveMaterial.dispose();
    },
    [hullMaterial, liveMaterial],
  );

  useFrame((state) => {
    if (!draws) {
      return;
    }
    if (reducedMotion) {
      liveMaterial.opacity = OPACITY * 0.6;
      return;
    }
    // Two unrelated rates and a hard floor: mostly on, dropping out now and
    // then, which is what a failing supply looks like.
    const t = state.clock.elapsedTime;
    const failing = Math.sin(t * 7.3) * Math.sin(t * 2.9 + 1.7);
    liveMaterial.opacity = failing > 0.72 ? OPACITY * 0.15 : OPACITY;
  });

  if (!draws || hull.length === 0) {
    return null;
  }

  return (
    <group>
      <InstancedField placements={hull}>
        <boxGeometry key="wreck" args={[1, 1, 1]} />
        <primitive key="wreck-material" object={hullMaterial} attach="material" />
      </InstancedField>
      {lit.length > 0 ? (
        <InstancedField placements={lit}>
          <boxGeometry key="live" args={[1, 1, 1]} />
          <primitive key="live-material" object={liveMaterial} attach="material" />
        </InstancedField>
      ) : null}
    </group>
  );
}
