import type { DurationMs, UtcTimestamp } from '@ponswars/shared-types';
import {
  flyTo,
  type CameraConfig,
  type CameraMode,
  type CameraPose,
  type CameraState,
} from './camera.js';
import {
  add,
  applySoftBoundary,
  cross,
  distance,
  length,
  normalize,
  scale,
  subtract,
  vec3,
  type Vec3,
} from './vector.js';

/**
 * Direct camera navigation (§37.3 desktop, §37.4 mobile).
 *
 * Pure reducers over an explicit timestamp, for the same reason every other
 * reducer in this repo is: the camera has to behave identically in a test, in a
 * replay and on a device that drops frames. Nothing here reads a clock, touches
 * the DOM or knows what a pointer event is — the React binding converts events
 * into these calls at the boundary.
 *
 * Desktop and mobile share these reducers. §37.3 and §37.4 describe one set of
 * behaviours reached by different inputs — left drag and one-finger drag are
 * both a pan, wheel and pinch are both a zoom — so implementing them twice
 * would only be two chances for the two platforms to drift apart.
 */

/** The world's vertical axis. The world is a ground plane with a sky above it. */
const WORLD_UP: Vec3 = vec3(0, 1, 0);

/** Fallback right vector when the camera looks straight down (§37.2 global view). */
const FALLBACK_RIGHT: Vec3 = vec3(1, 0, 0);

/** Shared zero drift. `Vec3` is readonly, so one value is safe to reuse. */
const NO_DRIFT: Vec3 = vec3(0, 0, 0);

export interface NavigationConfig {
  /** Closest the camera may come to its target. Stops it clipping through geometry. */
  readonly minViewDistance: number;
  /** Furthest the camera may pull back. Beyond this the world is unreadable. */
  readonly maxViewDistance: number;
  /** Multiplier applied per wheel notch (§37.3). */
  readonly zoomStep: number;
  /**
   * Time for drift velocity to halve after a drag is released (§37.5 inertia).
   *
   * A half-life rather than a per-frame damping factor: damping applied per
   * frame makes the glide length depend on the frame rate, so the same flick
   * would travel further on a 120 Hz screen than on a 60 Hz one.
   */
  readonly inertiaHalfLife: DurationMs;
  /** Drift below this speed, in world units per millisecond, is stopped. */
  readonly minDriftSpeed: number;
}

/** A pointer sample. Screen coordinates, because that is what a pointer gives. */
export interface PointerSample {
  readonly x: number;
  readonly y: number;
  readonly at: UtcTimestamp;
}

export interface NavigationState {
  /** The last observed pointer sample, or `null` when no drag is active. */
  readonly drag: PointerSample | null;
  /** Residual drift in world units per millisecond (§37.5). */
  readonly drift: Vec3;
  /** When `drift` was last integrated. */
  readonly driftAt: UtcTimestamp | null;
}

/** No drag, no drift. The state the camera rests in. */
export const IDLE_NAVIGATION: NavigationState = {
  drag: null,
  drift: NO_DRIFT,
  driftAt: null,
};

/** Camera and navigation move together, so the reducers that touch both return both. */
export interface NavigationResult {
  readonly camera: CameraState;
  readonly navigation: NavigationState;
}

/**
 * World units covered by one screen pixel at a given view distance.
 *
 * Derived from the projection rather than tuned by hand, so a dragged point
 * stays under the pointer at every zoom level and on every viewport. A
 * hand-tuned constant is correct at exactly one distance and wrong everywhere
 * else, which is what makes a pan feel slippery.
 */
export function worldUnitsPerPixel(
  viewDistance: number,
  fovRadians: number,
  viewportHeightPx: number,
): number {
  if (viewportHeightPx <= 0) {
    throw new RangeError('Viewport height must be positive');
  }
  if (fovRadians <= 0 || fovRadians >= Math.PI) {
    throw new RangeError('Field of view must be within (0, π)');
  }
  return (2 * viewDistance * Math.tan(fovRadians / 2)) / viewportHeightPx;
}

/**
 * The screen-aligned basis at a pose: the camera's right and up vectors.
 *
 * When the camera looks straight down — the global view of §37.2 — `forward`
 * and world up are parallel and their cross product collapses. Falling back to
 * a fixed axis keeps the pan defined instead of producing a zero vector that
 * would silently freeze dragging at exactly the angle players start from.
 */
export function screenBasis(position: Vec3, target: Vec3): { right: Vec3; up: Vec3 } {
  const forward = normalize(subtract(target, position));
  const rawRight = cross(forward, WORLD_UP);
  const right = length(rawRight) < 1e-6 ? FALLBACK_RIGHT : normalize(rawRight);
  return { right, up: normalize(cross(right, forward)) };
}

/**
 * Starts a drag.
 *
 * Direct camera input cancels an interruptible move (§114.4). An uninterruptible
 * cinematic is left alone — §81.3 lets it hold control briefly, and a stray
 * touch cutting one short would make the moment it exists for unreliable.
 */
