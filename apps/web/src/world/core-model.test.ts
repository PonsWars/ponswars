import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Market Core file that actually ships (§38.2).
 *
 * `tools/blender/build-core.py` builds it, and nothing in CI runs Blender — the
 * GLB is committed, so the committed GLB is what gets checked. What is checked
 * is not its shape, which is a judgement, but the handful of facts the client
 * and the camera depend on:
 *
 * - the two mesh names the client looks up, because a renamed mesh does not
 *   throw, it silently renders nothing and the landmark quietly disappears;
 * - the summit, because the beacon, the point light and the light beam are all
 *   placed at 208 and a taller core would swallow them;
 * - the footprint, because the plateau it stands on is 118 across at the base
 *   and a spire hanging over the edge stands on air.
 *
 * Read from the GLB's own JSON chunk, in the same way and for the same reason
 * as the clip check in `army-rules.test.ts`: a list kept beside a file is a list
 * that can disagree with it.
 */

const CORE = '/models/core/market-core.glb';

/** The beacon's height, and so the ceiling for everything below it. */
const SUMMIT = 208;

/** The plateau's base radius, from `MarketCore` in `WorldScene.tsx`. */
const PLATEAU = 118;

interface Bounds {
  readonly min: readonly number[];
  readonly max: readonly number[];
}

/**
 * Each mesh's bounds, by name, in the exported y-up frame.
 *
 * glTF requires `min` and `max` on a POSITION accessor, so this is the model's
 * real extent rather than an estimate — no vertex data need be decoded.
 */
function meshBounds(url: string): ReadonlyMap<string, Bounds> {
  const path = fileURLToPath(new URL(`../../public${url}`, import.meta.url));
  const bytes = readFileSync(path);
  const length = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')) as {
    readonly meshes?: readonly {
      readonly name?: string;
      readonly primitives: readonly { readonly attributes: Record<string, number> }[];
    }[];
    readonly accessors?: readonly { readonly min?: number[]; readonly max?: number[] }[];
  };
  const accessors = json.accessors ?? [];
  const bounds = new Map<string, Bounds>();
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      const index = primitive.attributes['POSITION'];
      const accessor = index === undefined ? undefined : accessors[index];
      if (mesh.name !== undefined && accessor?.min !== undefined && accessor.max !== undefined) {
        bounds.set(mesh.name, { min: accessor.min, max: accessor.max });
      }
    }
  }
  return bounds;
}

describe('the Market Core model', () => {
  const bounds = meshBounds(CORE);

  it('carries the two meshes the client looks up by name', () => {
    // `CoreModel` renders nothing at all for a name it cannot find.
    expect([...bounds.keys()].sort()).toEqual(['core_bands', 'core_body']);
  });

  it('stands on the plateau rather than over its edge', () => {
    const body = bounds.get('core_body');
    expect(body).toBeDefined();
    const [minX = 0, , minZ = 0] = body?.min ?? [];
    const [maxX = 0, , maxZ = 0] = body?.max ?? [];
    // The far corner of the footprint, which is the part that would hang over.
    const reach = Math.max(
      Math.hypot(minX, minZ),
      Math.hypot(minX, maxZ),
      Math.hypot(maxX, minZ),
      Math.hypot(maxX, maxZ),
    );
    expect(reach).toBeLessThanOrEqual(PLATEAU);
  });

  it('keeps its summit under the beacon, and its feet on the deck', () => {
    const body = bounds.get('core_body');
    const [, minY = 0] = body?.min ?? [];
    const [, maxY = 0] = body?.max ?? [];
    expect(maxY).toBeLessThanOrEqual(SUMMIT);
    expect(minY).toBe(0);
  });

  it('lights bands on the structure rather than beside it', () => {
    // The bands are a separate mesh so the client decides what is lit; they are
    // still part of the same building, and one floating past the summit or out
    // beyond the footprint would read as a ring hanging in the air.
    const body = bounds.get('core_body');
    const bands = bounds.get('core_bands');
    expect(bands).toBeDefined();
    for (const axis of [0, 1, 2]) {
      expect(bands?.min[axis] ?? 0).toBeGreaterThanOrEqual(body?.min[axis] ?? 0);
      expect(bands?.max[axis] ?? 0).toBeLessThanOrEqual(body?.max[axis] ?? 0);
    }
  });
});
