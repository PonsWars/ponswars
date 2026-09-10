import { BATTLES_PER_ROUND } from '@ponswars/shared-types';
import {
  vec3,
  type CameraMode,
  type CameraPose,
  type LodThresholds,
  type Vec3,
} from '@ponswars/world-runtime';

/**
 * The physical layout of the world (§38).
 *
 * One floating market-war continent in a dark void, with the Market Core at its
 * centre and five neutral War Sectors around it. Not Earth, not a map, not a
 * planet (§38.1).
 *
 * Pure geometry, separate from the scene components, so the camera poses a
 * fly-to targets can be asserted without rendering anything.
 */

/** Radius the sectors sit at, in world units. */
export const SECTOR_ORBIT_RADIUS = 420;

/** Soft boundary the camera resists past (§38.8, §81.4). */
export const WORLD_BOUNDARY_RADIUS = 2_400;

/** The Market Core: central landmark, routing centre, orientation anchor (§38.2). */
export const MARKET_CORE: Vec3 = vec3(0, 0, 0);

/**
 * Where each sector sits.
 *
 * Five positions evenly around the core. §38.4 wants sectors *"spatially
 * memorable"* with *"geometry stable enough for orientation across rounds"* —
 * so the positions are fixed and only the factions occupying them change.
 * §38.3 is the other half of that: sectors are neutral, and no faction owns one.
 *
 * Heights vary slightly. §38.9 asks for verticality through plateaus and raised
 * structures, and five points at identical altitude would read as a dial rather
 * than a place.
 */
export const SECTOR_POSITIONS: readonly Vec3[] = Array.from(
  { length: BATTLES_PER_ROUND },
  (_, index) => {
    const angle = (index / BATTLES_PER_ROUND) * Math.PI * 2;
    // A fixed offset so no sector sits directly behind the core from the
    // default camera, which would hide it at the global view.
    const heading = angle + Math.PI / 10;
    return vec3(
      Math.cos(heading) * SECTOR_ORBIT_RADIUS,
      // Alternating low ridges, so the ring reads as terrain rather than a dial.
      index % 2 === 0 ? 0 : -18,
      Math.sin(heading) * SECTOR_ORBIT_RADIUS,
    );
  },
);

/**
 * LOD distances.
 *
 * `OPEN` production tuning (§59.4), and a statement about two views at once.
 *
 * From the global anchor the five sectors are 910 to 1 490 units away, so every
 * one of them is reduced: built, lit and legible, but not carrying a full
 * district each. From `sectorPose` the sector a player flew to is 414 away and
 * the far side of the ring is over 1 100 — which is §37.10's required
 * behaviour, that standing in one sector costs less to draw the opposite one.
 *
 * Both earlier settings failed one of those. The first was tuned when a sector
 * was a disc and two boxes and put every sector at silhouette from the one
 * position a player starts at: the world degraded before anyone had seen it
 * undegraded. Raising it fixed that view and quietly broke the other — nothing
 * was ever reduced from anywhere, so §37.10 was not happening at all.
 *
 * It lives beside the poses because it is a statement about them: the sector a
 * player has flown to must be at full detail from `sectorPose`, and the far
 * side of the ring must not be. It used to sit in the scene with the tests
 * carrying a second set of numbers, so moving a pose could silently drop the
 * approached sector to reduced detail and the test would still pass against
 * thresholds nothing shipped with.
 */
export const LOD_THRESHOLDS: LodThresholds = { full: 700, reduced: 2_000, silhouette: 3_600 };

/**
 * How big a sector island is.
 *
 * The camera and the scene both need this and used to state it separately: the
 * platform was a `120` in a cylinder argument, and the poses were offsets
 * chosen by eye against the four boxes that stood on it. When the islands grew
 * a skyline the battlefield pose ended up *inside* one, looking at the wall of
 * a building — and nothing failed, because nothing knew the two facts were the
 * same fact.
 *
 * They are one description now. The scene builds to these and the camera keeps
 * clear of them.
 */
export const SECTOR_ISLAND_RADIUS = 120;

/** The height of the plateau's own surface, above the sector origin. */
export const SECTOR_PLATFORM_TOP = 11;

/** The highest anything on a sector stands, above the sector origin. */
export const SECTOR_SKYLINE_HEIGHT = 100;

/**
 * The global anchor `RESET VIEW` returns to (§37.7, §81.4).
 *
 * High and pulled back, so all five sectors and the Market Core are readable at
 * once — §37.2 level one shows the complete world.
 */
export const GLOBAL_ANCHOR: CameraPose = {
  position: vec3(0, 760, 900),
  target: MARKET_CORE,
};

/**
 * The anchor a page presented *over* the world is framed against (§81.2).
 *
 * `PROFILE_PRESENTATION` is the mode for a surface layered on the world rather
 * than one inside it — the landing, the about page, the war room. Every one of
 * those puts a column of copy down the left of the frame, and against the
 * global anchor the world sits dead centre: the copy lands on top of the thing
 * it is describing.
 *
 * Same place, different framing. The camera stands where it always does and
 * looks left of the core, which slides the world to the right of the frame and
 * leaves the left side to the page. §2.1 keeps the world the hero even on the
 * pages that are not it, and a world hidden behind a panel is not the hero of
 * anything.
 */
