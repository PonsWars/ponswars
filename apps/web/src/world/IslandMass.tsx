import type { DetailLevel } from '@ponswars/world-runtime';
import { useEffect, useMemo, type JSX } from 'react';
import { BufferAttribute, BufferGeometry, MeshStandardMaterial } from 'three';
import { withCityLights } from './city-lights.js';
import { InstancedField, type Placement } from './InstancedField.js';
import { capped, CLIFF_DEPTH, islandRock, rimCity } from './rock.js';

/**
 * The body of a sector island: its rock and the city around its rim (§38.1, §38.9).
 *
 * Neutral by construction (§38.3) — no faction colour in the rock, and the rim
 * city's accent windows are the Market's own cold light, not either side's.
 */

/**
 * The stone round the plateau's edge.
 *
 * Very dark as a vertex colour because the rock is fully rough and dielectric:
 * it takes all of the key light that the paving, at a third metal, turns away —
 * at an islet's tone this ring read as a pale grey band round every plateau.
 */
const ISLAND_CAP = [0.008, 0.009, 0.011] as const;

/** The rock's resolution at each detail level (§82.2). */
const ROCK_RESOLUTION: Readonly<Record<DetailLevel, { around: number; rings: number }>> = {
  FULL: { around: 64, rings: 14 },
  REDUCED: { around: 36, rings: 9 },
  SILHOUETTE: { around: 18, rings: 5 },
  CULLED: { around: 8, rings: 2 },
};

/** Rim buildings at each detail level. None at silhouette: from there they are texture. */
const RIM_COUNT: Readonly<Record<DetailLevel, number>> = {
  FULL: 150,
  REDUCED: 70,
  SILHOUETTE: 0,
  CULLED: 0,
};

/**
 * What the rim city stays off: both district decks and the contested ground.
 * The numbers are the ones `WorldScene` builds those with.
 */
const RIM_CLEAR: readonly (readonly [number, number, number])[] = [
  [-62, 30, 54],
  [62, 30, 54],
  [0, 40, 80],
];

export function IslandMass({
  seed,
  radius,
  detail,
  top,
  depth = 150,
  core = false,
}: {
  readonly seed: number;
  readonly radius: number;
  readonly detail: DetailLevel;
  /** Where the plateau's surface is, which the rim city stands on. */
  readonly top: number;
  /** How far the rock hangs below the shelf. */
  readonly depth?: number;
  /**
   * The Market Core's own island: a downtown packed round the citadel instead
   * of a rim city round a battlefield, taller and warmer.
   */
  readonly core?: boolean;
}): JSX.Element {
  const resolution = ROCK_RESOLUTION[detail];

  const rock = useMemo(() => {
    const data = capped(
      islandRock(seed, {
        radius: radius * 0.98,
        depth,
        around: resolution.around,
        rings: resolution.rings,
      }),
      resolution.around,
      ISLAND_CAP,
    );
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
    geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
    geometry.setIndex(new BufferAttribute(data.indices, 1));
    // Faceted: broken rock has edges, and smooth normals make it read as clay.
    const faceted = geometry.toNonIndexed();
    geometry.dispose();
    faceted.computeVertexNormals();
    return faceted;
  }, [seed, radius, depth, resolution.around, resolution.rings]);

  const rockMaterial = useMemo(
    () =>
      withCityLights(
        new MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.94,
          metalness: 0.08,
          flatShading: true,
        }),
        // Dwellings cut into the cliff face, and none in the root: a few warm
        // windows down the wall under the city are what say the rock is lived
        // in and not only stood on. Sparse, and larger than a tower's, because
        // the wall is seen from further off.
        {
          accent: core ? '#ffd27a' : '#ffb45e',
          density: core ? 0.12 : 0.08,
          intensity: 3.2,
          floor: 5,
          bay: 4.2,
          band: [-depth * CLIFF_DEPTH, -3],
        },
      ),
    [core, depth],
  );

  const rim = useMemo<readonly Placement[]>(
    () =>
      rimCity(
        seed,
        core
          ? { count: 130, inner: 44, outer: radius * 0.84, maxHeight: 64, clear: [] }
          : {
              count: RIM_COUNT[detail],
              inner: radius * 0.76,
              outer: radius * 0.95,
              maxHeight: 22,
              clear: RIM_CLEAR,
            },
      ).map((building) => ({
        position: [building.x, top + building.height / 2, building.z],
        scale: [building.width, building.height, building.depth],
        rotation: [0, building.turn, 0],
      })),
    [seed, detail, radius, top, core],
  );

  const rimMaterial = useMemo(
    () =>
      withCityLights(
        new MeshStandardMaterial({
          color: '#18222b',
          metalness: 0.3,
          roughness: 0.62,
          envMapIntensity: 0.35,
          emissive: '#06121a',
          emissiveIntensity: 0.5,
        }),
        core
          ? { accent: '#ffd27a', density: 0.26, intensity: 4.5, floor: 2.8, bay: 2.3 }
          : { accent: '#7fd4ff', density: 0.22, intensity: 4, floor: 2.6, bay: 2.2 },
      ),
    [core],
  );

  useEffect(
    () => () => {
      rock.dispose();
    },
    [rock],
  );
  useEffect(
    () => () => {
      rockMaterial.dispose();
      rimMaterial.dispose();
    },
    [rockMaterial, rimMaterial],
  );

  return (
    <group>
      {/* The rock's own top just under the plateau's, so the cliff rises to
          the rim and the ragged edge past the plateau is stone, not a gap. */}
      <mesh geometry={rock} material={rockMaterial} position={[0, top - 0.6, 0]} />
      {rim.length > 0 ? (
        <InstancedField placements={rim}>
          <boxGeometry key="rim-building" args={[1, 1, 1]} />
          <primitive key="rim-material" object={rimMaterial} attach="material" />
        </InstancedField>
      ) : null}
    </group>
  );
}
