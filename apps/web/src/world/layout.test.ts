import { BATTLES_PER_ROUND } from '@ponswars/shared-types';
import { distance, selectDetail } from '@ponswars/world-runtime';
import { describe, expect, it } from 'vitest';
import {
  battlefieldPose,
  cinematicPose,
  GLOBAL_ANCHOR,
  LOD_THRESHOLDS,
  MARKET_CORE,
  poseForMode,
  PRESENTATION_ANCHOR,
  SECTOR_ISLAND_RADIUS,
  SECTOR_ORBIT_RADIUS,
  SECTOR_POSITIONS,
  sectorPose,
  sectorSpin,
  SECTOR_SKYLINE_HEIGHT,
  WORLD_BOUNDARY_RADIUS,
} from './layout.js';

// The thresholds the app ships with, not a second set written for the tests:
// the point of these assertions is that the poses and the detail selection
// agree, and they cannot disagree usefully against numbers nothing renders at.
const THRESHOLDS = LOD_THRESHOLDS;

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

  it('never stands inside the island it is looking at', () => {
    // The failure this exists for: the districts grew a skyline, the
    // battlefield pose stayed where it was, and flying to a battle put the
    // camera in the middle of a building. Every level of §37.2 has to be a
    // readable view of the sector, and a camera inside the geometry is not a
    // view of anything.
    for (let index = 0; index < BATTLES_PER_ROUND; index += 1) {
      const sector = SECTOR_POSITIONS[index];
      expect(sector).toBeDefined();
      for (const pose of [sectorPose(index), battlefieldPose(index), cinematicPose(index)]) {
        const horizontal = Math.hypot(
          pose.position.x - (sector?.x ?? 0),
          pose.position.z - (sector?.z ?? 0),
        );
        expect(horizontal).toBeGreaterThan(SECTOR_ISLAND_RADIUS);
      }
    }
  });

  it('clears the skyline or stands well outside it', () => {
    // Being outside the rim is not enough on its own if the pose sits level
    // with the tops of the towers at the near edge: the shot fills with the
    // first building. Each level either looks down over the skyline or stands
    // back far enough to see past it.
    for (let index = 0; index < BATTLES_PER_ROUND; index += 1) {
      const sector = SECTOR_POSITIONS[index];
      expect(sector).toBeDefined();
      for (const pose of [sectorPose(index), battlefieldPose(index)]) {
        expect(pose.position.y - (sector?.y ?? 0)).toBeGreaterThan(SECTOR_SKYLINE_HEIGHT);
      }
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

describe('the presentation anchor', () => {
  it('still sees the whole world', () => {
    // It is a reframing, not a different place: a page presented over the
    // world that reframed to something a sector had fallen out of would be
    // showing a smaller world than the one behind it (§37.2 level one).
    for (const position of SECTOR_POSITIONS) {
      expect(distance(PRESENTATION_ANCHOR.position, position)).toBeLessThan(2_000);
    }
  });

  it('looks left of the core, so the world sits right of the page', () => {
    // The whole reason it exists. Aiming at or right of the core would put the
    // world back under the column of copy every presented page carries down
    // its left side, which is the thing this anchor is here to stop.
    expect(PRESENTATION_ANCHOR.target.x).toBeLessThan(MARKET_CORE.x);
  });

  it('is the pose the presentation mode resolves to', () => {
    // §81.2 names the mode; if it resolved to the global anchor the mode would
    // be a label with no framing behind it, which is what it was.
    expect(poseForMode('PROFILE_PRESENTATION', null)).toEqual(PRESENTATION_ANCHOR);
    expect(poseForMode('GLOBAL_FREE', null)).toEqual(GLOBAL_ANCHOR);
  });

  it('sits inside the boundary', () => {
    expect(distance(PRESENTATION_ANCHOR.position, MARKET_CORE)).toBeLessThan(WORLD_BOUNDARY_RADIUS);
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

describe('which side of the frame an army lands on', () => {
  /**
   * §36.2 and §36.15.
   *
   * A sector draws `battle.left` at `side: -1` and the HUD pins that faction's
   * intel panel to the left of the screen. The two have to agree: a player
   * reading "NVDA — FAVORED" on the left and seeing NVDA's colours on the right
   * is being asked to hold a mirror in their head while a round is running.
   *
   * This is arithmetic, not a screenshot, so it can be checked on every commit:
   * turn the district's local offset by the island's spin, and compare it with
   * the camera's own right vector at the pose that looks at that island.
   */

  /** Where a district at local `side * 62` ends up in the world. */
  function districtDirection(index: number, side: -1 | 1): { x: number; z: number } {
    const spin = sectorSpin(index);
    // A rotation about Y maps local (1, 0, 0) to (cos, 0, -sin).
    return { x: side * Math.cos(spin), z: side * -Math.sin(spin) };
  }

  /**
   * The camera's right vector, the way three.js builds one.
   *
   * `x = normalize(cross(up, position - target))`, with up as world up. Written
   * out rather than imported so the test does not depend on the renderer to
   * describe what a viewer sees.
   */
  function cameraRight(pose: ReturnType<typeof battlefieldPose>): { x: number; z: number } {
    const backward = {
      x: pose.position.x - pose.target.x,
      z: pose.position.z - pose.target.z,
    };
    // cross((0,1,0), (bx, by, bz)) = (bz, 0, -bx)
    const right = { x: backward.z, z: -backward.x };
    const length = Math.hypot(right.x, right.z) || 1;
    return { x: right.x / length, z: right.z / length };
  }

  for (const view of ['sector', 'battlefield'] as const) {
    it(`puts battle.left on the left of the ${view} view, on every sector`, () => {
      for (let index = 0; index < BATTLES_PER_ROUND; index += 1) {
        const pose = view === 'sector' ? sectorPose(index) : battlefieldPose(index);
        const right = cameraRight(pose);

        // `side: -1` carries `battle.left`. Negative agreement with the
        // camera's right vector is the left of the frame.
        const left = districtDirection(index, -1);
        expect(left.x * right.x + left.z * right.z).toBeLessThan(-0.9);

        const other = districtDirection(index, 1);
        expect(other.x * right.x + other.z * right.z).toBeGreaterThan(0.9);
      }
    });
  }

  it('lays both districts across the view rather than one behind the other', () => {
    // The reason the islands are turned at all. Along the camera's own axis the
    // two staging areas would overlap, and §36.2 wants both readable.
    for (let index = 0; index < BATTLES_PER_ROUND; index += 1) {
      const pose = battlefieldPose(index);
      const forward = {
        x: pose.target.x - pose.position.x,
        z: pose.target.z - pose.position.z,
      };
      const length = Math.hypot(forward.x, forward.z) || 1;
      const district = districtDirection(index, 1);
      const alongView = (district.x * forward.x + district.z * forward.z) / length;

      expect(Math.abs(alongView)).toBeLessThan(0.2);
    }
  });
});
