import { useModel } from './model-loader.js';
import { useMemo, type JSX } from 'react';
import { Box3, Vector3 } from 'three';
import { preparedGeometry } from './InstancedField.js';

/**
 * A craft on a route (§38.6).
 *
 * Two hulls between five routes, picked by index, because the point is that
 * something is flying rather than that each one is distinct — and a second
 * model is the difference between traffic and a repeated asset.
 *
 * Turned to face along its route. `heading` is the same angle the rail is laid
 * at, taken from the sector's position, so a ship cannot end up flying sideways
 * down a line drawn at a different angle.
 */
export const DROPSHIPS = ['/models/units/dropship-a.glb', '/models/units/dropship-c.glb'] as const;

/** How long a dropship is, in world units. A sector island is 240 across. */
const DROPSHIP_LENGTH = 26;

export function Dropship({
  index,
  heading,
  accent,
}: {
  readonly index: number;
  readonly heading: number;
  readonly accent: string;
}): JSX.Element | null {
  const url = DROPSHIPS[index % DROPSHIPS.length] ?? DROPSHIPS[0];
  const { scene } = useModel(url);

  const geometry = useMemo(
    () =>
      preparedGeometry(`dropship:${url}`, scene, (shaped) => {
        shaped.computeBoundingBox();
        const box: unknown = shaped.boundingBox;
        if (!(box instanceof Box3)) {
          return;
        }
        const size = box.getSize(new Vector3());
        const span = Math.max(size.x, size.z, 0.0001);
        const fit = DROPSHIP_LENGTH / span;
        shaped.scale(fit, fit, fit);
        // Centred on its own middle, so the group's position is where the ship
        // is rather than where one corner of it is.
        shaped.translate(
          -((box.min.x + box.max.x) / 2) * fit,
          -((box.min.y + box.max.y) / 2) * fit,
          -((box.min.z + box.max.z) / 2) * fit,
        );
      }),
    [scene, url],
  );

  if (geometry === null) {
    return null;
  }

  return (
    <mesh rotation={[0, heading, 0]}>
      <primitive object={geometry} attach="geometry" />
      {/* Lit like everything else in this world rather than like the pack it
          came from, with the route's own colour as a faint rim (§36.5). */}
      <meshStandardMaterial
        color="#6f8494"
        metalness={0.32}
        roughness={0.58}
        emissive={accent}
        emissiveIntensity={0.18}
      />
    </mesh>
  );
}
