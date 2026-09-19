import { describe, expect, it } from 'vitest';
import { BATTLEFIELD_VIEW } from './layout.js';
import {
  BASE_GROUND,
  BATTLE_GROUND,
  channelStrip,
  CHANNEL_DEPTH,
  DECK_RADIUS,
  DECK_Y,
  DISTRICT_GROUND,
  KEEP_OUT_RADIUS,
  SECTOR_IDENTITY_NAMES,
  sectorIdentity,
  type TerrainBlock,
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

  it('leaves the districts and the forward bases their ground', () => {
    // The check above only guarded the contested strip, and it passed while
    // every identity was putting blocks into the districts and onto the spot
    // each forward base lands on — the placement measured its angles from the
    // wrong axis. Measured independently here, from each block's corners.
    for (const index of SECTORS) {
      for (const block of sectorIdentity(index).blocks) {
        const [x, , z] = block.position;
        const reach = Math.hypot(block.size[0], block.size[2]) / 2;

        const intoDistrict = Math.hypot(
          Math.max(DISTRICT_GROUND.innerX - Math.abs(x), Math.abs(x) - DISTRICT_GROUND.outerX, 0),
          Math.max(Math.abs(z) - DISTRICT_GROUND.halfDepth, 0),
        );
        expect(intoDistrict).toBeGreaterThan(reach);

        const toBase = Math.hypot(Math.abs(x) - BASE_GROUND.x, z);
        expect(toBase).toBeGreaterThan(BASE_GROUND.radius + reach);
      }
    }
  });

  it('keeps enough of each identity to be recognised once the keep-outs have spoken', () => {
    // Blocks that would land on somebody's ground are discarded rather than
    // moved. That is only safe while an identity keeps enough of itself to
    // still be that identity; a filter that emptied one would pass every test
    // above and leave a sector bare.
    for (const index of SECTORS) {
      expect(sectorIdentity(index).blocks.length).toBeGreaterThanOrEqual(6);
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

describe('a data channel (§36.4, §38.11)', () => {
  const lit = SECTORS.flatMap((index) => sectorIdentity(index).blocks.filter((block) => block.lit));

  it('is carried by some of the world', () => {
    expect(lit.length).toBeGreaterThan(0);
  });

  it('is a line of light in the stone, not the stone made of light', () => {
    // The whole block drawn as translucent teal stood in front of the
    // battlefield camera as a slab of coloured glass.
    for (const block of lit) {
      const strip = channelStrip(block);
      expect(strip.size[0]).toBeLessThan(block.size[0] / 2);
      expect(strip.size[1]).toBeLessThanOrEqual(CHANNEL_DEPTH);
      expect(strip.size[2]).toBeLessThanOrEqual(block.size[2]);
      expect(strip.rotation).toBe(block.rotation);
    }
  });

  it('sits on the top face, proud of it, so the two never flicker', () => {
    for (const block of lit) {
      const strip = channelStrip(block);
      const top = block.position[1] + block.size[1] / 2;
      const stripBottom = strip.position[1] - strip.size[1] / 2;
      const stripTop = strip.position[1] + strip.size[1] / 2;
      expect(stripBottom).toBeLessThan(top);
      expect(stripTop).toBeGreaterThan(top);
    }
  });

  it('never lies level with the deck it is laid on', () => {
    // The canyon's channels were sunk with their tops flush with the deck,
    // which drew straight over them.
    for (const block of lit) {
      expect(block.position[1] + block.size[1] / 2).toBeGreaterThan(DECK_Y);
    }
  });
});

describe('the battle, seen from the battlefield camera (§36.15)', () => {
  const camera = [0, BATTLEFIELD_VIEW.up, BATTLEFIELD_VIEW.out] as const;

  /** Whether the segment from the camera to a point passes through a block. */
  function blocks(block: TerrainBlock, to: readonly [number, number, number]): boolean {
    // Into the block's own frame, where it is an axis-aligned box.
    const cos = Math.cos(block.rotation);
    const sin = Math.sin(block.rotation);
    const local = (p: readonly [number, number, number]): [number, number, number] => {
      const dx = p[0] - block.position[0];
      const dz = p[2] - block.position[2];
      return [dx * cos - dz * sin, p[1] - block.position[1], dx * sin + dz * cos];
    };
    const from = local(camera);
    const end = local(to);
    let enter = 0;
    let exit = 1;
    for (let axis = 0; axis < 3; axis += 1) {
      const half = (block.size[axis] ?? 0) / 2;
      const start = from[axis] ?? 0;
      const step = (end[axis] ?? 0) - start;
      if (Math.abs(step) < 1e-9) {
        if (Math.abs(start) > half) {
          return false;
        }
        continue;
      }
      const a = (-half - start) / step;
      const b = (half - start) / step;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) {
        return false;
      }
    }
    return true;
  }

  // The near edge of the contested ground, and the front of each district —
  // the ground the frontline and the two armies are read on.
  const targets: [number, number, number][] = [];
  for (let x = -BATTLE_GROUND.halfWidth; x <= BATTLE_GROUND.halfWidth; x += 4) {
    targets.push([x, DECK_Y, BATTLE_GROUND.halfDepth]);
  }
  const districtSpan = DISTRICT_GROUND.outerX - DISTRICT_GROUND.innerX;
  for (let step = 0; step <= districtSpan; step += 4) {
    const x = DISTRICT_GROUND.innerX + step;
    targets.push([x, DECK_Y, DISTRICT_GROUND.halfDepth], [-x, DECK_Y, DISTRICT_GROUND.halfDepth]);
  }

  it('has nothing standing between it and the ground the battle is read on', () => {
    // The keep-out stopped terrain standing *on* the battle ground and nothing
    // standing tall in front of it: a ridge pier thirty units high stood square
    // in this camera's line to the near end of the frontline.
    for (const index of SECTORS) {
      for (const block of sectorIdentity(index).blocks) {
        for (const target of targets) {
          expect(blocks(block, target), `sector ${String(index)} at ${target.join(',')}`).toBe(
            false,
          );
        }
      }
    }
  });

  it('lets the far side keep its height', () => {
    // Behind the battle from this camera, a tall ridge is backdrop, not a wall
    // — and the identity still has to read as a ridge.
    const ridge = sectorIdentity(0).blocks;
    const far = ridge.filter((block) => block.position[2] < 0);
    expect(Math.max(...far.map((block) => block.size[1]))).toBeGreaterThan(20);
  });
});