export const PRESENTATION_ANCHOR: CameraPose = {
  // Further out than the global anchor, not just turned: a yaw alone swings the
  // near sectors off the edge of the frame, and a world with two islands
  // cropped by the window is a worse hero than a small one.
  position: vec3(0, 800, 1_260),
  // Left of the core and above it: aiming left moves the world right, aiming
  // high moves it down, and the two together clear the top-left corner where
  // the navigation bar and the headline sit.
  target: vec3(-230, 130, 0),
};

function sectorAt(index: number): Vec3 {
  const position = SECTOR_POSITIONS[index];
  if (position === undefined) {
    throw new RangeError(`No sector at index ${String(index)}`);
  }
  return position;
}

/**
 * How far a sector island is turned about its own axis (§36.2, §36.15).
 *
 * The two districts sit either side of the island's local x axis, and every
 * camera that flies to a sector approaches along the radius from the Market
 * Core. Unrotated, those two directions agreed only by accident: on most
 * sectors the camera looked *along* the axis between the districts, so one army
 * stood behind the other and the frontline ran across the view rather than into
 * it.
 *
 * Turning the local x axis onto the tangent puts the two sides left and right
 * of the frame on every sector, with the line between them running away from
 * the camera — the arrangement every delivered sector frame is drawn from.
 *
 * **Which** side lands where is the part that took two attempts. A rotation of
 * `-(heading + π/2)` also puts the districts across the frame, and puts them
 * across it the wrong way round: `side: -1` carries `battle.left`, the intel
 * panel for `battle.left` is pinned to the left of the screen, and the district
 * ended up on the right. §36.15 asks a player to read who holds what instantly,
 * and a world that disagrees with the panel naming it is the opposite of that.
 * `layout.test.ts` pins the frame side each army lands on.
 */
export function sectorSpin(index: number): number {
  const sector = sectorAt(index);
  return -(Math.atan2(sector.z, sector.x) - Math.PI / 2);
}

/**
 * Camera pose for approaching a sector (§37.2 level two).
 *
 * Offset outward from the core so the camera looks *inward* across the sector,
 * which puts both staging areas and the frontline in frame — §36.2 requires the
 * frontline to stay understandable, and §36.15 puts "where the frontline is"
 * among the things a player must grasp instantly.
 */
export function sectorPose(index: number): CameraPose {
  const sector = sectorAt(index);
  const outward = 1 + (SECTOR_ISLAND_RADIUS + 210) / SECTOR_ORBIT_RADIUS;
  return {
    position: vec3(sector.x * outward, sector.y + 250, sector.z * outward),
    target: sector,
  };
}

/**
 * Camera pose for the tactical battlefield view (§37.2 level three).
 *
 * Close enough to read infantry, elites, heavies and drones, still elevated
 * enough to hold the whole frontline — §36.2 calls that the stable strategic
 * camera, and dropping below it would trade readability for spectacle.
 */
export function battlefieldPose(index: number): CameraPose {
  const sector = sectorAt(index);
  // Outside the rim, not over it. At 62 units out this stood in the middle of
  // the island — fine when a sector was a disc with four boxes on it, and a
  // view of the inside of a tower once it had a skyline.
  const outward = 1 + (SECTOR_ISLAND_RADIUS + 120) / SECTOR_ORBIT_RADIUS;
  return {
    // Low enough to be under the skyline in feel and just above it in fact:
    // both districts have to fit the frame, and a steeper look-down puts the
    // far one's towers off the top of it.
    position: vec3(sector.x * outward, sector.y + 110, sector.z * outward),
    target: sector,
  };
}

/**
 * Camera pose for a cinematic close-up (§37.2 level four).
 *
 * Always temporary. The caller pairs it with a restore pose so control returns
 * to a readable tactical view.
 */
export function cinematicPose(index: number): CameraPose {
  const sector = sectorAt(index);
  // Just past the rim and low, so the shot looks along the contested ground
  // with the two skylines rising on either side. Still outside the island: a
  // dramatic angle is one thing, a camera inside a building is another.
  const outward = 1 + (SECTOR_ISLAND_RADIUS + 12) / SECTOR_ORBIT_RADIUS;
  return {
    position: vec3(sector.x * outward, sector.y + 62, sector.z * outward),
    target: sector,
  };
}

/**
 * The pose a camera mode corresponds to, given the sector currently in focus.
 *
 * `stepOutward` in `@ponswars/world-runtime` decides *which* level `ESC` leads
 * to; the geometry of that level lives here. The runtime holds decisions, the
 * app holds the world.
 *
 * Returns `null` when a level needs a sector and none is focused, which the
 * runtime reads as "stay put" rather than guessing at a sector the player never
 * chose.
 */
export function poseForMode(mode: CameraMode, sectorIndex: number | null): CameraPose | null {
  switch (mode) {
    case 'GLOBAL_FREE':
    case 'GLOBAL_FOCUS':
    case 'RESETTING':
      return GLOBAL_ANCHOR;
    case 'PROFILE_PRESENTATION':
      return PRESENTATION_ANCHOR;
    case 'SECTOR_FOCUS':
      return sectorIndex === null ? null : sectorPose(sectorIndex);
    case 'BATTLE_TACTICAL':
      return sectorIndex === null ? null : battlefieldPose(sectorIndex);
    case 'CINEMATIC_TEMP':
      return sectorIndex === null ? null : cinematicPose(sectorIndex);
  }
}
