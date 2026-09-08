import { ACTIVE_TICKERS, MOMENTUM_STATES, VICTORY_LABELS } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  currentRewardsSchema,
  liveBattleSchema,
  pickRequestSchema,
} from './api.js';
import { canonicalClockSchema, walletAddressSchema } from './primitives.js';
import {
  battleStateUpdateSchema,
  channelSchema,
  privateEventSchema,
  publicEventSchema,
  roundOpenedSchema,
} from './websocket.js';

const T0 = 1_800_000_000_000;
const WALLET = '0x1234567890abcdef1234567890abcdef12345678';

const clock = {
  serverTime: T0,
  pickOpenAt: T0,
  lockAt: T0 + 60_000,
  battleStartAt: T0 + 60_000,
  battleEndAt: T0 + 600_000,
};

const update = {
  type: 'BATTLE_STATE_UPDATE' as const,
  eventId: 'evt-1',
  serverTime: T0,
  sequence: 1,
  battleId: 'round-0000000001-b0',
  timeRemaining: 480_000,
  momentum: 'CONTESTED' as const,
  frontline: 0.5,
  intensity: 0.2,
  cardSupport: 'LOW' as const,
  feedHealth: 'HEALTHY' as const,
};

describe('primitives', () => {
  it('normalizes a wallet address to lowercase', () => {
    // A checksummed address and its lowercase form must be one identity, not
    // two the moment one reaches a database key.
    expect(walletAddressSchema.parse(WALLET.toUpperCase().replace('0X', '0x'))).toBe(WALLET);
  });

  it('rejects a malformed address', () => {
    expect(walletAddressSchema.safeParse('0x123').success).toBe(false);
    expect(walletAddressSchema.safeParse('not-an-address').success).toBe(false);
  });

  it('accepts a well-formed canonical clock', () => {
    expect(canonicalClockSchema.safeParse(clock).success).toBe(true);
  });

  it('rejects a clock that violates the locked timing', () => {
    // §3 locks the round at ten minutes with a one-minute pick phase. A payload
    // that disagrees is a bug or an impostor, and a client must not render a
    // countdown built on it.
    expect(canonicalClockSchema.safeParse({ ...clock, lockAt: T0 + 90_000 }).success).toBe(false);
    expect(canonicalClockSchema.safeParse({ ...clock, battleEndAt: T0 + 700_000 }).success).toBe(
      false,
    );
  });

  it('rejects a scoring window that does not open at lock', () => {
    // §12.1: they are the same instant.
    expect(canonicalClockSchema.safeParse({ ...clock, battleStartAt: T0 + 120_000 }).success).toBe(
      false,
    );
  });
});

describe('BATTLE_STATE_UPDATE', () => {
  it('accepts a presentation-safe payload', () => {
    expect(battleStateUpdateSchema.safeParse(update).success).toBe(true);
  });

  it('rejects any attempt to attach a score', () => {
    // §24 and §48.3 forbid sending the exact score during a live battle, and
    // three delivered mockup PNGs show one. .strict() is what turns that from a
    // review item into a failing parse - without it the field would be silently
    // stripped and the leak would pass validation.
    for (const extra of [
      { leftScore: 56.3 },
      { score: { left: 56, right: 44 } },
      { leftScoreScaled: '56300000' },
      { exactScore: 56 },
    ]) {
      const result = battleStateUpdateSchema.safeParse({ ...update, ...extra });
      expect(result.success).toBe(false);
    }
  });

  it('rejects a frontline outside the unit interval', () => {
    expect(battleStateUpdateSchema.safeParse({ ...update, frontline: 1.5 }).success).toBe(false);
    expect(battleStateUpdateSchema.safeParse({ ...update, frontline: -0.1 }).success).toBe(false);
  });

  it('rejects a negative time remaining', () => {
    // A countdown that has run out reads zero, never a negative.
    expect(battleStateUpdateSchema.safeParse({ ...update, timeRemaining: -1 }).success).toBe(false);
  });

  it('accepts every declared momentum state', () => {
    for (const momentum of MOMENTUM_STATES) {
      expect(battleStateUpdateSchema.safeParse({ ...update, momentum }).success).toBe(true);
    }
  });

  it('rejects an undeclared momentum state', () => {
    expect(battleStateUpdateSchema.safeParse({ ...update, momentum: 'WINNING' }).success).toBe(
      false,
    );
  });
});