export function beginPan(
  camera: CameraState,
  navigation: NavigationState,
  origin: PointerSample,
): NavigationResult {
  if (isLocked(camera)) {
    return { camera, navigation };
  }
  return {
    camera: { ...camera, transition: null },
    navigation: { drag: origin, drift: NO_DRIFT, driftAt: null },
  };
}

/**
 * Continues a drag to a new pointer sample.
 *
 * Pans position and target together, so the camera slides across the world
 * without changing what it is angled at. Drift is measured from the sample
 * interval, so releasing mid-motion glides on (§37.5).
 */
export function panTo(
  camera: CameraState,
  navigation: NavigationState,
  sample: PointerSample,
  perPixel: number,
  cameraConfig: CameraConfig,
): NavigationResult {
  const { drag } = navigation;
  if (drag === null || isLocked(camera)) {
    return { camera, navigation };
  }

  const { right, up } = screenBasis(camera.pose.position, camera.pose.target);
  // Dragging right pulls the world right, which moves the camera left. The sign
  // inversion here is what keeps the point under the pointer under the pointer.
  const delta = add(
    scale(right, -(sample.x - drag.x) * perPixel),
    scale(up, (sample.y - drag.y) * perPixel),
  );

  const elapsed = sample.at - drag.at;
  let drift = navigation.drift;
  if (cameraConfig.reducedMotion) {
    drift = NO_DRIFT;
  } else if (elapsed > 0) {
    drift = scale(delta, 1 / elapsed);
  }
  // A zero or backwards interval measures nothing, so the previous drift stands
  // rather than being replaced by a division by zero.

  return {
    camera: {
      ...camera,
      pose: {
        position: applySoftBoundary(add(camera.pose.position, delta), cameraConfig.boundaryRadius),
        target: add(camera.pose.target, delta),
      },
      transition: null,
    },
    navigation: { drag: sample, drift, driftAt: sample.at },
  };
}

/**
 * Ends a drag, leaving the measured drift to decay.
 *
 * Under reduced motion the camera stops where it was released. §83.3 shortens
 * or disables motion the user did not ask for, and a glide that continues after
 * the finger lifts is exactly that.
 */
export function endPan(
  navigation: NavigationState,
  at: UtcTimestamp,
  cameraConfig: CameraConfig,
): NavigationState {
  if (navigation.drag === null) {
    return navigation;
  }
  if (cameraConfig.reducedMotion) {
    return IDLE_NAVIGATION;
  }
  return { drag: null, drift: navigation.drift, driftAt: at };
}

/**
 * Integrates residual drift up to an instant (§37.5 deceleration).
 *
 * Exact integration of an exponential decay rather than a per-frame multiply:
 * the displacement of `v₀·2^(−t/H)` over `t` is `v₀·H·(1 − 2^(−t/H))/ln 2`. That
 * makes the glide identical whatever the frame rate, and identical again in a
 * test that steps a hundred milliseconds at a time.
 */
export function applyDrift(
  camera: CameraState,
  navigation: NavigationState,
  at: UtcTimestamp,
  cameraConfig: CameraConfig,
  navigationConfig: NavigationConfig,
): NavigationResult {
  const { drift, driftAt } = navigation;
  // A queued fly-to owns the camera. Two things moving it at once would fight.
  if (navigation.drag !== null || driftAt === null || camera.transition !== null) {
    return { camera, navigation };
  }

  const elapsed = at - driftAt;
  if (elapsed <= 0) {
    return { camera, navigation };
  }

  const halfLife = navigationConfig.inertiaHalfLife;
  if (halfLife <= 0) {
    throw new RangeError('Inertia half-life must be positive');
  }

  const remaining = Math.pow(2, -elapsed / halfLife);
  const nextDrift = scale(drift, remaining);
  if (length(nextDrift) < navigationConfig.minDriftSpeed) {
    return { camera, navigation: IDLE_NAVIGATION };
  }

  const travelled = scale(drift, (halfLife * (1 - remaining)) / Math.LN2);
  return {
    camera: {
      ...camera,
      pose: {
        position: applySoftBoundary(
          add(camera.pose.position, travelled),
          cameraConfig.boundaryRadius,
        ),
        target: add(camera.pose.target, travelled),
      },
    },
    navigation: { drag: null, drift: nextDrift, driftAt: at },
  };
}

/**
 * Zooms by a multiplicative factor, holding the look-at target still.
 *
 * `factor < 1` moves in. Multiplicative rather than additive so one notch covers
 * the same proportion of the remaining distance whether the camera is above the
 * whole world or inside a single sector — an additive step is either useless far
 * out or violent up close.
 */
export function zoomBy(
  camera: CameraState,
  factor: number,
  cameraConfig: CameraConfig,
  navigationConfig: NavigationConfig,
): CameraState {
  if (factor <= 0) {
    throw new RangeError('Zoom factor must be positive');
  }
  if (isLocked(camera)) {
    return camera;
  }

  const { position, target } = camera.pose;
  const view = subtract(position, target);
  const current = length(view);
  // A camera sitting exactly on its target has no view direction to scale.
  if (current === 0) {
    return camera;
  }

  const clamped = clamp(
    current * factor,
    navigationConfig.minViewDistance,
    navigationConfig.maxViewDistance,
  );

  return {
    ...camera,
    pose: {
      position: applySoftBoundary(
        add(target, scale(normalize(view), clamped)),
        cameraConfig.boundaryRadius,
      ),
      target,
    },
    transition: null,
  };
}

