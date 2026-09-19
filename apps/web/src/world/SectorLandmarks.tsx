import type { DetailLevel } from '@ponswars/world-runtime';
import { useMemo, type JSX } from 'react';
import { MeshBasicMaterial, MeshStandardMaterial } from 'three';
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
 * Neutral metal and the Market's own signal white (§38.3). A handful of meshes
 * a sector, like the forward bases, and the same shape vocabulary.
 */

/** The Market's working lights: cold white, and not a faction's (§36.5). */
const SIGNAL = '#bcdcf2';

function LandmarkGeometry({ part }: { readonly part: LandmarkPart }): JSX.Element {
  const [a, b, c] = part.size;
  switch (part.shape) {
    case 'box':
      return <boxGeometry args={[a, b, c]} />;
    case 'cylinder':
      // Six-sided, like the rest of this world's machinery.
      return <cylinderGeometry args={[a, c, b, 6]} />;
    case 'cone':
      return <coneGeometry args={[a, b, 6]} />;
  }
}

export function SectorLandmarks({
  index,
  detail,
}: {
  readonly index: number;
  readonly detail: DetailLevel;
}): JSX.Element | null {
  const landmark = useMemo(() => landmarkFor(sectorIdentity(index).name), [index]);

  const materials = useMemo(
    () => ({
      hull: new MeshStandardMaterial({ color: '#2b3a47', metalness: 0.26, roughness: 0.5 }),
      dark: new MeshStandardMaterial({ color: '#131f28', metalness: 0.22, roughness: 0.62 }),
      signal: new MeshBasicMaterial({ color: SIGNAL }),
    }),
    [],
  );

  if (detail === 'CULLED') {
    return null;
  }

  return (
    <>
      {LANDMARK_ANGLES.map((angle) => {
        const { position, rotation } = landmarkPlacement(angle);
        return (
          <group key={angle} position={[...position]} rotation={[0, rotation, 0]}>
            {landmark.parts.map((part, part_index) => (
              <mesh
                key={part_index}
                position={[...part.position]}
                rotation={[...part.rotation]}
                material={materials[part.material]}
              >
                <LandmarkGeometry part={part} />
              </mesh>
            ))}
          </group>
        );
      })}
    </>
  );
}
