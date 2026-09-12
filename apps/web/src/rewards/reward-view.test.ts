import {
  MIN_QUALIFYING_WP,
  REWARD_WEIGHT_SCALE,
  rewardWeight,
  utcTimestamp,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  activeWindowView,
  canTransitionClaim,
  claimCopy,
  CLAIM_STATES,
  currentWindowView,
  finalizedWindowView,
  formatRewardWeight,
  formatWindowCountdown,
  type RewardView,
} from './reward-view.js';

const CLOSES_AT = utcTimestamp(1_800_000_000_000);

describe('the active window', () => {
  it('has no allocation field for a component to render', () => {
    // §35.2 is a hard rule, so it is enforced by shape rather than by
    // discipline. This is a type-level assertion as much as a runtime one:
    // narrowing to ACTIVE leaves nothing named `allocation` in scope.
    const view: RewardView = activeWindowView({
      distributionId: 42,
      warPoints: 84,
      closesAt: CLOSES_AT,
    });
    expect(view.kind).toBe('ACTIVE');
    expect(Object.keys(view)).not.toContain('allocation');
  });

  it('labels the window the way §35.1 does', () => {
    const view = activeWindowView({ distributionId: 42, warPoints: 84, closesAt: CLOSES_AT });
    expect(view.label).toBe('REWARDS DISTRIBUTION #042');
  });

  it('qualifies at exactly the floor, not one above it', () => {
    const at = activeWindowView({
      distributionId: 1,
      warPoints: MIN_QUALIFYING_WP,
      closesAt: CLOSES_AT,
    });
    const below = activeWindowView({
      distributionId: 1,
      warPoints: MIN_QUALIFYING_WP - 1,
      closesAt: CLOSES_AT,
    });
    expect(at.qualified).toBe(true);
    expect(below.qualified).toBe(false);
  });

  it('counts the War Points still needed', () => {
    const view = activeWindowView({ distributionId: 1, warPoints: 32, closesAt: CLOSES_AT });
    // §35.1's own example: 32 / 50 WP, 18 WP TO QUALIFY.
    expect(view.wpToQualify).toBe(18);
    expect(view.weightLabel).toBeNull();
  });

  it('shows a weight only once the wallet qualifies', () => {
    const view = activeWindowView({ distributionId: 42, warPoints: 84, closesAt: CLOSES_AT });
    expect(view.weightLabel).toBe('9.17');
  });

  it('refuses War Points that are not a whole count', () => {
    expect(() =>
      activeWindowView({ distributionId: 1, warPoints: 1.5, closesAt: CLOSES_AT }),
    ).toThrow(RangeError);
    expect(() =>
      activeWindowView({ distributionId: 1, warPoints: -1, closesAt: CLOSES_AT }),
    ).toThrow(RangeError);
  });
});

describe('the finalized window', () => {
  it('is the only shape carrying an allocation', () => {
    const view = finalizedWindowView({
      distributionId: 42,
      warPoints: 84,
      allocation: '0.083',
      carriedForward: false,
      capReached: false,
    });
    expect(view.kind).toBe('FINALIZED');
    expect(view.allocation).toBe('0.083');
  });

  it('carries a below-threshold amount forward rather than losing it', () => {
    // §35.5: the reward is not lost.
    const view = finalizedWindowView({
      distributionId: 39,
      warPoints: 61,
      allocation: '0.0008',
      carriedForward: true,
      capReached: false,
    });
    expect(view.carriedForward).toBe(true);
    expect(view.allocation).toBe('0.0008');
  });
});

describe('formatRewardWeight', () => {
  it('matches the worked example in §35.2', () => {
    // sqrt(84) = 9.16515…, which rounds to the 9.17 the masterplan prints.
    expect(formatRewardWeight(rewardWeight(84))).toBe('9.17');
  });

  it('is exact on perfect squares', () => {
    expect(formatRewardWeight(rewardWeight(100))).toBe('10.00');
    expect(formatRewardWeight(rewardWeight(64))).toBe('8.00');
    expect(formatRewardWeight(rewardWeight(0))).toBe('0.00');
  });

  it('rounds half up', () => {
    // Exactly 1.005 at full scale. Rounding half down would print 1.00.
    expect(formatRewardWeight((REWARD_WEIGHT_SCALE * 1_005n) / 1_000n)).toBe('1.01');
  });

  it('pads a fraction below ten hundredths', () => {
    expect(formatRewardWeight((REWARD_WEIGHT_SCALE * 204n) / 100n)).toBe('2.04');
  });

  it('never accepts a negative weight', () => {
    expect(() => formatRewardWeight(-1n)).toThrow(RangeError);
  });

  it('grows far slower than War Points, which is the point of sqrt weighting', () => {
    // §16.5: ten times the War Points earns about three times the weight.
    const small = rewardWeight(100);
    const large = rewardWeight(1_000);
    expect(Number(large) / Number(small)).toBeCloseTo(Math.sqrt(10), 6);
  });
});