/** Wheel zoom (§37.3). Positive notches pull back. */
export function zoomByNotches(
  camera: CameraState,
  notches: number,
  cameraConfig: CameraConfig,
  navigationConfig: NavigationConfig,
): CameraState {
  return zoomBy(
    camera,
    Math.pow(1 + navigationConfig.zoomStep, notches),
    cameraConfig,
    navigationConfig,
  );
}

/**
 * Pinch zoom (§37.4). `ratio` is the current finger separation over the initial one.
 *
 * Fingers spreading apart means zooming in, so the view distance moves the other
 * way from the ratio.
 */
export function pinchTo(
  camera: CameraState,
  ratio: number,
  cameraConfig: CameraConfig,
  navigationConfig: NavigationConfig,
): CameraState {
  if (ratio <= 0) {
    throw new RangeError('Pinch ratio must be positive');
  }
  return zoomBy(camera, 1 / ratio, cameraConfig, navigationConfig);
}

/**
 * The spatial level one step outward, or `null` when there is nowhere to go
 * (§37.3 `ESC`).
 *
 * Every mode is listed rather than left to a `default`. Two of them are not
 * spatial levels at all — a profile presentation and a reset already in flight —
 * and letting a catch-all decide what `ESC` does from those is how one of them
 * ends up silently unreachable or, worse, silently escapable into the wrong
 * place.
 */
export function outwardMode(mode: CameraMode): CameraMode | null {
  switch (mode) {
    case 'CINEMATIC_TEMP':
      // The tactical view it interrupted — the same place §81.3 returns control
      // to when the cinematic ends on its own.
      return 'BATTLE_TACTICAL';
    case 'BATTLE_TACTICAL':
      return 'SECTOR_FOCUS';
    case 'SECTOR_FOCUS':
      return 'GLOBAL_FREE';
    case 'GLOBAL_FOCUS':
      // Already at the global level; stepping out drops the highlighted battle
      // rather than moving the camera anywhere new.
      return 'GLOBAL_FREE';
    case 'PROFILE_PRESENTATION':
      // The profile is a presentation over the world, not a level inside it, so
      // `ESC` returns to the world (§37.7: never leave the user stranded).
      return 'GLOBAL_FREE';
    case 'GLOBAL_FREE':
    case 'RESETTING':
      // Nowhere further out. A reset is already on its way to the global
      // anchor, and starting a second move would fight the one in flight.
      return null;
  }
}

/**
 * The level the camera is at, or the one it is on its way to.
 *
 * `mode` only becomes the destination when a transition finishes, which is the
 * right answer for anything describing where the camera *is* — the HUD density
 * §37.6 ties to zoom should change on arrival, not on departure. It is the
 * wrong answer for a control the player presses, because a player who taps a
 * sector and then presses `ESC` half a second later is changing their mind
 * about where they are going, and reading the level they left makes the key do
 * nothing at all.
 *
 * §37.7 asks never to leave someone stranded; a rail that ignores you for the
 * second after every move is a smaller version of the same thing.
 */
export function intendedMode(camera: CameraState): CameraMode {
  return camera.transition?.toMode ?? camera.mode;
}

/**
 * Flies one spatial level outward (`ESC`, §37.3).
 *
 * The pose for a level belongs to the world layout, not to this package — the
 * runtime holds the decision, the app holds the geometry — so the caller
 * supplies it. Returns the camera unchanged at the global level, so holding
 * `ESC` cannot push past the top of the hierarchy.
 */
export function stepOutward(
  camera: CameraState,
  poseFor: (mode: CameraMode) => CameraPose | null,
  at: UtcTimestamp,
  cameraConfig: CameraConfig,
): CameraState {
  const mode = outwardMode(intendedMode(camera));
  if (mode === null) {
    return camera;
  }
  const to = poseFor(mode);
  if (to === null) {
    return camera;
  }
  // ESC is an orientation rail like Reset View, so it releases a cinematic
  // rather than being swallowed by one (§37.7).
  const released: CameraState = { ...camera, transition: null };
  return flyTo(
    released,
    {
      to,
      mode,
      at,
      duration: cameraConfig.durations.spatialTransition,
      battleId: mode === 'GLOBAL_FREE' ? null : camera.focusedBattleId,
    },
    cameraConfig,
  );
}

/** How far the camera currently sits from what it is looking at. */
export function currentViewDistance(camera: CameraState): number {
  return distance(camera.pose.position, camera.pose.target);
}

function isLocked(camera: CameraState): boolean {
  return camera.transition !== null && !camera.transition.interruptible;
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError('Zoom bounds are inverted');
  }
  return value < min ? min : value > max ? max : value;
}
