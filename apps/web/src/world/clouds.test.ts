import { describe, expect, it } from 'vitest';
import { cloudBanks, type CloudIsland } from './clouds.js';

const ISLANDS: readonly CloudIsland[] = [
  { x: 0, y: 0, z: 0, radius: 124 },
  { x: 400, y: -18, z: 130, radius: 120 },
];
const OPTIONS = { perIsland: 12, open: 40, reach: 1_400 };

describe('cloudBanks', () => {
  it('is the same weather for the same seed', () => {
    expect(cloudBanks(3, ISLANDS, OPTIONS)).toEqual(cloudBanks(3, ISLANDS, OPTIONS));
    expect(cloudBanks(4, ISLANDS, OPTIONS)).not.toEqual(cloudBanks(3, ISLANDS, OPTIONS));
  });

  it('never stands a puff on a plateau', () => {
    for (const puff of cloudBanks(3, ISLANDS, OPTIONS)) {
      for (const island of ISLANDS) {
        const over = Math.hypot(puff.x - island.x, puff.z - island.z) < island.radius;
        if (over) {
          // Its top edge stays under the shelf.
          expect(puff.y + puff.size * 0.5).toBeLessThan(island.y);
        }
      }
    }
  });

  it('gathers a bank under every island, and leaves the open weather out from under them', () => {
    const puffs = cloudBanks(3, ISLANDS, OPTIONS);
    const gathered = puffs.slice(0, ISLANDS.length * OPTIONS.perIsland);
    const open = puffs.slice(ISLANDS.length * OPTIONS.perIsland);

    expect(gathered).toHaveLength(ISLANDS.length * OPTIONS.perIsland);
    expect(open.length).toBeGreaterThan(0);
    for (const puff of open) {
      for (const island of ISLANDS) {
        expect(Math.hypot(puff.x - island.x, puff.z - island.z)).toBeGreaterThanOrEqual(
          island.radius * 1.1,
        );
      }
      expect(puff.seed).toBeGreaterThanOrEqual(0);
      expect(puff.seed).toBeLessThan(1);
    }
  });
});
