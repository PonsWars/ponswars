import { MOMENTUM_STATES } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  advantageFromBattleScore,
  advantageFromScores,
  frontlineFromAdvantage,
  INITIAL_MOMENTUM_MEMORY,
  nextMomentum,
  wasComeback,
  type MomentumMemory,
  type MomentumThresholds,
} from './momentum.js';
import { RATIO_SCALE } from './scale.js';
import { FULL_SCORE_SCALED } from './scoring.js';

/** Test thresholds. Production values are TUNABLE and come from config (§73.7). */
const T: MomentumThresholds = {
  push: 100_000n, // 0.10 — roughly the 55/45 anchor in §13.1
  surge: 200_000n, // 0.20 — roughly 60/40
  dominance: 400_000n, // 0.40 — roughly 70/30
  comeback: 300_000n,
};

/** Feeds a sequence of advantages through the derivation. */
const run = (advantages: readonly bigint[], thresholds: MomentumThresholds = T) => {
  let memory: MomentumMemory = INITIAL_MOMENTUM_MEMORY;
  const samples = advantages.map((advantage) => {
    const sample = nextMomentum(memory, advantage, thresholds);
    memory = sample.memory;
    return sample;
  });
  return { samples, memory };
};

describe('advantageFromScores', () => {
  it('is zero for an even split', () => {
    expect(advantageFromScores(50n, 50n)).toBe(0n);
  });

  it('matches the section 13.1 anchors', () => {
    // 55/45 and 70/30 are the shares the masterplan names, and the advantage is
    // the difference over the total — 0.10 and 0.40.
    expect(advantageFromScores(55n, 45n)).toBe(100_000n);
    expect(advantageFromScores(60n, 40n)).toBe(200_000n);
    expect(advantageFromScores(70n, 30n)).toBe(400_000n);
    expect(advantageFromScores(90n, 10n)).toBe(800_000n);
  });

  it('is signed', () => {
    expect(advantageFromScores(30n, 70n)).toBe(-400_000n);
  });

  it('saturates at total dominance', () => {
    expect(advantageFromScores(100n, 0n)).toBe(RATIO_SCALE);
    expect(advantageFromScores(0n, 100n)).toBe(-RATIO_SCALE);
  });

  it('treats a zero total as even rather than dividing by zero', () => {
    expect(advantageFromScores(0n, 0n)).toBe(0n);
  });

  it('derives directly from a battle score total', () => {
    expect(advantageFromBattleScore(FULL_SCORE_SCALED / 2n)).toBe(0n);
    expect(advantageFromBattleScore(FULL_SCORE_SCALED)).toBe(RATIO_SCALE);
    expect(advantageFromBattleScore(0n)).toBe(-RATIO_SCALE);
  });
});

describe('frontlineFromAdvantage', () => {
  it('centres a dead-even battle', () => {
    expect(frontlineFromAdvantage(0n)).toBe(0.5);
  });

  it('stays inside the unit interval', () => {
    for (const advantage of [-RATIO_SCALE, -1n, 0n, 1n, RATIO_SCALE, RATIO_SCALE * 5n]) {
      const frontline = frontlineFromAdvantage(advantage);
      expect(frontline).toBeGreaterThanOrEqual(0);
      expect(frontline).toBeLessThanOrEqual(1);
    }
  });

  it('moves monotonically with the advantage', () => {
    let previous = -1;
    for (let a = -RATIO_SCALE; a <= RATIO_SCALE; a += 50_000n) {
      const frontline = frontlineFromAdvantage(a);
      expect(frontline).toBeGreaterThan(previous);
      previous = frontline;
    }
  });
});

describe('state derivation', () => {
  it('reads a level battle as contested', () => {
    const { samples } = run([0n, 10_000n, -20_000n]);
    for (const sample of samples) {
      expect(sample.state).toBe('CONTESTED');
    }
  });

  it('climbs through the states as the lead grows', () => {
    const { samples } = run([50_000n, 150_000n, 250_000n, 500_000n]);
    expect(samples.map((s) => s.state)).toEqual(['CONTESTED', 'PUSHING', 'SURGING', 'DOMINATING']);
  });

  it('reads the same states in either direction', () => {
    // Sides are positional, not advantaged (§38.3). A 70/30 lead reads the same
    // whichever side holds it.
    const left = run([500_000n]).samples[0];
    const right = run([-500_000n]).samples[0];
    expect(right?.state).toBe(left?.state);
  });

  it('produces only declared states', () => {
    const { samples } = run([0n, 120_000n, -600_000n, 900_000n, -50_000n, 400_000n]);
    for (const sample of samples) {
      expect(MOMENTUM_STATES).toContain(sample.state);
    }
  });

  it('is deterministic, never random', () => {
    // §73.7: momentum must derive from score position and velocity, not random
    // selection. The same tick sequence must replay identically.
    const sequence = [0n, 200_000n, -400_000n, 100_000n, 600_000n];
    expect(run(sequence).samples).toEqual(run(sequence).samples);
  });
});

