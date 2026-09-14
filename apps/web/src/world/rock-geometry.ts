import { BufferAttribute, BufferGeometry } from 'three';
import type { RockData } from './rock.js';

/**
 * Rock data as a faceted three geometry.
 *
 * Non-indexed with normals recomputed per face: broken rock has edges, and
 * smooth normals across a low-poly mass make it read as clay. One place, so the
 * islands, the islets and the outcrops on a rim are all the same stone.
 */
export function rockGeometry(data: RockData): BufferGeometry {
  const indexed = new BufferGeometry();
  indexed.setAttribute('position', new BufferAttribute(data.positions, 3));
  indexed.setAttribute('color', new BufferAttribute(data.colors, 3));
  indexed.setIndex(new BufferAttribute(data.indices, 1));
  const faceted = indexed.toNonIndexed();
  indexed.dispose();
  faceted.computeVertexNormals();
  return faceted;
}
