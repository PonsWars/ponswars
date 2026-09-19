import { describe, expect, it } from 'vitest';
import {
  BATTLE_GROUND,
  clearOfBattle,
  DECK_RADIUS,
  DISTRICT_GROUND,
  SECTOR_IDENTITY_NAMES,
  sectorIdentity,
} from './sector-identity.js';
import {
  LANDMARK_ANGLES,
  LANDMARK_MAX_HEIGHT,
  LANDMARK_RADIUS,
  landmarkFor,
  landmarkFootprints,
  landmarkPlacement,
  type LandmarkPart,
} from './sector-landmark.js';

/**
 * The structure that tells a sector apart from across the world (§38.4, §36.7).
 */

const SECTORS = [0, 1, 2, 3, 4];

/** The landmark a sector raises, through its identity. */
const landmarkOf = (index: number) => landmarkFor(sectorIdentity(index).name);

/** The tallest point of a structure, and how far it reaches from its centre. */
function topOf(parts: readonly LandmarkPart[]): number {
  return Math.max(...parts.map((part) => part.position[1] + part.size[1] / 2));
}

function reachOf(parts: readonly LandmarkPart[]): number {
  return Math.max(
    ...parts.map(
      (part) =>
        Math.hypot(part.position[0], part.position[2]) + Math.hypot(part.size[0], part.size[2]) / 2,
    ),
  );
}

describe('a sector seen from across the world', () => {
  it('gives each of the five its own silhouette (§36.7)', () => {
    // Colour is never the identity, and neither is a label: five islands that
    // differ only in the terrain under the city are five of the same island
    // from the level a player picks a battle at.
    const shapes = SECTORS.map((index) =>
      landmarkOf(index)
        .parts.map((part) => `${part.shape}:${part.size.join(',')}:${part.position.join(',')}`)
        .join('|'),
    );
    expect(new Set(shapes).size).toBe(SECTORS.length);
  });

  it('names what it is', () => {
    for (const index of SECTORS) {
      expect(landmarkOf(index).description).toMatch(/^[A-Z][a-z]/);
    }
  });

  it('is the same structure every round', () => {
    expect(landmarkOf(3)).toEqual(landmarkOf(3));
    expect(landmarkOf(3)).not.toEqual(landmarkOf(4));
  });

  it('keeps every sector within a hand of the others in height (§36.9)', () => {
    const tops = SECTORS.map((index) => topOf(landmarkOf(index).parts));
    for (const top of tops) {
      expect(top).toBeLessThanOrEqual(LANDMARK_MAX_HEIGHT);
      // Tall enough to read as the island's landmark from the global view.
      expect(top).toBeGreaterThan(30);
    }
    expect(Math.max(...tops)).toBeLessThan(Math.min(...tops) * 2);
  });

  it('stands taller than the city it stands in', () => {
    // The rim city tops out at 22 plus a tier.
    for (const index of SECTORS) {
      expect(topOf(landmarkOf(index).parts)).toBeGreaterThan(34);
    }
  });

  it('carries a working light, and never a faction accent (§38.3)', () => {
    for (const index of SECTORS) {
      const parts = landmarkOf(index).parts;
      expect(parts.some((part) => part.material === 'signal')).toBe(true);
      for (const part of parts) {
        expect(['hull', 'dark', 'signal']).toContain(part.material);
      }
    }
  });

  it('stays inside the footprint its placement is checked against', () => {
    for (const index of SECTORS) {
      expect(reachOf(landmarkOf(index).parts)).toBeLessThanOrEqual(LANDMARK_RADIUS);
    }
  });
});

describe('where a landmark stands', () => {
  it('is clear of the battle, on the deck, and on the far half', () => {
    for (const angle of LANDMARK_ANGLES) {
      const { position } = landmarkPlacement(angle);
      // Through the terrain's own keep-out rule, at the landmark's full reach.
      expect(
        clearOfBattle({
          position,
          size: [LANDMARK_RADIUS * 2, 1, LANDMARK_RADIUS * 2],
          rotation: angle,
          tone: 0,
          lit: false,
        }),
      ).toBe(true);
      expect(Math.hypot(position[0], position[2]) + LANDMARK_RADIUS).toBeLessThanOrEqual(
        DECK_RADIUS,
      );
      // Never between a battlefield camera and the ground the battle is on.
      expect(position[2]).toBeLessThan(0);
      // Clear of the district's ground in depth as well as in x.
      const intoDistrict = Math.hypot(
        Math.max(
          DISTRICT_GROUND.innerX - Math.abs(position[0]),
          Math.abs(position[0]) - DISTRICT_GROUND.outerX,
          0,
        ),
        Math.max(Math.abs(position[2]) - DISTRICT_GROUND.halfDepth, 0),
      );
      expect(intoDistrict).toBeGreaterThan(LANDMARK_RADIUS);
      expect(Math.abs(position[2])).toBeGreaterThan(BATTLE_GROUND.halfDepth / 2);
    }
  });

  it('keeps off the terrain the identity puts on the same rim', () => {
    for (const index of SECTORS) {
      for (const angle of LANDMARK_ANGLES) {
        const { position } = landmarkPlacement(angle);
        for (const block of sectorIdentity(index).blocks) {
          const apart = Math.hypot(
            position[0] - block.position[0],
            position[2] - block.position[2],
          );
          expect(apart).toBeGreaterThan(
            LANDMARK_RADIUS + Math.hypot(block.size[0], block.size[2]) / 2,
          );
        }
      }
    }
  });

  it('is given its ground by the terrain, measured from the footprints', () => {
    // The rim a landmark stands on is the rim the identity fills, and the
    // landmark wins: it is two places on an island against eight to twenty.
    for (const index of SECTORS) {
      for (const spot of landmarkFootprints()) {
        for (const block of sectorIdentity(index).blocks) {
          const apart = Math.hypot(block.position[0] - spot.x, block.position[2] - spot.z);
          expect(apart).toBeGreaterThan(spot.radius + Math.hypot(block.size[0], block.size[2]) / 2);
        }
      }
    }
  });

  it('leaves each identity enough terrain to still be itself', () => {
    // Giving the landmarks their ground must not empty a sector.
    for (const index of SECTORS) {
      expect(sectorIdentity(index).blocks.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('gives every identity a landmark of its own', () => {
    for (const name of SECTOR_IDENTITY_NAMES) {
      expect(landmarkFor(name).parts.length).toBeGreaterThan(2);
    }
  });

  it('raises a pair, one either side of the flank', () => {
    expect(LANDMARK_ANGLES).toHaveLength(2);
    const [first, second] = LANDMARK_ANGLES;
    expect(landmarkPlacement(first).position[0]).toBeGreaterThan(0);
    expect(landmarkPlacement(second).position[0]).toBeLessThan(0);
  });
});
