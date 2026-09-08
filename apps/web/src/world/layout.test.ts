import { BATTLES_PER_ROUND } from '@ponswars/shared-types';
import { distance, selectDetail, type LodThresholds } from '@ponswars/world-runtime';
import { describe, expect, it } from 'vitest';
import {
  battlefieldPose,
  cinematicPose,
  GLOBAL_ANCHOR,
  MARKET_CORE,
  SECTOR_ORBIT_RADIUS,
  SECTOR_POSITIONS,
  sectorPose,
  WORLD_BOUNDARY_RADIUS,
} from './layout.js';

const THRESHOLDS: LodThresholds = { full: 320, reduced: 700, silhouette: 2_200 };

describe('world layout', () => {
  it('places one sector per battle', () => {
    // §38.3: five active War Sectors each round, one matchup each.
    expect(SECTOR_POSITIONS).toHaveLength(BATTLES_PER_ROUND);
  });

  it('spaces sectors evenly around the Market Core', () => {
    // §38.2 makes the core the orientation anchor. Uneven spacing would make
    // one sector read as more important than the rest, which §38.3 rules out —
    // sectors are neutral and interchangeable.
    for (const position of SECTOR_POSITIONS) {
      const radius = Math.hypot(position.x, position.z);
      expect(radius).toBeCloseTo(SECTOR_ORBIT_RADIUS, 6);
    }

    const headings = SECTOR_POSITIONS.map((p) => Math.atan2(p.z, p.x)).sort((a, b) => a - b);
    for (let i = 1; i < headings.length; i += 1) {
      const gap = (headings[i] ?? 0) - (headings[i - 1] ?? 0);
      expect(gap).toBeCloseTo((Math.PI * 2) / BATTLES_PER_ROUND, 6);
    }
  });

  it('varies sector height so the ring reads as terrain', () => {
    // §38.9 asks for verticality. Five points at one altitude read as a dial
    // rather than a place.
    expect(new Set(SECTOR_POSITIONS.map((p) => p.y)).size).toBeGreaterThan(1);
  });

  it('keeps every sector inside the world boundary', () => {
    // §38.8 and §81.4: the boundary exists so free navigation cannot leave a
    // player lost. A sector outside it would be unreachable without fighting
    // the resistance.
    for (const position of SECTOR_POSITIONS) {
      expect(distance(position, MARKET_CORE)).toBeLessThan(WORLD_BOUNDARY_RADIUS);
    }
  });
});

describe('camera poses', () => {
  it('descends through the three spatial levels', () => {
    // §37.2: global, sector, battlefield, cinematic. Each is closer than the
    // last, or the levels would not be levels.
    for (let index = 0; index < BATTLES_PER_ROUND; index += 1) {
      const sector = sectorPose(index);
      const battlefield = battlefieldPose(index);
      const cinematic = cinematicPose(index);

      const sectorRange = distance(sector.position, sector.target);
      const battlefieldRange = distance(battlefield.position, battlefield.target);
      const cinematicRange = distance(cinematic.position, cinematic.target);

      expect(battlefieldRange).toBeLessThan(sectorRange);
      expect(cinematicRange).toBeLessThan(battlefieldRange);
    }
  });

  it('looks at the sector it is focusing', () => {
    // §36.2: both staging areas readable, frontline always understandable. A
    // camera aimed anywhere else would lose the thing it flew there to show.
    for (let index = 0; index < BATTLES_PER_ROUND; index += 1) {
      expect(sectorPose(index).target).toEqual(SECTOR_POSITIONS[index]);
      expect(battlefieldPose(index).target).toEqual(SECTOR_POSITIONS[index]);
    }
  });

  it('stays above the sector at every level', () => {
    // §36.2 wants an elevated 3/4 view with enough tilt to read terrain depth.
    // A camera at or below platform height would lose the frontline entirely.
    for (let index = 0; index < BATTLES_PER_ROUND; index += 1) {
      const sector = SECTOR_POSITIONS[index];
      expect(sector).toBeDefined();
      expect(sectorPose(index).position.y).toBeGreaterThan(sector!.y);
      expect(battlefieldPose(index).position.y).toBeGreaterThan(sector!.y);
      expect(cinematicPose(index).position.y).toBeGreaterThan(sector!.y);
    }
  });

  it('rejects a sector that does not exist', () => {
    expect(() => sectorPose(BATTLES_PER_ROUND)).toThrow(RangeError);
    expect(() => battlefieldPose(-1)).toThrow(RangeError);
  });
});

describe('the global anchor', () => {
  it('sees the whole world', () => {
    // §37.2 level one shows the complete world with all five sectors. Every one
    // must be inside the fog and within a sane distance of the camera.
    for (const position of SECTOR_POSITIONS) {
      expect(distance(GLOBAL_ANCHOR.position, position)).toBeLessThan(2_000);
    }
  });

  it('looks at the Market Core', () => {
    // §38.2: the core is the navigation and orientation anchor, so RESET VIEW
    // returns to a view centred on it.
    expect(GLOBAL_ANCHOR.target).toEqual(MARKET_CORE);
  });

  it('sits inside the boundary', () => {
    expect(distance(GLOBAL_ANCHOR.position, MARKET_CORE)).toBeLessThan(WORLD_BOUNDARY_RADIUS);
  });
});

describe('level of detail across the layout', () => {
  it('keeps distant sectors alive rather than culled at the global view', () => {
    // §37.10 wants distant battles simplified, and §42.3 wants other battles
    // *visibly alive at distance*. Culling them at the default view would make
    // the world look empty from the one place it should look full.
    for (const position of SECTOR_POSITIONS) {
      const detail = selectDetail({
        camera: GLOBAL_ANCHOR,
        sectorPosition: position,
        isFocused: false,
        thresholds: THRESHOLDS,
        tier: 'BALANCED',
      });
      expect(detail).not.toBe('CULLED');
    }
  });

  it('gives the approached sector full detail', () => {
    const pose = sectorPose(0);
    const sector = SECTOR_POSITIONS[0];
    expect(sector).toBeDefined();

    expect(
      selectDetail({
        camera: pose,
        sectorPosition: sector!,
        isFocused: false,
        thresholds: THRESHOLDS,
        tier: 'BALANCED',
      }),
    ).toBe('FULL');
  });

  it('simplifies the far side of the ring when the camera is at a sector', () => {
    // The behaviour §37.10 calls a required performance architecture: standing
    // in one sector, the opposite one should cost less to draw.
    const pose = sectorPose(0);
    const opposite = SECTOR_POSITIONS[2];
    expect(opposite).toBeDefined();

    const detail = selectDetail({
      camera: pose,
      sectorPosition: opposite!,
      isFocused: false,
      thresholds: THRESHOLDS,
      tier: 'BALANCED',
    });
    expect(['REDUCED', 'SILHOUETTE']).toContain(detail);
  });
});
