/**
 * Where the world's air traffic flies (§38.6, §36.14).
 *
 * The routes carry one ship each, core to sector. Every delivered world frame
 * has far more in the air than that — craft crossing between islands at
 * different heights, some near, some far — and a sky with five ships on five
 * straight lines reads as a diagram of traffic rather than as traffic.
 *
 * Each ship flies a tilted ellipse round the core. Pure, seeded, and a function
 * of time, so a ship is always where the clock says it is: nothing accumulates
 * frame to frame, and a dropped frame moves it further along the same path.
 */

export interface FlightPath {
  /** Semi-axes of the ellipse, in world units. */
  readonly radiusX: number;
  readonly radiusZ: number;
  /** How far the ellipse is turned about the vertical. */
  readonly turn: number;
  /** Mean altitude, and how far the path rises and falls round the loop. */
  readonly height: number;
  readonly climb: number;
  /** Radians per second, signed: some fly one way round, some the other. */
  readonly speed: number;
  /** Where on the loop the ship is at time zero. */
  readonly phase: number;
}

export interface FlightState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The direction of travel, as a yaw about the vertical. */
  readonly heading: number;
}

function generator(seed: number): () => number {
  let state = (seed * 2_654_435_761) >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/**
 * The height band traffic keeps to.
 *
 * Over the tallest thing on a sector (its skyline stands 100 above the sector)
 * and below the core's beacon (208), so a ship never flies through a tower, and
 * never across the one light the eye returns to.
 */
export const TRAFFIC_BAND = { low: 130, high: 190 } as const;

/** Closest a path comes to the core, so no ship threads the citadel's spires. */
export const TRAFFIC_INNER = 220;

export function flightPaths(seed: number, count: number): FlightPath[] {
  const random = generator(seed);
  return Array.from({ length: Math.max(count, 0) }, () => {
    const radiusX = TRAFFIC_INNER + random() * 700;
    const radiusZ = TRAFFIC_INNER + random() * 700;
    const climb = random() * 12;
    return {
      radiusX,
      radiusZ,
      turn: random() * Math.PI,
      height:
        TRAFFIC_BAND.low + climb + random() * (TRAFFIC_BAND.high - TRAFFIC_BAND.low - climb * 2),
      climb,
      // Slower the further out, so the far ships drift and the near ones pass.
      speed: ((random() < 0.5 ? -1 : 1) * (18 + random() * 14)) / Math.max(radiusX, radiusZ),
      phase: random() * Math.PI * 2,
    };
  });
}

export function flightAt(path: FlightPath, seconds: number): FlightState {
  const angle = path.phase + path.speed * seconds;
  const localX = Math.cos(angle) * path.radiusX;
  const localZ = Math.sin(angle) * path.radiusZ;
  // Velocity along the ellipse, before the turn.
  const velocityX = -Math.sin(angle) * path.radiusX * path.speed;
  const velocityZ = Math.cos(angle) * path.radiusZ * path.speed;

  const cos = Math.cos(path.turn);
  const sin = Math.sin(path.turn);
  const x = localX * cos - localZ * sin;
  const z = localX * sin + localZ * cos;
  const vx = velocityX * cos - velocityZ * sin;
  const vz = velocityX * sin + velocityZ * cos;

  return {
    x,
    y: path.height + Math.sin(angle * 2) * path.climb,
    z,
    // The same convention the routes use: a hull faces +z, turned by atan2(x, z).
    heading: Math.atan2(vx, vz),
  };
}