describe('formatWindowCountdown', () => {
  it('formats hours, minutes and seconds', () => {
    // §35.1's own example: closes in 06:42:18.
    expect(formatWindowCountdown((6 * 3_600 + 42 * 60 + 18) * 1_000)).toBe('06:42:18');
  });

  it('shows a full day without wrapping', () => {
    // Minutes and seconds alone would read as 00:00 for a whole 24-hour window.
    expect(formatWindowCountdown(24 * 3_600 * 1_000)).toBe('24:00:00');
  });

  it('clamps a passed deadline to zero', () => {
    expect(formatWindowCountdown(-5_000)).toBe('00:00:00');
  });
});

describe('the claim flow', () => {
  it('walks the sequence §35.6 defines', () => {
    expect(canTransitionClaim('READY_TO_CLAIM', 'CONFIRM_IN_WALLET')).toBe(true);
    expect(canTransitionClaim('CONFIRM_IN_WALLET', 'SUBMITTING')).toBe(true);
    expect(canTransitionClaim('SUBMITTING', 'CONFIRMED')).toBe(true);
  });

  it('never skips confirmation', () => {
    expect(canTransitionClaim('READY_TO_CLAIM', 'SUBMITTING')).toBe(false);
    expect(canTransitionClaim('READY_TO_CLAIM', 'CONFIRMED')).toBe(false);
  });

  it('returns a failed claim to the ready state, entitlement intact', () => {
    // §35.6: a failed user transaction must never destroy or mutate the
    // underlying entitlement. The allocation is a published Merkle leaf; a
    // rejected signature has no bearing on it, so failure cannot be terminal.
    expect(canTransitionClaim('CONFIRM_IN_WALLET', 'FAILED')).toBe(true);
    expect(canTransitionClaim('SUBMITTING', 'FAILED')).toBe(true);
    expect(canTransitionClaim('FAILED', 'READY_TO_CLAIM')).toBe(true);
    expect(claimCopy('FAILED').actionable).toBe(true);
  });

  it('treats a confirmed claim as final', () => {
    // §17: claims are exactly-once against an immutable published root.
    for (const state of CLAIM_STATES) {
      expect(canTransitionClaim('CONFIRMED', state)).toBe(false);
    }
  });

  it('gives every state copy, and only lets the player act where they can', () => {
    const actionable = CLAIM_STATES.filter((state) => claimCopy(state).actionable);
    expect(actionable).toEqual(['READY_TO_CLAIM', 'FAILED']);
    for (const state of CLAIM_STATES) {
      expect(claimCopy(state).headline.length).toBeGreaterThan(0);
    }
  });

  it('says what did not happen and what is still true', () => {
    const copy = claimCopy('FAILED');
    expect(copy.headline).toBe('CLAIM NOT COMPLETED');
    expect(copy.detail).toBe('Your allocation is still available. Try again.');
  });
});

describe('the current window, from a live profile', () => {
  it('counts War Points toward a window before any snapshot is scheduled', () => {
    // §16.2: a window's War Points begin after the previous snapshot, whether
    // or not the next one is on the calendar. There is no deadline to show.
    const view = currentWindowView({ warPoints: 64, window: null });

    expect(view).toMatchObject({
      kind: 'ACTIVE',
      label: 'CURRENT DISTRIBUTION WINDOW',
      warPoints: 64,
      qualified: true,
      closesAt: null,
    });
  });

  it('names the scheduled distribution and counts down to it', () => {
    const view = currentWindowView({
      warPoints: 12,
      window: { distributionId: 'dist-043', closesAt: 1_800_086_400_000 },
    });

    expect(view.label).toBe('REWARDS DISTRIBUTION DIST-043');
    expect(view.closesAt).toBe(utcTimestamp(1_800_086_400_000));
    expect(view).toMatchObject({ qualified: false, wpToQualify: MIN_QUALIFYING_WP - 12 });
  });

  it('still has no allocation to render', () => {
    expect(Object.keys(currentWindowView({ warPoints: 900, window: null }))).not.toContain(
      'allocation',
    );
  });
});
