import type { DetailLevel } from '@ponswars/world-runtime';
import { useEffect, useMemo, type JSX } from 'react';
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sectorIdentity } from './sector-identity.js';
import {
  LANDMARK_ANGLES,
  landmarkFor,
  landmarkPlacement,
  type LandmarkPart,
} from './sector-landmark.js';

/**
 * The pair of structures that tells a sector apart from across the world
 * (§38.4, §36.7).
 *
 * `sector-landmark.ts` decides what they are and where they stand; this draws
 * them. Drawn at silhouette range as well as up close, unlike the rest of the
 * scenery: §37.6 drops detail with distance, and this *is* the distant read —
 * dropping it would leave five islands that look alike from exactly the level
 * §37.2 has a player choose a battle at.
 *
 * Neutral metal and the Market's own signal white (§38.3).
 *
 * ## One geometry per surface
 *
 * Every part of both structures is baked into a single geometry per material,
 * so a sector's landmarks cost three draw calls rather than one per part. The
 * first version drew each part as its own mesh — about forty-five draw calls
 * across the world for a handful of boxes that never move independently, in a
 * scene whose frame cost is set by how many draw calls it makes (§82.1). The
 * parts are static, so nothing is lost by baking them.
 */

/** The Market's working lights: cold white, and not a faction's (§36.5). */
const SIGNAL = '#bcdcf2';

type Surface = LandmarkPart['material'];

const SURFACES: readonly Surface[] = ['hull', 'dark', 'signal'];

/** A part's shape as a geometry at the origin, sized as `sector-landmark.ts` sizes it. */
function partGeometry(part: LandmarkPart): BufferGeometry {
  const [a, b, c] = part.size;
  switch (part.shape) {
    case 'box':
      return new BoxGeometry(a, b, c);
    case 'cylinder':
      // Six-sided, like the rest of this world's machinery.
      return new CylinderGeometry(a, c, b, 6);
    case 'cone':
      return new ConeGeometry(a, b, 6);
  }
}

/** A transform from a position and an Euler rotation, at unit scale. */
function placed(position: readonly [number, number, number], rotation: Euler): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...position),
    new Quaternion().setFromEuler(rotation),
    new Vector3(1, 1, 1),
  );
}

/**
 * Both landmarks of a sector, every part in the sector's own frame, merged by
 * surface. `null` for a surface nothing is made of.
 */
function bakedLandmarks(index: number): Readonly<Record<Surface, BufferGeometry | null>> {
  const landmark = landmarkFor(sectorIdentity(index).name);
  const bySurface: Record<Surface, BufferGeometry[]> = { hull: [], dark: [], signal: [] };

  for (const angle of LANDMARK_ANGLES) {
    const { position, rotation } = landmarkPlacement(angle);
    const structure = placed(position, new Euler(0, rotation, 0));
    for (const part of landmark.parts) {
      const geometry = partGeometry(part);
      const [x, y, z] = part.rotation;
      geometry.applyMatrix4(structure.clone().multiply(placed(part.position, new Euler(x, y, z))));
      bySurface[part.material].push(geometry);
    }
  }

  const merged = {} as Record<Surface, BufferGeometry | null>;
  for (const surface of SURFACES) {
    const parts = bySurface[surface];
    merged[surface] = parts.length === 0 ? null : mergeGeometries(parts, false);
    for (const part of parts) {
      part.dispose();
    }
  }
  return merged;
}

export function SectorLandmarks({
  index,
  detail,
}: {
  readonly index: number;
  readonly detail: DetailLevel;
}): JSX.Element | null {
  const geometries = useMemo(() => bakedLandmarks(index), [index]);

  const materials = useMemo(
    () => ({
      hull: new MeshStandardMaterial({ color: '#2b3a47', metalness: 0.26, roughness: 0.5 }),
      dark: new MeshStandardMaterial({ color: '#131f28', metalness: 0.22, roughness: 0.62 }),
      signal: new MeshBasicMaterial({ color: SIGNAL }),
    }),
    [],
  );

  useEffect(
    () => () => {
      for (const surface of SURFACES) {
        geometries[surface]?.dispose();
      }
    },
    [geometries],
  );

  useEffect(
    () => () => {
      for (const surface of SURFACES) {
        materials[surface].dispose();
      }
    },
    [materials],
  );

  if (detail === 'CULLED') {
    return null;
  }

  return (
    <>
      {SURFACES.map((surface) => {
        const geometry = geometries[surface];
        return geometry === null ? null : (
          <mesh key={surface} geometry={geometry} material={materials[surface]} />
        );
      })}
    </>
  );
}