describe('comeback', () => {
  it('fires when a side that trailed badly takes the lead', () => {
    // §13.3 lists COMEBACK as its own state, and it is the only one that cannot
    // be read off the current position.
    const { samples } = run([-400_000n, -350_000n, 50_000n]);
    expect(samples[0]?.state).toBe('DOMINATING');
    expect(samples[2]?.state).toBe('COMEBACK');
  });

  it('does not fire for a lead that was never seriously threatened', () => {
    const { samples } = run([-100_000n, 200_000n]);
    expect(samples[1]?.state).toBe('SURGING');
  });

  it('cannot fire on the tick that establishes the deficit', () => {
    // The peak is read before this tick folds in, so one tick cannot be both
    // the deepest deficit and the recovery from it.
    const { samples } = run([-500_000n]);
    expect(samples[0]?.state).not.toBe('COMEBACK');
  });

  it('outranks a position-based state', () => {
    // A side that trailed 70/30 and now dominates is a comeback first. That is
    // the more interesting fact, and the one §13.3 names separately.
    const { samples } = run([-500_000n, 600_000n]);
    expect(samples[1]?.state).toBe('COMEBACK');
  });

  it('is not claimed for a dead-even finish', () => {
    const { memory } = run([-500_000n, 0n]);
    expect(wasComeback(memory, 0n, T.comeback)).toBe(false);
  });

  it('labels the final result from what the battlefield showed', () => {
    // §13.6: the result label must agree with the visual history, so it reads
    // the accumulated memory rather than recomputing from the final score.
    const { memory } = run([-500_000n, -200_000n, 150_000n]);
    expect(wasComeback(memory, 150_000n, T.comeback)).toBe(true);
    expect(wasComeback(memory, -150_000n, T.comeback)).toBe(false);
  });
});

describe('velocity and intensity', () => {
  it('reports zero velocity on the first tick', () => {
    const { samples } = run([300_000n]);
    expect(samples[0]?.velocity).toBe(0n);
  });

  it('reports the change since the previous tick', () => {
    const { samples } = run([100_000n, 250_000n, 200_000n]);
    expect(samples[1]?.velocity).toBe(150_000n);
    expect(samples[2]?.velocity).toBe(-50_000n);
  });

  it('keeps intensity inside the unit interval', () => {
    const { samples } = run([0n, RATIO_SCALE, -RATIO_SCALE, 0n, 500_000n]);
    for (const sample of samples) {
      expect(sample.intensity).toBeGreaterThanOrEqual(0);
      expect(sample.intensity).toBeLessThanOrEqual(1);
    }
  });

  it('raises intensity for a fast swing in an even battle', () => {
    // A tense battle with the frontline swinging should read as intense. A
    // position-only measure would render it as calm.
    const swinging = run([0n, 80_000n]).samples[1];
    const still = run([80_000n, 80_000n]).samples[1];
    expect(swinging?.intensity).toBeGreaterThan(still?.intensity ?? 1);
  });

  it('raises intensity for a larger lead', () => {
    const small = run([100_000n, 100_000n]).samples[1];
    const large = run([800_000n, 800_000n]).samples[1];
    expect(large?.intensity).toBeGreaterThan(small?.intensity ?? 1);
  });
});

describe('memory', () => {
  it('tracks the deepest lead each side held', () => {
    const { memory } = run([300_000n, -700_000n, 100_000n]);
    expect(memory.peakLeft).toBe(300_000n);
    expect(memory.peakRight).toBe(700_000n);
    expect(memory.previous).toBe(100_000n);
    expect(memory.ticks).toBe(3);
  });

  it('is threaded rather than mutated, so a replay can resume mid-battle', () => {
    // §25 checkpoints round state. Momentum memory is part of it.
    const first = run([-500_000n, -400_000n]);
    const resumed = nextMomentum(first.memory, 200_000n, T);
    const whole = run([-500_000n, -400_000n, 200_000n]);
    expect(resumed).toEqual(whole.samples[2]);
  });
});

describe('threshold validation', () => {
  it.each([
    [{ ...T, push: 0n }],
    [{ ...T, surge: T.push }],
    [{ ...T, dominance: T.surge }],
    [{ ...T, comeback: 0n }],
    [{ ...T, comeback: RATIO_SCALE * 2n }],
  ])('rejects disordered thresholds %#', (thresholds) => {
    expect(() => nextMomentum(INITIAL_MOMENTUM_MEMORY, 0n, thresholds)).toThrow(RangeError);
  });
});
