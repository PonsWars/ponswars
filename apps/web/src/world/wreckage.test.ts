import { describe, expect, it } from 'vitest';
import {
  BASE_GROUND,
  BATTLE_GROUND,
  DECK_RADIUS,
  DISTRICT_GROUND,
  sectorIdentity,
} from './sector-identity.js';
import { sectorWreckage } from './wreckage.js';

/**
 * The damage on each deck (§36.4), against everybody's ground.
 *
 * A wreck is the one kind of scenery that lies *down* — which means it spreads
 * sideways, and a pylon lying across the contested strip would be the one
 * object on the deck a player could not read past (§36.15).
 */

const SECTORS = [0, 1, 2, 3, 4];

describe('the wreckage on a deck', () => {
  it('lies off the contested ground, the districts and the forward bases', () => {
    for (const index of SECTORS) {
      for (const wreck of sectorWreckage(index)) {
        const [x, z] = wreck.centre;
        const ax = Math.abs(x);
        const az = Math.abs(z);

        const battle = Math.hypot(
          Math.max(ax - BATTLE_GROUND.halfWidth, 0),
          Math.max(az - BATTLE_GROUND.halfDepth, 0),
        );
        const district = Math.hypot(
          Math.max(DISTRICT_GROUND.innerX - ax, ax - DISTRICT_GROUND.outerX, 0),
          Math.max(az - DISTRICT_GROUND.halfDepth, 0),
        );
        const base = Math.hypot(ax - BASE_GROUND.x, z) - BASE_GROUND.radius;

        expect(battle).toBeGreaterThan(wreck.reach);
        expect(district).toBeGreaterThan(wreck.reach);
        expect(base).toBeGreaterThan(wreck.reach);
      }
    }
  });

  it('lies wholly on the rock, not half over the void', () => {
    for (const index of SECTORS) {
      for (const wreck of sectorWreckage(index)) {
        expect(Math.hypot(wreck.centre[0], wreck.centre[1]) + wreck.reach).toBeLessThanOrEqual(
          DECK_RADIUS,
        );
      }
    }
  });

  it('does not share a place with the sector terrain', () => {
    // Two solids in one place read as a rendering fault, not as a pylon that
    // fell against a ridge.
    for (const index of SECTORS) {
      const blocks = sectorIdentity(index).blocks;
      for (const wreck of sectorWreckage(index)) {
        for (const block of blocks) {
          const reach = Math.hypot(block.size[0], block.size[2]) / 2;
          const apart = Math.hypot(
            block.position[0] - wreck.centre[0],
            block.position[2] - wreck.centre[1],
          );
          expect(apart).toBeGreaterThanOrEqual(reach + wreck.reach);
        }
      }
    }
  });

  it('puts some damage on every deck, and the same damage every time', () => {
    // §38.4: a sector is recognisable across rounds, and its wreckage is part
    // of what it looks like.
    for (const index of SECTORS) {
      expect(sectorWreckage(index).length).toBeGreaterThanOrEqual(2);
      expect(sectorWreckage(index)).toEqual(sectorWreckage(index));
    }
  });

  it('lights a toppled board along its face, not in the air beside it', () => {
    // The segments are turned by the board's own tilt and heading, and a slip
    // in that maths would float them off it. Each stays within the board's
    // length of its centre.
    for (const index of SECTORS) {
      for (const wreck of sectorWreckage(index)) {
        if (wreck.kind !== 'PYLON') {
          continue;
        }
        for (const segment of wreck.lit) {
          const apart = Math.hypot(
            segment.position[0] - wreck.centre[0],
            segment.position[2] - wreck.centre[1],
          );
          expect(apart).toBeLessThanOrEqual(wreck.reach);
          expect(segment.position[1]).toBeGreaterThan(11);
        }
      }
    }
  });
});
