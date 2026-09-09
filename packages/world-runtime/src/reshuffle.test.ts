import { describe, expect, it } from 'vitest';
import {
  reshuffleDuration,
  reshuffleFrame,
  SETTLED_WORLD,
  type ReshuffleTiming,
} from './reshuffle.js';

/**
 * The reshuffle between rounds (§15).
 *
 * §15 fixes an order, and the order is the whole point: the old world comes
 * apart before the new one is made. These assert that order rather than the
 * shape of any one curve, because the curve is taste and the order is the
 * contract.
 */

const TIMING: ReshuffleTiming = {
  teardownMs: 1_200,
  holdMs: 600,
  connectMs: 900,
  deployMs: 700,
};

const TOTAL = reshuffleDuration(TIMING);

/** Samples every millisecond of the sequence, for the ordering properties. */
function everyStep(): readonly { at: number; frame: ReturnType<typeof reshuffleFrame> }[] {
  return Array.from({ length: TOTAL + 1 }, (_, at) => ({ at, frame: reshuffleFrame(at, TIMING) }));
}

describe('the settled world', () => {
  it('is what a caller gets outside the sequence', () => {
    expect(reshuffleFrame(0, TIMING)).toEqual(SETTLED_WORLD);
    expect(reshuffleFrame(TOTAL, TIMING)).toEqual(SETTLED_WORLD);
    expect(reshuffleFrame(TOTAL + 5_000, TIMING)).toEqual(SETTLED_WORLD);
  });

  it('is what a clock running backwards gets', () => {
    // A negative elapsed time is what a device clock corrected backwards
    // produces (§23.5). Answering with the settled world is right: nothing is
    // mid-reshuffle before one has started.
    expect(reshuffleFrame(-1, TIMING)).toEqual(SETTLED_WORLD);
    expect(reshuffleFrame(-90_000, TIMING)).toEqual(SETTLED_WORLD);
  });

  it('reports itself inactive, so a caller can stop asking', () => {
    expect(SETTLED_WORLD.active).toBe(false);
    expect(reshuffleFrame(TOTAL / 2, TIMING).active).toBe(true);
  });
});

describe('the order §15 fixes', () => {
  it('takes the frontline away before the routes let go', () => {
    // §15 steps 3 then 6. A route still lit to a battlefield whose frontline
    // had gone would be the reverse reading: a world being rebuilt around a
    // battle still in progress.
    const frontlineGone = everyStep().find(({ frame }) => frame.frontline <= 0.01);
    const routeGone = everyStep().find(({ frame }) => frame.route <= 0.01);

    expect(frontlineGone).toBeDefined();
    expect(routeGone).toBeDefined();
    expect(frontlineGone?.at ?? 0).toBeLessThan(routeGone?.at ?? 0);
  });

  it('never lights a route to a sector whose base has not arrived', () => {
    // §15 steps 8 then 9: routes connect, then bases deploy. The inverse — a
    // base standing at the end of nothing — is what this rules out, and it is
    // checked at every millisecond rather than at a few sampled points.
    for (const { at, frame } of everyStep()) {
      expect(
        frame.forwardBase <= frame.route + 1e-9,
        `base ${String(frame.forwardBase)} ahead of route ${String(frame.route)} at ${String(at)}ms`,
      ).toBe(true);
    }
  });

  it('pulses the core only while the world is apart', () => {
    // §15 step 5 sits between the teardown and the reconnection. A pulse while
    // the routes are still up would read as the core doing something to a
    // running round.
    const duringTeardown = reshuffleFrame(TIMING.teardownMs * 0.5, TIMING);
    const duringHold = reshuffleFrame(TIMING.teardownMs + TIMING.holdMs * 0.5, TIMING);
    const afterDeploy = reshuffleFrame(TOTAL - 1, TIMING);

    expect(duringTeardown.corePulse).toBe(0);
    expect(duringHold.corePulse).toBeGreaterThan(0.5);
    expect(afterDeploy.corePulse).toBe(0);
  });

  it('brings the frontline back last of all', () => {
    // §13.4 reads the frontline as the line between two sides. Drawing it before
    // the bases have deployed would mark a division across a battlefield that
    // has nothing standing on it yet.
    for (const { at, frame } of everyStep()) {
      expect(
        frame.frontline <= frame.forwardBase + 1e-9,
        `frontline ${String(frame.frontline)} ahead of base ${String(frame.forwardBase)} at ${String(at)}ms`,
      ).toBe(true);
    }
  });

  it('empties the world completely at the hold', () => {
    // The moment §15 is built around: everything temporary is gone and only the
    // core is lit. If any part is still standing here the sequence reads as a
    // dimming rather than a disconnection.
    const atHold = reshuffleFrame(TIMING.teardownMs + TIMING.holdMs / 2, TIMING);

    expect(atHold.frontline).toBe(0);
    expect(atHold.route).toBe(0);
    expect(atHold.forwardBase).toBe(0);
  });
});