describe('ROUND_OPENED', () => {
  const matchup = (index: number) => ({
    battleId: `round-0000000001-b${String(index)}`,
    sectorId: `sector-0${String(index + 1)}`,
    left: ACTIVE_TICKERS[index * 2] ?? 'NVDA',
    right: ACTIVE_TICKERS[index * 2 + 1] ?? 'AAPL',
    leftConfidence: 'EVEN' as const,
    rightConfidence: 'FAVORED' as const,
  });

  const opened = {
    type: 'ROUND_OPENED' as const,
    eventId: 'evt-0',
    serverTime: T0,
    sequence: 0,
    roundId: 'round-0000000001',
    clock,
    matchups: [0, 1, 2, 3, 4].map(matchup),
  };

  it('accepts exactly five matchups', () => {
    expect(roundOpenedSchema.safeParse(opened).success).toBe(true);
  });

  it('rejects any other count', () => {
    // §4.3: ten stocks produce exactly five simultaneous battles.
    expect(
      roundOpenedSchema.safeParse({ ...opened, matchups: opened.matchups.slice(0, 4) }).success,
    ).toBe(false);
  });

  it('carries confidence as a label, never a number', () => {
    // §10 and Guide §7.1: no exact win probability. A numeric field would be a
    // number a UI eventually renders.
    const numeric = {
      ...opened,
      matchups: [{ ...matchup(0), leftConfidence: 67 }, ...opened.matchups.slice(1)],
    };
    expect(roundOpenedSchema.safeParse(numeric).success).toBe(false);
  });
});

describe('ROUND_FINALIZED', () => {
  const result = {
    battleId: 'round-0000000001-b0',
    left: 'NVDA' as const,
    right: 'AAPL' as const,
    winner: 'NVDA' as const,
    leftScore: { priceMomentum: 30, relativeVolume: 12, ponsPower: 9, holderCardSupport: 5 },
    rightScore: { priceMomentum: 15, relativeVolume: 13, ponsPower: 11, holderCardSupport: 5 },
    victoryLabel: 'VICTORY' as const,
    evidenceHash: 'abc123',
  };

  const finalized = {
    type: 'ROUND_FINALIZED' as const,
    eventId: 'evt-9',
    serverTime: T0 + 600_000,
    sequence: 9,
    roundId: 'round-0000000001',
    results: [result],
  };

  it('is the only event carrying exact scores', () => {
    // §12.6 reveals the breakdown at finalization and not before.
    expect(publicEventSchema.safeParse(finalized).success).toBe(true);
  });

  it('rejects a winner that did not take part', () => {
    expect(
      publicEventSchema.safeParse({
        ...finalized,
        results: [{ ...result, winner: 'TSLA' }],
      }).success,
    ).toBe(false);
  });

  it('accepts every declared victory label', () => {
    for (const victoryLabel of VICTORY_LABELS) {
      expect(
        publicEventSchema.safeParse({ ...finalized, results: [{ ...result, victoryLabel }] })
          .success,
      ).toBe(true);
    }
  });
});

describe('private events', () => {
  it('names why a pick was rejected', () => {
    // §110.5: an error says what happened and what to do. PICKS_CLOSED is the
    // §72.4 case - a request that arrived after lock even though the sender's
    // screen still showed time.
    const rejected = {
      type: 'PICK_REJECTED' as const,
      eventId: 'e',
      serverTime: T0,
      sequence: 3,
      wallet: WALLET,
      roundId: 'round-0000000001',
      reason: 'PICKS_CLOSED' as const,
    };
    expect(privateEventSchema.safeParse(rejected).success).toBe(true);
  });

  it('carries reward amounts as strings, never numbers', () => {
    // JSON has no integer wide enough. An amount sent as a number would round
    // past 2^53, and §66.3 keeps money exact across the wire too.
    const base = {
      type: 'REWARD_FINALIZED' as const,
      eventId: 'e',
      serverTime: T0,
      sequence: 4,
      wallet: WALLET,
      distributionId: 'dist-1',
    };
    expect(privateEventSchema.safeParse({ ...base, amount: '123456789012345678901' }).success).toBe(
      true,
    );
    expect(privateEventSchema.safeParse({ ...base, amount: 1234 }).success).toBe(false);
    expect(privateEventSchema.safeParse({ ...base, amount: '1.5' }).success).toBe(false);
  });
});

