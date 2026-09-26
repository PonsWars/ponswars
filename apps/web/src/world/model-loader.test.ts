import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What `model-loader.ts` assumes of every model it loads: that none needs a
 * decoder, so the loader can attach none.
 *
 * The committed .glb files are what ship, so they are what is read — the JSON
 * chunk of each, the same way `core-model.test.ts` reads the core. A model
 * built later with Meshopt or Draco would fail to load in the browser; this
 * says so here first, and names it.
 */

const MODELS = fileURLToPath(new URL('../../public/models', import.meta.url));

/** Extensions three's GLTFLoader reads without any decoder. */
const READ_NATIVELY = new Set(['KHR_mesh_quantization', 'KHR_texture_transform']);

/** Extensions that need the decoders the loader deliberately does not attach. */
const NEED_A_DECODER = new Set([
  'EXT_meshopt_compression',
  'KHR_meshopt_compression',
  'KHR_draco_mesh_compression',
]);

function glbFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return glbFiles(path);
    }
    return entry.name.endsWith('.glb') ? [path] : [];
  });
}

function extensionsOf(path: string): readonly string[] {
  const bytes = readFileSync(path);
  const length = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')) as {
    readonly extensionsUsed?: readonly string[];
    readonly extensionsRequired?: readonly string[];
  };
  return [...new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])])];
}

const models = glbFiles(MODELS).map((path) => ({
  name: relative(MODELS, path).replaceAll('\\', '/'),
  extensions: extensionsOf(path),
}));

describe('the models the world loads', () => {
  it('are there to check', () => {
    // A path that stopped matching would make every assertion below vacuous.
    expect(models.length).toBeGreaterThan(10);
  });

  it('need no decoder, so none is attached', () => {
    const compressed = models.filter((model) =>
      model.extensions.some((extension) => NEED_A_DECODER.has(extension)),
    );
    expect(compressed.map((model) => model.name)).toEqual([]);
  });

  it('use only extensions three reads natively', () => {
    // An extension outside this list is not necessarily wrong — but it is a
    // new dependency of the loader, and should be looked at before it ships.
    const unknown = models.flatMap((model) =>
      model.extensions
        .filter((extension) => !READ_NATIVELY.has(extension))
        .map((extension) => `${model.name}: ${extension}`),
    );
    expect(unknown).toEqual([]);
  });
});
