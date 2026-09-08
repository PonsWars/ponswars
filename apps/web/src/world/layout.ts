import { BATTLES_PER_ROUND } from '@ponswars/shared-types';
import { vec3, type CameraMode, type CameraPose, type Vec3 } from '@ponswars/world-runtime';

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
 * The global anchor `RESET VIEW` returns to (§37.7, §81.4).
 *
 * High and pulled back, so all five sectors and the Market Core are readable at
 * once — §37.2 level one shows the complete world.
 */
export const GLOBAL_ANCHOR: CameraPose = {
  position: vec3(0, 760, 900),
  target: MARKET_CORE,
};

function sectorAt(index: number): Vec3 {
  const position = SECTOR_POSITIONS[index];
  if (position === undefined) {
    throw new RangeError(`No sector at index ${String(index)}`);
  }
  return position;
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
  const outward = 1 + 190 / SECTOR_ORBIT_RADIUS;
  return {
    position: vec3(sector.x * outward, sector.y + 165, sector.z * outward),
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
  const outward = 1 + 62 / SECTOR_ORBIT_RADIUS;
  return {
    position: vec3(sector.x * outward, sector.y + 58, sector.z * outward),
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
  const outward = 1 + 24 / SECTOR_ORBIT_RADIUS;
  return {
    position: vec3(sector.x * outward, sector.y + 20, sector.z * outward),
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
    case 'PROFILE_PRESENTATION':
    case 'RESETTING':
      return GLOBAL_ANCHOR;
    case 'SECTOR_FOCUS':
      return sectorIndex === null ? null : sectorPose(sectorIndex);
    case 'BATTLE_TACTICAL':
      return sectorIndex === null ? null : battlefieldPose(sectorIndex);
    case 'CINEMATIC_TEMP':
      return sectorIndex === null ? null : cinematicPose(sectorIndex);
  }
}
