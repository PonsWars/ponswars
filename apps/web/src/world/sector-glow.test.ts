import { describe, expect, it } from 'vitest';
import { sectorGlows } from './sector-glow.js';

/**
 * What the weather is told about the battles above it (§38.10, §36.15).
 *
 * The rule is small and the consequences are not: this decides what colour the
 * cloud under a sector takes, which is how a viewer reads who is pushing from
 * across the world and from any angle.
 */

const POSITIONS = [
  { x: 0, z: 100 },
  { x: 100, z: 0 },
  { x: 0, z: -100 },
  { x: -100, z: 0 },
  { x: 50, z: 50 },
];

const battle = (overrides: Partial<Parameters<typeof sectorGlows>[0][number]> = {}) => ({
  sectorIndex: 0,
  left: 'NVDA',
  right: 'AMZN',
  momentum: 'CONTESTED' as const,
  frontline: 0.5,
  ...overrides,
});

describe('the light a sector throws into the weather', () => {
  it('stands where its sector stands, not where it arrived in the list', () => {
    // §38.3 lets any pair occupy any sector, so a list that came back in
    // another order would otherwise light the wrong rock.
    const [glow] = sectorGlows([battle({ sectorIndex: 3 })], POSITIONS);

    expect(glow).toMatchObject({ x: -100, z: 0 });
  });

  it('burns brighter the harder a battle is being pushed', () => {
    const states = ['CONTESTED', 'PUSHING', 'SURGING', 'DOMINATING'] as const;
    const strengths = states.map(
      (momentum) => sectorGlows([battle({ momentum })], POSITIONS)[0]?.strength ?? 0,
    );

    expect(strengths).toEqual([...strengths].sort((a, b) => a - b));
    expect(strengths.at(-1)).toBeLessThanOrEqual(1);
  });

  it('carries both factions and the frontline, never a score', () => {
    // §24 hides the exact score for the whole live battle. The frontline is
    // what a client is given instead (§13.2), and mixing light by it says who
    // is pushing without this ever having held a number that says by how much.
    const [glow] = sectorGlows([battle({ frontline: 0.8 })], POSITIONS);

    expect(glow?.hold).toBe(0.8);
    expect(glow?.left).toMatch(/^#[0-9a-f]{6}$/i);
    expect(glow?.right).toMatch(/^#[0-9a-f]{6}$/i);
    expect(glow?.left).not.toBe(glow?.right);
  });

  it('clamps a frontline outside the field rather than mixing past a faction', () => {
    expect(sectorGlows([battle({ frontline: 1.4 })], POSITIONS)[0]?.hold).toBe(1);
    expect(sectorGlows([battle({ frontline: Number.NaN })], POSITIONS)[0]?.hold).toBe(0.5);
  });

  it('lights nothing for a sector that is not there, or a ticker with no accent', () => {
    // Neither is a colour to invent (§36.5): a sector this build has no
    // position for and a ticker it has no accent for both throw no light,
    // rather than throwing one nobody chose.
    expect(sectorGlows([battle({ sectorIndex: 9 })], POSITIONS)).toEqual([]);
    expect(sectorGlows([battle({ left: 'NOPE' })], POSITIONS)).toEqual([]);
  });
});
