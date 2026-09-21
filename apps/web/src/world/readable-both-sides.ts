import { ShaderChunk, type Material } from 'three';

/**
 * Text on a band that is seen from both sides, readable from both (§38.11).
 *
 * The holographic tape is an open ring drawn double-sided, so the far half of
 * it — the inside of the ring, seen through the near half — was the texture
 * from behind: every word mirrored ("NOIGƎL HƆƎM IA"), laid over the
 * right-reading words in front of it.
 *
 * A back face samples its texture with `u` reversed, which is the text the
 * right way round from where it is seen. No second mesh per band: that would
 * double what the tape costs.
 *
 * Which faces are the back ones is not `gl_FrontFacing` alone. A transparent
 * double-sided material is drawn by three in two passes, the back faces first
 * as `BackSide` — compiled with `FLIP_SIDED`, and drawn with the winding
 * reversed, so `gl_FrontFacing` is true on exactly the faces this is for. The
 * first version asked only `gl_FrontFacing` and changed nothing on screen.
 */

/** The texture read `map_fragment` makes, which this reverses on back faces. */
export const MAP_SAMPLE = 'texture2D( map, vMapUv )';

/** `u` reversed on whatever this pass draws as a back face. */
const READABLE_UV = `
  #if defined( FLIP_SIDED )
    vec2 pwReadableUv = vec2( -vMapUv.x, vMapUv.y );
  #elif defined( DOUBLE_SIDED )
    vec2 pwReadableUv = gl_FrontFacing ? vMapUv : vec2( -vMapUv.x, vMapUv.y );
  #else
    vec2 pwReadableUv = vMapUv;
  #endif
`;

const READABLE_SAMPLE = 'texture2D( map, pwReadableUv )';

/** `map_fragment`, sampling back faces mirrored. */
export function readableMapFragment(chunk: string = ShaderChunk.map_fragment): string {
  return chunk
    .replace('#ifdef USE_MAP', `#ifdef USE_MAP${READABLE_UV}`)
    .replace(MAP_SAMPLE, READABLE_SAMPLE);
}

export function readableBothSides<M extends Material>(material: M): M {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      readableMapFragment(),
    );
  };
  material.customProgramCacheKey = () => 'pw-readable-both-sides';
  return material;
}
