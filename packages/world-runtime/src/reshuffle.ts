/**
 * The reshuffle between two rounds (§15, §3.1).
 *
 * §15 gives a canonical sequence, and the last line of it is the constraint the
 * whole thing exists to satisfy: *"No full-page reload should be visible."* A
 * round ending and the next beginning is one continuous piece of world, so the
 * old connections come apart before the new ones are made and the player watches
 * it happen.
 *
 * A pure function of elapsed time, like the camera and the momentum reducers
 * beside it. The scene asks what the world should look like at an instant and
 * draws that; it never advances a sequence itself. That is what makes the whole
 * choreography assertable in a test rather than something to be watched and
 * hoped about — and it means a dropped frame skips ahead along the same curve
 * instead of leaving the world half disconnected.
 *
 * The steps §15 names, and where each lives here:
 *
 * | §15 step                          | field            |
 * | --------------------------------- | ---------------- |
 * | 3 · frontline connections collapse | `frontline`     |
 * | 4 · FOBs retract                   | `forwardBase`   |
 * | 5 · Market Core pulses             | `corePulse`     |
 * | 6 · routes disconnect              | `route`         |
 * | 8 · new routes connect             | `route`         |
 * | 9 · FOBs deploy                    | `forwardBase`   |
 *
 * Steps 1, 7 and 10 are not visual: a battle finalizing, a pairing becoming
 * known and a pick phase opening are facts the engine decides, and this reducer
 * is told about them rather than deciding them. Step 2 belongs to the camera,
 * which already has a reducer of its own.
 */

/** How far through its own life each part of the world is, from 0 to 1. */
export interface ReshuffleFrame {
  /**
   * The frontline marker on each battlefield.
   *
   * First to go and last to return. §13.4 makes it a reading of a live score,
   * and a frontline still drawn while the routes are being rebuilt would be
   * showing a battle that has already been settled.
   */
  readonly frontline: number;
  /** Each side's forward base: retracted at 0, fully deployed at 1 (§38.5). */
  readonly forwardBase: number;
  /** The routes from the Market Core out to the sectors (§38.2). */
  readonly route: number;
  /**
   * The core's own pulse, 0 to 1 and back.
   *
   * The middle of the sequence, where the old world has come apart and the new
   * one has not been made. The core is the only thing still running, which is
   * what §38.2 makes it: the thing that survives every round.
   */
  readonly corePulse: number;
  /** Whether anything is still moving. False once the world has settled. */
  readonly active: boolean;
}

/** The world at rest, between reshuffles. */
export const SETTLED_WORLD: ReshuffleFrame = {
  frontline: 1,
  forwardBase: 1,
  route: 1,
  corePulse: 0,
  active: false,
};

/**
 * How long each phase of the sequence lasts.
 *
 * `CALIBRATE` (§59.4): §15 fixes the order and says nothing about duration.
 * These are an input rather than a compiled default, so the pacing is a
 * decision someone makes rather than one that arrived with the code — and so
 * reduced motion can pass a shorter set rather than a special case being
 * written into the reducer.
 */
export interface ReshuffleTiming {
  /** Frontline collapse and forward-base retraction, together. */
  readonly teardownMs: number;
  /** The gap where only the core is lit. */
  readonly holdMs: number;
  /** New routes reaching the sectors. */
  readonly connectMs: number;
  /** Forward bases deploying into their new sectors. */
  readonly deployMs: number;
}

/** How long the whole sequence takes. */
export function reshuffleDuration(timing: ReshuffleTiming): number {
  return timing.teardownMs + timing.holdMs + timing.connectMs + timing.deployMs;
}

/**
 * Eases a 0–1 ratio so a movement starts and ends softly.
 *
 * The same shape at both ends, because every part of this sequence is something
 * physical arriving or leaving — a linear retraction reads as a value being set
 * rather than a structure folding away.
 */
function ease(ratio: number): number {
  const clamped = ratio <= 0 ? 0 : ratio >= 1 ? 1 : ratio;
  return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

/** A ratio through a window, clamped outside it. */
function progress(elapsed: number, start: number, length: number): number {
  if (length <= 0) {
    return elapsed >= start ? 1 : 0;
  }
  return ease((elapsed - start) / length);
}

/**
 * What the world looks like this many milliseconds into a reshuffle.
 *
 * Before zero and after the end it is the settled world, so a caller can hand
 * it any elapsed time without checking bounds first — including a negative one,
 * which is what a clock skewed backwards produces.
 */
export function reshuffleFrame(elapsedMs: number, timing: ReshuffleTiming): ReshuffleFrame {
  const total = reshuffleDuration(timing);
  if (elapsedMs <= 0 || elapsedMs >= total) {
    return SETTLED_WORLD;
  }

  const teardownEnd = timing.teardownMs;
  const holdEnd = teardownEnd + timing.holdMs;
  const connectEnd = holdEnd + timing.connectMs;

  // Teardown: the frontline goes first, then the bases fold, then the routes
  // let go. Reversing that order would leave a route lit to a sector whose
  // base had already gone, which reads as a broken world rather than a
  // dismantled one.
  const teardown = progress(elapsedMs, 0, timing.teardownMs);

  return {
    // The frontline collapses over the first half of teardown, so it is gone
    // before anything else starts moving — and it comes back over the second
    // half of the deploy, after the bases it is measured between have arrived.
    // Returning it any earlier would draw a frontline across a battlefield with
    // no sides on it; not returning it at all leaves the field to snap back at
    // the final millisecond, which is the one thing §15 forbids.
    frontline:
      elapsedMs < holdEnd
        ? 1 - progress(elapsedMs, 0, timing.teardownMs * 0.5)
        : progress(elapsedMs, connectEnd + timing.deployMs * 0.5, timing.deployMs * 0.5),
    forwardBase:
      elapsedMs < holdEnd
        ? 1 - teardown
        : // Deploying again, last of all, once the routes have arrived.
          progress(elapsedMs, connectEnd, timing.deployMs),
    route: elapsedMs < holdEnd ? 1 - teardown : progress(elapsedMs, holdEnd, timing.connectMs),
    // One rise and fall across the hold, peaking where the world is emptiest.
    corePulse:
      elapsedMs < teardownEnd || elapsedMs > connectEnd
        ? 0
        : Math.sin(((elapsedMs - teardownEnd) / (connectEnd - teardownEnd)) * Math.PI),
    active: true,
  };
}
