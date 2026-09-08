import type { DurationMs, UtcTimestamp } from '@ponswars/shared-types';
import { applySoftBoundary, distance, lerp, smoothstep, type Vec3 } from './vector.js';

/**
 * The camera state machine and fly-to runtime (§37.5, §81.2, §114.3).
 *
 * A reducer over an explicit clock, like everything else here: `advance(state,
 * at)` rather than a loop reading `performance.now()`. That makes a camera
 * transition testable frame by frame, reproducible in a replay, and immune to
 * a dropped frame changing where it ends up.
 */

/** Camera modes (§81.2). */
export const CAMERA_MODES = [
  'GLOBAL_FREE',
  'GLOBAL_FOCUS',
  'SECTOR_FOCUS',
  'BATTLE_TACTICAL',
  'CINEMATIC_TEMP',
  'PROFILE_PRESENTATION',
  'RESETTING',
] as const;

export type CameraMode = (typeof CAMERA_MODES)[number];

/**
 * The four spatial zoom states (§37.2).
 *
 * Level 4 is always temporary — §37.2 requires a return to a readable tactical
 * view after the event that triggered it.
 */
export const ZOOM_LEVELS = [1, 2, 3, 4] as const;

export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

export function zoomLevelForMode(mode: CameraMode): ZoomLevel {
  switch (mode) {
    case 'SECTOR_FOCUS':
      return 2;
    case 'BATTLE_TACTICAL':
      return 3;
    case 'CINEMATIC_TEMP':
      return 4;
    default:
      return 1;
  }
}

/** Where the camera is and what it is looking at. */
export interface CameraPose {
  readonly position: Vec3;
  readonly target: Vec3;
}

/** A move in progress. */
export interface CameraTransition {
  readonly from: CameraPose;
  readonly to: CameraPose;
  readonly startedAt: UtcTimestamp;
  readonly duration: DurationMs;
  readonly toMode: CameraMode;
  /**
   * Whether user input may redirect this move.
   *
   * §114.4: routine fly-to is interruptible by another battle selection, Reset
   * View, Focus My War or direct camera input. *"Critical short cinematic
   * events may temporarily reduce control but should return quickly."*
   */
  readonly interruptible: boolean;
  /** Where control returns after a cinematic (§81.3). */
  readonly restoreTo: CameraPose | null;
  readonly restoreMode: CameraMode | null;
}

export interface CameraState {
  readonly pose: CameraPose;
  readonly mode: CameraMode;
  readonly transition: CameraTransition | null;
  /** Which battle is focused, for `FOCUS MY WAR` and the switcher (§37.7). */
  readonly focusedBattleId: string | null;
}

export interface CameraConfig {
  /** Where `RESET VIEW` always returns to (§81.4). */
  readonly globalAnchor: CameraPose;
  /** Soft world boundary radius (§38.8, §81.4). */
  readonly boundaryRadius: number;
  /** Timing classes from §114.2, calibrated rather than fixed. */
  readonly durations: {
    readonly panelTransition: DurationMs;
    readonly spatialTransition: DurationMs;
    readonly cinematic: DurationMs;
  };
  /**
   * Reduced Motion (§83.3, §37.5).
   *
   * *"Reduced Motion disables or shortens long fly-throughs ... Gameplay
   * information must remain complete."* So a reduced-motion camera still goes
   * where it was asked to go — it simply arrives immediately, which is the one
   * case §37.5 allows an instant cut.
   */
  readonly reducedMotion: boolean;
}

export function initialCamera(config: CameraConfig): CameraState {
  return {
    pose: config.globalAnchor,
    mode: 'GLOBAL_FREE',
    transition: null,
    focusedBattleId: null,
  };
}

export interface FlyToRequest {
  readonly to: CameraPose;
  readonly mode: CameraMode;
  readonly at: UtcTimestamp;
  readonly duration: DurationMs;
  /** Defaults to interruptible; a cinematic passes `false` (§81.3). */
  readonly interruptible?: boolean;
  readonly battleId?: string | null;
  /** For a cinematic: where to return when it ends. */
  readonly restoreTo?: CameraPose;
  readonly restoreMode?: CameraMode;
}

/**
 * Starts a camera move.
 *
 * A move requested while an **uninterruptible** transition is running is
 * refused, and the current state is returned unchanged. §81.3 allows a
 * cinematic to reduce control briefly; letting a stray click cut one short
 * would make the moment it exists for unreliable.
 *
 * Under reduced motion the camera arrives at once. §83.3 shortens or disables
 * long fly-throughs, and it must still reach the same place — the information
 * has to stay complete.
 */
