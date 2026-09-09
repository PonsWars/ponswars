import { describe, expect, it } from 'vitest';
import {
  debrisField,
  districtBlocks,
  heightCap,
  islandCrags,
  type Block,
  type DistrictShape,
} from './island.js';

/**
 * The generated shape of a war sector (§38.4, §38.9).
 *
 * The point of generating it is that there is more of it than anyone would
 * place by hand. The cost of generating it is that nobody has looked at every
 * result — so what is asserted here is the set of things that must hold for
 * *every* seed, not the way any one island happens to come out.
 */

const SHAPE: DistrictShape = {
  halfWidth: 26,
  halfDepth: 52,
  peakHeight: 46,
  edgeHeight: 14,
  minFootprint: 5,
  maxFootprint: 13,
  spacing: 1.6,
};

/** The circle that contains a block whatever its yaw. */
function boundingRadius(block: Block): number {
  return Math.hypot(block.width, block.depth) / 2;
}

describe('a district', () => {
  it('is the same district for the same seed', () => {
    // §38.4 wants geometry stable enough to orient by. Two clients drawing one
    // sector differently would be two different worlds, and a player who
    // learned the island with the tall western ridge would find it moved.
    expect(districtBlocks(7, SHAPE, 14)).toEqual(districtBlocks(7, SHAPE, 14));
  });

  it('is a different district for a different seed', () => {
    // The other half of the same requirement: five identical islands are one
    // island drawn five times, and nothing about the ring is memorable.
    expect(districtBlocks(7, SHAPE, 14)).not.toEqual(districtBlocks(8, SHAPE, 14));
  });

  it('never returns more than it was asked for', () => {
    for (const count of [0, 1, 6, 14, 40]) {
      expect(districtBlocks(3, SHAPE, count).length).toBeLessThanOrEqual(count);
    }
  });

  it('fills a district that has room for what was asked', () => {
    // A generator that quietly returns three buildings for a request of
    // fourteen would leave the world looking half-built and pass every other
    // test on this page.
    expect(districtBlocks(3, SHAPE, 12).length).toBe(12);
  });

  it('keeps every structure on the ground it was given', () => {
    // A block hanging off the plateau reads as a bug in the world rather than
    // as architecture. Checked as a bounding circle, so it holds at any yaw.
    for (let seed = 0; seed < 40; seed += 1) {
      for (const block of districtBlocks(seed, SHAPE, 14)) {
        const radius = boundingRadius(block);
        const spanX = SHAPE.halfWidth - radius;
        const spanZ = SHAPE.halfDepth - radius;

        expect(spanX).toBeGreaterThan(0);
        expect(spanZ).toBeGreaterThan(0);
        expect(Math.hypot(block.x / spanX, block.z / spanZ)).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('never stands two structures inside each other', () => {
    // The failure this rules out is not subtle from the sector camera: two
    // boxes sharing a volume flicker against each other as it moves.
    for (let seed = 0; seed < 40; seed += 1) {
      const blocks = districtBlocks(seed, SHAPE, 14);
      for (let i = 0; i < blocks.length; i += 1) {
        for (let j = i + 1; j < blocks.length; j += 1) {
          const a = blocks[i];
          const b = blocks[j];
          if (a === undefined || b === undefined) {
            continue;
          }
          const clearance = boundingRadius(a) + boundingRadius(b) + SHAPE.spacing;
          expect(
            Math.hypot(a.x - b.x, a.z - b.z),
            `seed ${String(seed)}: blocks ${String(i)} and ${String(j)} overlap`,
          ).toBeGreaterThanOrEqual(clearance - 1e-9);
        }
      }
    }
  });

  it('domes toward its middle rather than walling its edge', () => {
    // The skyline has to fall away at the rim or the sector camera looks at a
    // wall with a battlefield hidden behind it (§36.2 keeps the frontline
    // understandable). `heightCap` is the rule; this is every block obeying it.
    for (let seed = 0; seed < 40; seed += 1) {
      for (const block of districtBlocks(seed, SHAPE, 14)) {
        const distance = Math.hypot(block.x / SHAPE.halfWidth, block.z / SHAPE.halfDepth);
        expect(block.height).toBeGreaterThan(0);
        expect(block.height).toBeLessThanOrEqual(heightCap(SHAPE, distance) + 1e-9);
      }
    }
  });

  it('lights only structures tall enough to be a skyline', () => {
    // §36.5 keeps faction colour an accent. A crown on every roof is a lit grid
    // and the accent stops meaning anything.
    const blocks = districtBlocks(11, SHAPE, 14);
    const lit = blocks.filter((block) => block.lit);

    expect(lit.length).toBeGreaterThan(0);
    expect(lit.length).toBeLessThan(blocks.length);
    for (const block of lit) {
      expect(block.height).toBeGreaterThan(SHAPE.peakHeight * 0.5);
    }
  });

  it('returns nothing rather than looping when nothing fits', () => {
    // A shape whose smallest structure is larger than the ground it stands on
    // is a legitimate calibration mistake, and the wrong answer to it is a
    // browser tab that stops responding.
    const impossible: DistrictShape = { ...SHAPE, minFootprint: 200, maxFootprint: 260 };

    expect(districtBlocks(1, impossible, 14)).toEqual([]);
  });

  it('produces numbers, for any seed a caller can reach it with', () => {
    // Seeds come from indices, and an index arriving negative or fractional
    // must not put a NaN into a transform matrix — where it does not throw, it
    // silently removes the object from the scene.
    for (const seed of [-9, 0, 0.5, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
      const blocks = districtBlocks(seed, SHAPE, 8);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        for (const value of [block.x, block.z, block.width, block.depth, block.height]) {
          expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });
});

describe('the underside of an island', () => {
  it('hangs its rock inside the plateau it hangs from', () => {
    // A crag reaching past the rim is visible from above as rock growing out of
    // thin air beside the island.
    for (let seed = 0; seed < 20; seed += 1) {
      for (const crag of islandCrags(seed, 90, 7)) {
        expect(Math.hypot(crag.x, crag.z) + crag.radius).toBeLessThanOrEqual(90);
        expect(crag.length).toBeGreaterThan(0);
        expect(Number.isFinite(crag.tiltX) && Number.isFinite(crag.tiltZ)).toBe(true);
      }
    }
  });

  it('is the same underside every time, and empty when asked for nothing', () => {
    expect(islandCrags(4, 90, 7)).toEqual(islandCrags(4, 90, 7));
    expect(islandCrags(4, 90, 0)).toEqual([]);
    expect(islandCrags(4, 90, -3)).toEqual([]);
  });
});

describe('the debris around the world', () => {
  it('stays in the band it was given', () => {
    // Inside the inner radius it would sit on the islands; outside the outer it
    // would drift past the soft boundary the camera resists at (§38.8).
    for (const rock of debrisField(2, 600, 1_400, 60)) {
      const distance = Math.hypot(rock.x, rock.z);
      expect(distance).toBeGreaterThanOrEqual(600);
      expect(distance).toBeLessThanOrEqual(1_400);
      expect(rock.radius).toBeGreaterThan(0);
    }
  });

  it('is the same field every time', () => {
    expect(debrisField(2, 600, 1_400, 12)).toEqual(debrisField(2, 600, 1_400, 12));
  });
});

describe('the height cap', () => {
  it('is the peak at the middle and the edge height at the rim', () => {
    expect(heightCap(SHAPE, 0)).toBe(SHAPE.peakHeight);
    expect(heightCap(SHAPE, 1)).toBe(SHAPE.edgeHeight);
  });

  it('clamps rather than extrapolating past the rim', () => {
    // The distance is normalized against the district's half-extents, and a
    // corner is further than one of them. Extrapolating there would produce a
    // negative cap and a building with no height.
    expect(heightCap(SHAPE, 1.6)).toBe(SHAPE.edgeHeight);
    expect(heightCap(SHAPE, -2)).toBe(SHAPE.peakHeight);
  });
});