describe('the values themselves', () => {
  it('stays inside 0 and 1 at every step', () => {
    // These drive scale and opacity. A value outside the range would be an
    // inverted structure or an invisible one, and both look like a bug in the
    // scene rather than in the reducer.
    for (const { at, frame } of everyStep()) {
      for (const [name, value] of Object.entries(frame)) {
        if (typeof value !== 'number') {
          continue;
        }
        expect(value >= 0 && value <= 1, `${name} = ${String(value)} at ${String(at)}ms`).toBe(
          true,
        );
      }
    }
  });

  it('is the same frame for the same instant', () => {
    // Pure, like everything else the world is drawn from: two callers at one
    // instant must agree, or two clients watching one reshuffle would not.
    expect(reshuffleFrame(1_500, TIMING)).toEqual(reshuffleFrame(1_500, TIMING));
  });

  it('finishes sooner under a shorter timing rather than a different one', () => {
    // Reduced motion passes shorter durations rather than taking a branch
    // inside the reducer (§83.3). The sequence is the same sequence.
    const quick: ReshuffleTiming = { teardownMs: 120, holdMs: 60, connectMs: 90, deployMs: 70 };

    expect(reshuffleDuration(quick)).toBeLessThan(TOTAL);
    expect(reshuffleFrame(reshuffleDuration(quick) / 2, quick).active).toBe(true);
    expect(reshuffleFrame(reshuffleDuration(quick), quick)).toEqual(SETTLED_WORLD);
  });

  it('never jumps, including into the settled world it ends at', () => {
    // §15's closing line — no full-page reload should be visible — is a
    // statement about continuity, and the last millisecond is where it is
    // easiest to break: a field left at 0 through the whole sequence and
    // answered as 1 by the settled world pops rather than arrives. Sampled one
    // millisecond apart and one past the end, so the boundary is included.
    const LIMIT = 0.02;
    let previous = reshuffleFrame(-1, TIMING);

    for (let at = 0; at <= TOTAL + 1; at += 1) {
      const frame = reshuffleFrame(at, TIMING);
      for (const field of ['frontline', 'forwardBase', 'route', 'corePulse'] as const) {
        expect(
          Math.abs(frame[field] - previous[field]) <= LIMIT,
          `${field} jumped ${String(previous[field])} → ${String(frame[field])} at ${String(at)}ms`,
        ).toBe(true);
      }
      previous = frame;
    }
  });

  it('handles a zero-length phase without dividing by it', () => {
    // A timing that skips a phase is a legitimate calibration, and it must not
    // produce a NaN that silently propagates into a transform matrix.
    const noHold: ReshuffleTiming = { teardownMs: 400, holdMs: 0, connectMs: 400, deployMs: 400 };

    for (let at = 0; at <= reshuffleDuration(noHold); at += 25) {
      const frame = reshuffleFrame(at, noHold);
      expect(Number.isFinite(frame.route)).toBe(true);
      expect(Number.isFinite(frame.forwardBase)).toBe(true);
      expect(Number.isFinite(frame.corePulse)).toBe(true);
    }
  });
});