export function flyTo(
  state: CameraState,
  request: FlyToRequest,
  config: CameraConfig,
): CameraState {
  if (state.transition !== null && !state.transition.interruptible) {
    return state;
  }
  if (request.duration <= 0) {
    throw new RangeError('Transition duration must be positive');
  }

  const battleId = request.battleId === undefined ? state.focusedBattleId : request.battleId;

  if (config.reducedMotion) {
    return {
      pose: request.to,
      mode: request.mode,
      transition: null,
      focusedBattleId: battleId,
    };
  }

  return {
    pose: state.pose,
    mode: state.mode,
    focusedBattleId: battleId,
    transition: {
      from: state.pose,
      to: request.to,
      startedAt: request.at,
      duration: request.duration,
      toMode: request.mode,
      interruptible: request.interruptible ?? true,
      restoreTo: request.restoreTo ?? null,
      restoreMode: request.restoreMode ?? null,
    },
  };
}

/**
 * Advances an in-flight transition to a given instant.
 *
 * Driven by an explicit timestamp rather than a delta, so a dropped frame
 * cannot leave the camera short of its destination — it simply jumps further
 * along the same curve. §114.3 requires predictable behaviour, and a
 * time-absolute interpolation is what makes it predictable.
 */
export function advance(state: CameraState, at: UtcTimestamp, config: CameraConfig): CameraState {
  const { transition } = state;
  if (transition === null) {
    return state;
  }

  const elapsed = at - transition.startedAt;
  if (elapsed >= transition.duration) {
    const finished: CameraState = {
      pose: transition.to,
      mode: transition.toMode,
      transition: null,
      focusedBattleId: state.focusedBattleId,
    };

    // §37.2 and §81.3: a cinematic is temporary and returns to a readable
    // tactical view. The return leg is queued here rather than left to a caller
    // who might forget, which would strand the player in a close-up.
    if (transition.restoreTo !== null && transition.restoreMode !== null) {
      return flyTo(
        finished,
        {
          to: transition.restoreTo,
          mode: transition.restoreMode,
          at,
          duration: config.durations.spatialTransition,
          interruptible: true,
        },
        config,
      );
    }
    return finished;
  }

  const progress = smoothstep(elapsed / transition.duration);
  const position = applySoftBoundary(
    lerp(transition.from.position, transition.to.position, progress),
    config.boundaryRadius,
  );

  return {
    pose: { position, target: lerp(transition.from.target, transition.to.target, progress) },
    mode: state.mode,
    transition,
    focusedBattleId: state.focusedBattleId,
  };
}

/**
 * `RESET VIEW` (§37.7, §81.4).
 *
 * *"`RESET VIEW` always returns to a known global anchor."* Always: it
 * interrupts even an uninterruptible cinematic, because it is the control a
 * player reaches for when they are lost, and a rail that refuses to release
 * them is the failure §37.7 exists to prevent.
 */
export function resetView(state: CameraState, at: UtcTimestamp, config: CameraConfig): CameraState {
  const released: CameraState = { ...state, transition: null };
  return flyTo(
    released,
    {
      to: config.globalAnchor,
      mode: 'GLOBAL_FREE',
      at,
      duration: config.durations.spatialTransition,
      battleId: null,
    },
    config,
  );
}

/**
 * `FOCUS MY WAR` (§37.7, §81.5).
 *
 * Resolves the battle from authoritative round state and flies to its sector.
 * Like Reset View it releases a cinematic first — both are the controls §114.4
 * names as always available.
 */
export function focusMyWar(
  state: CameraState,
  battleId: string,
  pose: CameraPose,
  at: UtcTimestamp,
  config: CameraConfig,
): CameraState {
  const released: CameraState = { ...state, transition: null };
  return flyTo(
    released,
    {
      to: pose,
      mode: 'SECTOR_FOCUS',
      at,
      duration: config.durations.spatialTransition,
      battleId,
    },
    config,
  );
}

/** Whether a transition is currently running. */
export function isMoving(state: CameraState): boolean {
  return state.transition !== null;
}

/** How far along the current transition is, in `[0, 1]`. */
export function progressOf(state: CameraState, at: UtcTimestamp): number {
  const { transition } = state;
  if (transition === null) {
    return 1;
  }
  const raw = (at - transition.startedAt) / transition.duration;
  return raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
}

/** Distance from the camera to its look-at target, for LOD selection. */
export function viewDistance(pose: CameraPose): number {
  return distance(pose.position, pose.target);
}
