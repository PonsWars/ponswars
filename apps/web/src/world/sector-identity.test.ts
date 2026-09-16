import { describe, expect, it } from 'vitest';
import {
  BATTLE_GROUND,
  DECK_RADIUS,
  KEEP_OUT_RADIUS,
  SECTOR_IDENTITY_NAMES,
  sectorIdentity,
} from './sector-identity.js';

/**
 * The five places (§38.4), and the one rule none of them may break.
 *
 * Terrain is the part of this world a player navigates by, and the part that
 * can quietly ruin the thing §36.15 asks for: a battle whose frontline is
 * instantly readable. So the keep-out is tested, not trusted.
 */

const SECTORS = [0, 1, 2, 3, 4];

describe('a sector as a place', () => {
  it('gives each of the five its own identity', () => {
    // §38.4 names five, and five discs with the same ring road on them is what
    // this exists to stop.
    const names = SECTORS.map((index) => sectorIdentity(index).name);

    expect(new Set(names).size).toBe(SECTORS.length);
    expect(names).toEqual([...SECTOR_IDENTITY_NAMES]);
  });

  it('is the same place every time it is asked for', () => {
    // §38.4: geometry stays stable across rounds, for orientation. A sector a
    // player learned the shape of has to be that shape when they come back —
    // on their machine and on everybody else's.
    expect(sectorIdentity(2)).toEqual(sectorIdentity(2));
    expect(sectorIdentity(2)).not.toEqual(sectorIdentity(3));
  });

  it('stands nothing on the ground the battle is read on', () => {
    // §36.15 and §38.9. The contested strip and the two districts are inside
    // the keep-out; verticality goes round them. A block reaching in would put
    // terrain between a viewer and the frontline, which is the one thing they
    // must be able to take in at a glance.
    for (const index of SECTORS) {
      for (const block of sectorIdentity(index).blocks) {
        const [x, , z] = block.position;
        expect(Math.hypot(x, z)).toBeGreaterThanOrEqual(KEEP_OUT_RADIUS);

        // And measured from the block's own corners, not its centre: a wide
        // slab centred outside the line can still reach across it. The reach is
        // the bounding circle, which is the conservative reading whatever the
        // block is turned to.
        const reach = Math.hypot(block.size[0], block.size[2]) / 2;
        const gapX = Math.abs(x) - BATTLE_GROUND.halfWidth;
        const gapZ = Math.abs(z) - BATTLE_GROUND.halfDepth;
        const clear = Math.hypot(Math.max(gapX, 0), Math.max(gapZ, 0));
        expect(clear).toBeGreaterThan(reach);
      }
    }
  });

  it('hangs nothing over the void', () => {
    for (const index of SECTORS) {
      for (const block of sectorIdentity(index).blocks) {
        const [x, , z] = block.position;
        expect(Math.hypot(x, z)).toBeLessThanOrEqual(DECK_RADIUS);
      }
    }
  });

  it('names every identity in words a player could be shown', () => {
    for (const index of SECTORS) {
      expect(sectorIdentity(index).label).toMatch(/^[A-Z][a-z]/);
    }
  });

  it('keeps each sector to a handful of shapes', () => {
    // §82.1 puts a budget on a world with five of these in it. They instance to
    // two draw calls a sector, but the matrices are still written.
    for (const index of SECTORS) {
      const blocks = sectorIdentity(index).blocks;
      expect(blocks.length).toBeGreaterThan(5);
      expect(blocks.length).toBeLessThanOrEqual(32);
    }
  });
});
