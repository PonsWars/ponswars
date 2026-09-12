import {
  REWARD_WEIGHT_SCALE,
  battleId,
  roundId,
  utcTimestamp,
  type ActiveTicker,
  type ConfidenceLabel,
  type WalletAddress,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { HISTORY_LENGTH, playerRecord, type SettledPick } from './record.js';

/**
 * What a record says, from the picks that settled.
 *
 * Every number here is one a player can check against their own memory of the
 * battles they were in, which makes each rule a promise: a VOID is not a loss
 * (§4.4), an upset is priced from the winner's snapshotted confidence (§11),
 * and qualification is 50 window War Points (§16.4).
 */

const WALLET = '0x00000000000000000000000000000000000000aa' as WalletAddress;

let sequence = 0;

function settled(
  backed: ActiveTicker,
  outcome: { readonly winner: ActiveTicker; readonly confidence?: ConfidenceLabel } | 'VOID',
  options: { readonly card?: boolean; readonly warPoints?: number; readonly at?: number } = {},
): SettledPick {
  sequence += 1;
  return {
    roundId: roundId(`round-${String(sequence).padStart(10, '0')}`),
    battleId: battleId(`battle-${String(sequence)}`),
    left: 'NVDA',
    right: 'TSLA',
    backed,
    cardDeployed: options.card ?? false,
    settledAt: utcTimestamp(1_800_000_000_000 + (options.at ?? sequence) * 600_000),
    warPoints: options.warPoints ?? 0,
    settlement:
      outcome === 'VOID'
        ? { kind: 'VOID' }
        : {
            kind: 'DECIDED',
            winner: outcome.winner,
            winnerConfidence: outcome.confidence ?? 'EVEN',
          },
  };
}

const record = (picks: readonly SettledPick[], windowWarPoints = 0) =>
  playerRecord({ wallet: WALLET, settled: picks, windowWarPoints, window: null });

describe('a wallet that has never played', () => {
  it('has no rate rather than a rate of zero, and nothing to show off', () => {
    const empty = record([]);

    expect(empty.lifetime).toEqual({
      battles: 0,
      wins: 0,
      losses: 0,
      winRateBps: null,
      upsets: 0,
      majorUpsets: 0,
      cardAssistedWins: 0,
      warPoints: 0,
    });
    expect(empty.history).toEqual([]);
    expect(empty.mostBacked).toBeNull();
    expect(empty.biggestUpset).toBeNull();
  });
});

describe('wins and losses', () => {
  it('counts a backed winner as a win and anything else as a loss', () => {
    const result = record([
      settled('NVDA', { winner: 'NVDA' }, { warPoints: 10 }),
      settled('NVDA', { winner: 'TSLA' }),
      settled('TSLA', { winner: 'TSLA' }, { warPoints: 10 }),
    ]);

    expect(result.lifetime).toMatchObject({ battles: 3, wins: 2, losses: 1, warPoints: 20 });
    expect(result.lifetime.winRateBps).toBe(6_666);
  });

  it('never counts a VOID battle as a battle, a win or a loss (§4.4)', () => {
    const result = record([settled('NVDA', { winner: 'NVDA' }), settled('NVDA', 'VOID')]);

    expect(result.lifetime).toMatchObject({ battles: 1, wins: 1, losses: 0 });
    expect(result.history.map((entry) => entry.outcome)).toContain('VOID');
  });

  it('counts a card-assisted win only when the card was deployed and the pick won', () => {
    const result = record([
      settled('NVDA', { winner: 'NVDA' }, { card: true }),
      settled('NVDA', { winner: 'TSLA' }, { card: true }),
      settled('NVDA', { winner: 'NVDA' }),
    ]);

    expect(result.lifetime.cardAssistedWins).toBe(1);
  });
});

describe('upsets (§11)', () => {
  it('prices an upset from the winner’s confidence', () => {
    const result = record([
      settled('TSLA', { winner: 'TSLA', confidence: 'UNDERDOG' }),
      settled('TSLA', { winner: 'TSLA', confidence: 'HEAVY_UNDERDOG' }),
      settled('NVDA', { winner: 'NVDA', confidence: 'STRONG_FAVORITE' }),
      // Losing to an underdog is a loss, not an upset for this wallet.
      settled('NVDA', { winner: 'TSLA', confidence: 'HEAVY_UNDERDOG' }),
    ]);

    expect(result.lifetime).toMatchObject({ upsets: 2, majorUpsets: 1 });
  });

  it('names the most severe upset, and the newest of those', () => {
    const olderMajor = settled('TSLA', { winner: 'TSLA', confidence: 'HEAVY_UNDERDOG' }, { at: 1 });
    const newerMajor = settled('TSLA', { winner: 'TSLA', confidence: 'HEAVY_UNDERDOG' }, { at: 5 });
    const newestMinor = settled('NVDA', { winner: 'NVDA', confidence: 'UNDERDOG' }, { at: 9 });

    const result = record([olderMajor, newestMinor, newerMajor]);

    expect(result.biggestUpset).toEqual({
      roundId: newerMajor.roundId,
      winner: 'TSLA',
      loser: 'NVDA',
      outcome: 'MAJOR_UPSET',
    });
  });

  it('labels each history entry in the product’s terms', () => {
    const result = record([
      settled('NVDA', { winner: 'NVDA' }, { at: 4 }),
      settled('NVDA', { winner: 'NVDA', confidence: 'UNDERDOG' }, { at: 3 }),
      settled('NVDA', { winner: 'NVDA', confidence: 'HEAVY_UNDERDOG' }, { at: 2 }),
      settled('NVDA', { winner: 'TSLA' }, { at: 1 }),
    ]);

    expect(result.history.map((entry) => entry.outcome)).toEqual([
      'WIN',
      'UPSET_VICTORY',
      'MAJOR_UPSET',
      'LOSS',
    ]);
  });
});

describe('history', () => {
  it('lists the newest first, and in one order when battles end together', () => {
    const a = settled('NVDA', { winner: 'NVDA' }, { at: 1 });
    const b = { ...settled('NVDA', { winner: 'NVDA' }, { at: 2 }), battleId: battleId('battle-b') };
    const c = { ...settled('NVDA', { winner: 'NVDA' }, { at: 2 }), battleId: battleId('battle-a') };

    expect(record([a, b, c]).history.map((entry) => entry.battleId)).toEqual([
      battleId('battle-a'),
      battleId('battle-b'),
      a.battleId,
    ]);
    expect(record([c, a, b]).history).toEqual(record([a, b, c]).history);
  });

  it('lists a bounded page but counts every battle', () => {
    const picks = Array.from({ length: HISTORY_LENGTH + 7 }, () =>
      settled('NVDA', { winner: 'NVDA' }, { warPoints: 10 }),
    );

    const result = record(picks);

    expect(result.history).toHaveLength(HISTORY_LENGTH);
    expect(result.lifetime.battles).toBe(HISTORY_LENGTH + 7);
    expect(result.lifetime.warPoints).toBe((HISTORY_LENGTH + 7) * 10);
  });
});

describe('the most backed ticker', () => {
  it('is the one backed in the most decided battles', () => {
    const result = record([
      settled('TSLA', { winner: 'NVDA' }),
      settled('TSLA', { winner: 'TSLA' }),
      settled('NVDA', { winner: 'NVDA' }),
      settled('NVDA', 'VOID'),
      settled('NVDA', 'VOID'),
    ]);

    expect(result.mostBacked).toEqual({ ticker: 'TSLA', battles: 2, winRateBps: 5_000 });
  });

  it('breaks a tie by record, then by name', () => {
    expect(
      record([settled('TSLA', { winner: 'TSLA' }), settled('NVDA', { winner: 'TSLA' })]).mostBacked
        ?.ticker,
    ).toBe('TSLA');
    expect(
      record([settled('TSLA', { winner: 'TSLA' }), settled('NVDA', { winner: 'NVDA' })]).mostBacked
        ?.ticker,
    ).toBe('NVDA');
  });
});

describe('the current window (§16)', () => {
  it('qualifies at 50 War Points and not at 49', () => {
    expect(record([], 49).currentWindow.qualified).toBe(false);
    expect(record([], 50).currentWindow.qualified).toBe(true);
  });

  it('weighs a wallet by the square root of its window War Points', () => {
    expect(record([], 100).currentWindow.weight).toBe((10n * REWARD_WEIGHT_SCALE).toString());
  });

  it('carries the window only when one is open', () => {
    const window = { distributionId: 'dist-7', closesAt: utcTimestamp(1_800_086_400_000) };

    expect(record([], 60).currentWindow.window).toBeNull();
    expect(
      playerRecord({ wallet: WALLET, settled: [], windowWarPoints: 60, window }).currentWindow
        .window,
    ).toEqual(window);
  });
});
