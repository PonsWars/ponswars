import { QUALITY_TIERS, type QualityTier } from './lod.js';

/**
 * Keeping the world inside its frame budget, by watching the frames (§82.1,
 * §82.2, §37.10).
 *
 * §82.2 lets auto-detection *suggest* a tier and leaves the override with the
 * user, and §37.10 makes LOD a required architecture rather than a polish
 * item. Without this the tier was a constant: every device drew the same five
 * sectors at the same fidelity, and a laptop that could not hold the frame
 * budget simply ran slowly — which is the one thing a level-of-detail system
 * exists to prevent.
 *
 * A reducer over frame times, like the camera is a reducer over a clock: no
 * timers, no renderer, nothing to mock. The scene feeds it the time each frame
 * took; it answers with the tier the scene should be drawing at.
 *
 * ## What it may not do
 *
 * - **Never override the user.** A tier the player chose is theirs (§82.2).
 * - **Never touch Reduced Motion.** That is an accessibility choice about
 *   movement, not a performance tier (§83.3), and stepping a player out of it
 *   to win frames would take away what they asked for.
 * - **Never change anything but what is drawn.** §82.1: *quality changes must
 *   not affect battle logic* — and nothing here reaches the engine.
 */

/** The tiers this may move between, best first. Reduced Motion is not one. */
export const GOVERNED_TIERS = QUALITY_TIERS.filter(
  (tier) => tier !== 'REDUCED_MOTION',
) as readonly QualityTier[];

/**
 * How long a window of frames is judged over, in milliseconds.
 *
 * Long enough that one slow frame — a texture upload, a garbage collection, a
 * sector coming into detail — cannot move the tier, and short enough that a
 * player on a device that cannot hold the budget is not left there for long.
 */
export const WINDOW_MS = 2_000;

/**
 * The frame times the decision is made on, in milliseconds.
 *
 * Judged on the window's ninetieth percentile rather than its average — the
 * measure §82.6 asks telemetry for. A world that renders at 60 and stutters
 * every fourth frame reads as broken while its mean looks fine, and the mean
 * is what would keep it at a tier it cannot hold. Below `GOOD` the device has
 * room to spare; above `POOR` it does not have enough.
 *
 * `CALIBRATE` (§59.4). About 48 frames a second and about 90.
 */
export const POOR_FRAME_MS = 21;
export const GOOD_FRAME_MS = 11;

/**
 * How many windows in a row it takes to move a tier, each way.
 *
 * Down after two — four seconds of a world that is not keeping up is already
 * too long. Up only after four, because stepping up is what caused the drop in
 * the first place and a device on the edge would otherwise oscillate: down,
 * up, down, at a rate a player can see.
 */
export const WINDOWS_TO_DROP = 2;
export const WINDOWS_TO_RAISE = 4;

/**
 * How long the world is given before any of this counts, in milliseconds.
 *
 * §82.3 loads the world in stages — shell, then the global world, then the
 * focused sector — and those stages cost frames: geometry is built, textures
 * are uploaded, shaders compile the first time each one draws. Judging a
 * device on that is judging it on the one part of the session that is not
 * about what it can draw, and the first thing a player saw was a world
 * demoting itself while it was still arriving.
 */
export const WARMUP_MS = 4_000;

export interface FrameHealth {
  /** How much of the warm-up is left, milliseconds. Nothing counts until it is gone. */
  readonly warmupMs: number;
  /** Frame times in the window so far, milliseconds. */
  readonly samples: readonly number[];
  /** How long the window has been open, milliseconds. */
  readonly elapsedMs: number;
  /** Consecutive windows judged poor, and consecutive judged good. */
  readonly poorWindows: number;
  readonly goodWindows: number;
  /** The tier the scene should draw at. */
  readonly tier: QualityTier;
  /**
   * The best tier this may climb back to: where it started, or what the user
   * chose. It never promotes a device past the tier it was given.
   */
  readonly ceiling: QualityTier;
}

/**
 * A fresh watch at a tier.
 *
 * Also how a player's choice is applied: their tier becomes both the tier and
 * the ceiling, so §82.2's override holds — the world may still step *down*
 * from it to keep the frame budget, and may never climb past what they asked
 * for.
 */
export function initialFrameHealth(tier: QualityTier): FrameHealth {
  return {
    warmupMs: WARMUP_MS,
    samples: [],
    elapsedMs: 0,
    poorWindows: 0,
    goodWindows: 0,
    tier,
    ceiling: tier,
  };
}

/** The tier one step down, or the same tier at the bottom. */
export function stepDown(tier: QualityTier): QualityTier {
  const index = GOVERNED_TIERS.indexOf(tier);
  if (index < 0) {
    return tier;
  }
  return GOVERNED_TIERS[Math.min(index + 1, GOVERNED_TIERS.length - 1)] ?? tier;
}

/** The tier one step up, never past a ceiling. */
export function stepUp(tier: QualityTier, ceiling: QualityTier): QualityTier {
  const index = GOVERNED_TIERS.indexOf(tier);
  const limit = GOVERNED_TIERS.indexOf(ceiling);
  if (index < 0 || limit < 0) {
    return tier;
  }
  return GOVERNED_TIERS[Math.max(index - 1, limit)] ?? tier;
}

/**
 * The frame time nine frames in ten came in under — the window's ninetieth
 * percentile, by the nearest-rank method.
 *
 * The percentile is the point: a quarter of the frames stuttering leaves a
 * seventy-fifth percentile sitting exactly on the good frames, and a mean
 * hides a stutter altogether.
 */
export function slowFrameMark(samples: readonly number[]): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(sorted.length * 0.9);
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)] ?? 0;
}

/**
 * One frame.
 *
 * `frameMs` is how long the last frame took. A window closes once it has run
 * for `WINDOW_MS`, and only a closed window can move the tier.
 *
 * A frame far longer than any frame — a tab in the background, a laptop lid
 * closed, a breakpoint — is dropped rather than counted. It says nothing about
 * what the device can draw, and §82's budget is about drawing.
 */
export const IGNORE_FRAME_MS = 250;

export function observeFrame(state: FrameHealth, frameMs: number): FrameHealth {
  if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > IGNORE_FRAME_MS) {
    return state;
  }

  if (state.warmupMs > 0) {
    return { ...state, warmupMs: state.warmupMs - frameMs };
  }

  const samples = [...state.samples, frameMs];
  const elapsedMs = state.elapsedMs + frameMs;
  if (elapsedMs < WINDOW_MS) {
    return { ...state, samples, elapsedMs };
  }

  const mark = slowFrameMark(samples);
  const poorWindows = mark > POOR_FRAME_MS ? state.poorWindows + 1 : 0;
  const goodWindows = mark < GOOD_FRAME_MS ? state.goodWindows + 1 : 0;

  if (poorWindows >= WINDOWS_TO_DROP) {
    return { ...closed(state), tier: stepDown(state.tier) };
  }
  if (goodWindows >= WINDOWS_TO_RAISE) {
    return { ...closed(state), tier: stepUp(state.tier, state.ceiling) };
  }
  return { ...closed(state), poorWindows, goodWindows };
}

/** A window closed, with the counters a decision resets kept at zero. */
function closed(state: FrameHealth): FrameHealth {
  return { ...state, samples: [], elapsedMs: 0, poorWindows: 0, goodWindows: 0 };
}