describe('channels', () => {
  it('accepts the declared channel families', () => {
    // §48.1, §48.2.
    expect(channelSchema.safeParse('world').success).toBe(true);
    expect(channelSchema.safeParse('round:round-0000000001').success).toBe(true);
    expect(channelSchema.safeParse('battle:round-0000000001-b0').success).toBe(true);
    expect(channelSchema.safeParse(`wallet:${WALLET}`).success).toBe(true);
  });

  it('rejects an unknown family or a malformed wallet channel', () => {
    expect(channelSchema.safeParse('admin:everything').success).toBe(false);
    expect(channelSchema.safeParse('wallet:not-an-address').success).toBe(false);
  });
});

describe('API requests', () => {
  const pick = {
    roundId: 'round-0000000001',
    battleId: 'round-0000000001-b0',
    backedTicker: 'NVDA' as const,
    cardDecision: 'USE' as const,
    clientRequestId: 'req-abcdef123456',
  };

  it('accepts a well-formed pick', () => {
    expect(pickRequestSchema.safeParse(pick).success).toBe(true);
  });

  it('refuses a client-supplied timestamp', () => {
    // §47.5: the backend stores trusted receive and commit timestamps.
    // Accepting the client's would hand a latency argument to anyone who missed
    // the lock.
    expect(pickRequestSchema.safeParse({ ...pick, submittedAt: T0 }).success).toBe(false);
  });

  it('requires an idempotency key', () => {
    // §66.6: a dropped response must not produce a second pick.
    const { clientRequestId: _omitted, ...withoutKey } = pick;
    expect(pickRequestSchema.safeParse(withoutKey).success).toBe(false);
  });

  it('rejects a reserve ticker as a pick', () => {
    // A reserve asset substitutes before a round (§4.2); it is never something
    // a player backs directly unless it is in the active roster that round.
    expect(pickRequestSchema.safeParse({ ...pick, backedTicker: 'COIN' }).success).toBe(false);
  });
});

describe('API responses', () => {
  it('cannot attach a score to a live battle', () => {
    // §47.1: a public battle response must not expose the hidden live score.
    const battle = {
      battleId: 'round-0000000001-b0',
      roundId: 'round-0000000001',
      sectorId: 'sector-01',
      left: 'NVDA' as const,
      right: 'AAPL' as const,
      leftConfidence: 'EVEN' as const,
      rightConfidence: 'EVEN' as const,
      state: 'LIVE' as const,
    };
    expect(liveBattleSchema.safeParse(battle).success).toBe(true);
    expect(liveBattleSchema.safeParse({ ...battle, leftScore: 56 }).success).toBe(false);
  });

  it('has no field for an estimated payout during an active window', () => {
    // §16.2 and §110.3 forbid it, and a delivered mockup shows one anyway.
    const rewards = {
      distributionId: 'dist-1',
      windowStart: T0,
      windowEnd: T0 + 86_400_000,
      windowWarPoints: 120,
      rewardWeight: '10954451150',
      qualified: true,
      poolBalance: '5000000000',
    };
    expect(currentRewardsSchema.safeParse(rewards).success).toBe(true);
    expect(currentRewardsSchema.safeParse({ ...rewards, estimatedSpy: '1.23' }).success).toBe(
      false,
    );
  });

  it('requires an error to answer all three questions', () => {
    // §110.5: what happened, whether state is safe, what to do next.
    const error = {
      code: 'CLAIM_FAILED',
      message: 'Claim not completed.',
      stateIsSafe: true,
      nextStep: 'Reconnect your wallet and try again.',
      correlationId: 'corr-1',
    };
    expect(apiErrorSchema.safeParse(error).success).toBe(true);

    for (const missing of ['message', 'stateIsSafe', 'nextStep'] as const) {
      const partial = Object.fromEntries(Object.entries(error).filter(([key]) => key !== missing));
      expect(apiErrorSchema.safeParse(partial).success).toBe(false);
    }
  });
});
