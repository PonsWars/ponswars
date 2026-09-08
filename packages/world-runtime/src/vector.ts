/**
 * Minimal 3D vector maths.
 *
 * Deliberately not Three.js. This package holds the camera *decisions* — where
 * to go, how far along a move is, which detail level applies — and those need to
 * run in a test, in a replay and on a server that has no WebGL context. The
 * rendering layer converts these to `THREE.Vector3` at the boundary.
 *
 * Plain `number` throughout: a camera position is presentation, not money and
 * not part of a result, so ADR 0003's integer rule does not apply here.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(v: Vec3, factor: number): Vec3 {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor };
}

export function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function distance(a: Vec3, b: Vec3): number {
  return length(subtract(a, b));
}

/** Linear interpolation. `t` outside `[0, 1]` extrapolates; callers clamp first. */
export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/**
 * Unit vector in the same direction.
 *
 * Returns {@link ORIGIN} for a zero-length input rather than a vector of `NaN`.
 * A degenerate camera basis — position exactly on its own target — is a state
 * the caller has to handle either way, and silently poisoning every later
 * coordinate with `NaN` makes it far harder to see where it began.
 */
export function normalize(v: Vec3): Vec3 {
  const magnitude = length(v);
  return magnitude === 0 ? ORIGIN : scale(v, 1 / magnitude);
}

export function equals(a: Vec3, b: Vec3, epsilon = 1e-9): boolean {
  return (
    Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon && Math.abs(a.z - b.z) < epsilon
  );
}

/**
 * Smoothstep easing: `3t² − 2t³`.
 *
 * §37.5 requires *"believable acceleration, easing, inertia, and deceleration"*
 * and forbids instant teleport cuts outside reduced-motion. Smoothstep gives
 * zero velocity at both ends, so a camera move starts and stops gently rather
 * than snapping into place.
 *
 * A polynomial rather than a trigonometric ease, for the same reason ADR 0005
 * rejected `tanh`: it is exact, cheap, and identical in every runtime.
 */
export function smoothstep(t: number): number {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * Constrains a position to a sphere around the world centre, with give.
 *
 * §37.7 and §81.4 ask for *"soft camera resistance rather than a harsh invisible
 * wall"*. Past the boundary the camera keeps moving but at a fraction of the
 * requested distance, so pushing outward feels heavy rather than blocked — and
 * §37.7's promise that free navigation never leaves the user permanently lost
 * holds without a hard stop anyone can collide with.
 */
export function applySoftBoundary(position: Vec3, radius: number, resistance = 0.25): Vec3 {
  if (radius <= 0) {
    throw new RangeError('World boundary radius must be positive');
  }
  if (resistance <= 0 || resistance > 1) {
    throw new RangeError('Boundary resistance must be within (0, 1]');
  }

  const from = length(position);
  if (from <= radius) {
    return position;
  }

  const allowed = radius + (from - radius) * resistance;
  return scale(position, allowed / from);
}
