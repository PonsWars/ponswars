import { describe, expect, it } from 'vitest';
import { glslFloat } from './glsl.js';

describe('a number written into a shader', () => {
  it('is always a float literal', () => {
    expect(glslFloat(96)).toBe('96.0');
    expect(glslFloat(0)).toBe('0.0');
    expect(glslFloat(-7)).toBe('-7.0');
  });

  it('keeps a fraction exactly as it is', () => {
    expect(glslFloat(0.32)).toBe('0.32');
    expect(glslFloat(5.5)).toBe('5.5');
  });
});
