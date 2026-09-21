import { ShaderChunk } from 'three';
import { describe, expect, it } from 'vitest';
import { MAP_SAMPLE, readableMapFragment } from './readable-both-sides.js';

/**
 * Text on the holographic tape, readable from both sides (§38.11).
 */

describe('the texture read on a back face', () => {
  it('finds the read it replaces in the three this ships with', () => {
    // If three rewrites `map_fragment`, the replacement would silently do
    // nothing and the far side of every tape would be mirrored again.
    expect(ShaderChunk.map_fragment).toContain(MAP_SAMPLE);
    expect(ShaderChunk.map_fragment).toContain('#ifdef USE_MAP');
  });

  it('reads through the reversed coordinate, declared before it is used', () => {
    const chunk = readableMapFragment();

    expect(chunk).not.toContain(MAP_SAMPLE);
    expect(chunk.indexOf('vec2 pwReadableUv')).toBeGreaterThan(-1);
    expect(chunk.indexOf('vec2 pwReadableUv')).toBeLessThan(
      chunk.indexOf('texture2D( map, pwReadableUv )'),
    );
  });

  it('reverses u on the back-face pass three draws with FLIP_SIDED, not only by gl_FrontFacing', () => {
    // Transparent double-sided materials are drawn as BackSide then FrontSide,
    // and the BackSide pass reverses the winding: gl_FrontFacing is true there.
    const chunk = readableMapFragment();
    const flipped = chunk.slice(chunk.indexOf('FLIP_SIDED'), chunk.indexOf('#elif'));

    expect(flipped).toContain('vec2( -vMapUv.x, vMapUv.y )');
    expect(flipped).not.toContain('gl_FrontFacing');
  });
});
