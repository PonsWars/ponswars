import { describe, expect, it } from 'vitest';
import {
  GOOD_FRAME_MS,
  GOVERNED_TIERS,
  IGNORE_FRAME_MS,
  initialFrameHealth,
  observeFrame,
  POOR_FRAME_MS,
  stepDown,
  stepUp,
  WINDOW_MS,
  WINDOWS_TO_DROP,
  WINDOWS_TO_RAISE,
  slowFrameMark,
  type FrameHealth,
} from './frame-health.js';

/**
 * Keeping the world inside its frame budget (§82.1, §82.2, §37.10).
 */

/** Runs a steady frame time for a number of whole windows. */
function run(state: FrameHealth, frameMs: number, windows: number): FrameHealth {
  let current = state;
  const frames = Math.ceil((WINDOW_MS / frameMs) * windows) + windows;
  for (let frame = 0; frame < frames; frame += 1) {
    current = observeFrame(current, frameMs);
  }
  return current;
}

describe('judging a window of frames', () => {
  it('reads the slow frames, not the average', () => {
    // A world that renders at 60 and stutters every fourth frame reads as
    // broken while its mean looks fine.
    expect(slowFrameMark([8, 8, 8, 40])).toBe(40);
    expect(slowFrameMark([10, 10, 10, 10])).toBe(10);
  });

  it('is not moved by a single slow frame in a long window', () => {
    const steady = Array.from({ length: 60 }, () => 9);
    expect(slowFrameMark([...steady, 90])).toBe(9);
  });

  it('has an answer for an empty window', () => {
    expect(slowFrameMark([])).toBe(0);
  });
});

describe('a device that cannot hold the budget', () => {
  it('steps down, and keeps stepping down', () => {
    const first = run(initialFrameHealth('BALANCED'), POOR_FRAME_MS + 8, WINDOWS_TO_DROP);
    expect(first.tier).toBe('PERFORMANCE');

    const next = run(first, POOR_FRAME_MS + 8, WINDOWS_TO_DROP);
    // Already at the bottom: it stays there rather than falling off the end.
    expect(next.tier).toBe('PERFORMANCE');
  });

  it('does not move on one bad window', () => {
    const state = run(initialFrameHealth('BALANCED'), POOR_FRAME_MS + 8, 1);
    expect(state.tier).toBe('BALANCED');
  });

  it('does not move because of one slow frame', () => {
    let state = initialFrameHealth('BALANCED');
    for (let window = 0; window < WINDOWS_TO_DROP + 2; window += 1) {
      state = observeFrame(state, 120);
      state = run(state, 9, 1);
    }
    expect(state.tier).toBe('BALANCED');
  });
});

describe('a device with room to spare', () => {
  it('climbs back, but no further than it started', () => {
    const dropped = run(initialFrameHealth('BALANCED'), POOR_FRAME_MS + 8, WINDOWS_TO_DROP);
    expect(dropped.tier).toBe('PERFORMANCE');

    const recovered = run(dropped, GOOD_FRAME_MS - 3, WINDOWS_TO_RAISE);
    expect(recovered.tier).toBe('BALANCED');

    // And stays there, however good the frames get.
    const further = run(recovered, 4, WINDOWS_TO_RAISE * 2);
    expect(further.tier).toBe('BALANCED');
  });

  it('takes longer to climb than to drop, so a device on the edge never flickers', () => {
    expect(WINDOWS_TO_RAISE).toBeGreaterThan(WINDOWS_TO_DROP);
  });

  it('holds still in the middle, where neither rule applies', () => {
    const between = (POOR_FRAME_MS + GOOD_FRAME_MS) / 2;
    const state = run(initialFrameHealth('HIGH'), between, WINDOWS_TO_RAISE * 2);
    expect(state.tier).toBe('HIGH');
  });
});

describe('what the governor may not touch', () => {
  it('leaves reduced motion alone, however the frames run (§83.3)', () => {
    // An accessibility choice about movement, not a performance tier.
    const slow = run(initialFrameHealth('REDUCED_MOTION'), POOR_FRAME_MS + 20, WINDOWS_TO_DROP * 2);
    expect(slow.tier).toBe('REDUCED_MOTION');

    const fast = run(initialFrameHealth('REDUCED_MOTION'), 5, WINDOWS_TO_RAISE * 2);
    expect(fast.tier).toBe('REDUCED_MOTION');
  });

  it('never climbs past the tier a player chose (§82.2)', () => {
    const chosen = initialFrameHealth('PERFORMANCE');
    expect(run(chosen, 4, WINDOWS_TO_RAISE * 2).tier).toBe('PERFORMANCE');
  });

  it('ignores a frame no device drew — a hidden tab, a paused debugger', () => {
    let state = initialFrameHealth('BALANCED');
    const before = state;
    state = observeFrame(state, IGNORE_FRAME_MS + 1);
    state = observeFrame(state, 0);
    state = observeFrame(state, Number.NaN);
    state = observeFrame(state, -5);
    expect(state).toEqual(before);
  });
});

describe('the ladder of tiers', () => {
  it('runs best to worst and leaves reduced motion out', () => {
    expect(GOVERNED_TIERS).toEqual(['ULTRA', 'HIGH', 'BALANCED', 'PERFORMANCE']);
  });

  it('stops at both ends', () => {
    expect(stepDown('PERFORMANCE')).toBe('PERFORMANCE');
    expect(stepUp('ULTRA', 'ULTRA')).toBe('ULTRA');
    expect(stepDown('REDUCED_MOTION')).toBe('REDUCED_MOTION');
    expect(stepUp('REDUCED_MOTION', 'REDUCED_MOTION')).toBe('REDUCED_MOTION');
  });
});
