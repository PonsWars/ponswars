import {
  CONFIDENCE_LABELS,
  totalScore,
  WP_AWARDS,
  type BattleScoreBreakdown,
  type FinalizedBattleResult,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { formatScore, playerResultView, resultView } from './result-view.js';

const LEFT: BattleScoreBreakdown = {
  priceMomentum: 240,
  relativeVolume: 150,
  ponsPower: 110,
  holderCardSupport: 63,
};

const RIGHT: BattleScoreBreakdown = {
  priceMomentum: 160,
  relativeVolume: 100,
  ponsPower: 90,
  holderCardSupport: 87,
};

const RESULT = {
  battleId: 'b-1',
  roundId: 'r-1',
  left: 'NVDA',
  right: 'AAPL',
  winner: 'NVDA',
  leftScore: LEFT,
  rightScore: RIGHT,
  victoryLabel: 'DECISIVE_VICTORY',
  scoringEngineVersion: 'battle-engine-v1',
  finalizedAt: 1_800_000_000_000,
  evidenceHash: '0xabc',
} as unknown as FinalizedBattleResult;

describe('resultView', () => {
  it('reports the winner the engine chose rather than deciding one', () => {
    // §61 principle 3: every spectator converges on the same finalized result.
    // A client that picked a winner by comparing totals could disagree with the
    // record whenever a tiebreak decided it (§12.7).
    const view = resultView(RESULT);
    expect(view.winner).toBe('NVDA');
    expect(view.left.won).toBe(true);
    expect(view.right.won).toBe(false);
  });

  it('shows each side total as the sum of its own components', () => {
    const view = resultView(RESULT);
    expect(view.left.totalLabel).toBe(formatScore(totalScore(LEFT)));
    expect(view.right.totalLabel).toBe(formatScore(totalScore(RIGHT)));
  });

  it('keeps the two sides summing to a hundred points', () => {
    // §12: the two shares are of one hundred. If the displayed halves did not
    // add up, the screen whose job is to show the working would be the thing
    // undermining it.
    expect(totalScore(LEFT) + totalScore(RIGHT)).toBe(1_000);
  });

  it('carries the provenance a result can be argued with', () => {
    const view = resultView(RESULT);
    expect(view.scoringEngineVersion).toBe('battle-engine-v1');
    expect(view.evidenceHash).toBe('0xabc');
  });

  it('surfaces a tiebreak step only when one ran', () => {
    expect(resultView(RESULT).tiebreakStep).toBeNull();
    const tied = { ...RESULT, tiebreakStep: 'PRICE_MOMENTUM' } as unknown as FinalizedBattleResult;
    expect(resultView(tied).tiebreakStep).toBe('PRICE_MOMENTUM');
  });
});

describe('formatScore', () => {
  it('places the separator without rounding', () => {
    expect(formatScore(563)).toBe('56.3');
    expect(formatScore(437)).toBe('43.7');
    expect(formatScore(1_000)).toBe('100.0');
    expect(formatScore(0)).toBe('0.0');
  });

  it('handles a single digit of tenths', () => {
    expect(formatScore(5)).toBe('0.5');
  });

  it('refuses a fractional input rather than inventing precision', () => {
    // The engine works in whole tenths (§66.4). A fraction here means someone
    // has already divided, and the honest response is to say so.
    expect(() => formatScore(56.35)).toThrow(RangeError);
  });
});

describe('playerResultView', () => {
  it('awards the locked table value for a win', () => {
    const view = playerResultView({
      backed: 'NVDA',
      winner: 'NVDA',
      winnerConfidence: 'FAVORED',
      cardDeployed: false,
    });
    expect(view.won).toBe(true);
    expect(view.warPoints).toBe(WP_AWARDS.WIN);
  });

  it('adds the card assist on top of the base award', () => {
    const view = playerResultView({
      backed: 'NVDA',
      winner: 'NVDA',
      winnerConfidence: 'FAVORED',
      cardDeployed: true,
    });
    expect(view.warPoints).toBe(WP_AWARDS.WIN + WP_AWARDS.CARD_ASSIST);
    expect(view.cardAssist).toBe(true);
  });

  it('pays the underdog rates for an upset', () => {
    expect(
      playerResultView({
        backed: 'GME',
        winner: 'GME',
        winnerConfidence: 'UNDERDOG',
        cardDeployed: false,
      }).warPoints,
    ).toBe(WP_AWARDS.UNDERDOG_WIN);
    expect(
      playerResultView({
        backed: 'GME',
        winner: 'GME',
        winnerConfidence: 'HEAVY_UNDERDOG',
        cardDeployed: false,
      }).warPoints,
    ).toBe(WP_AWARDS.HEAVY_UNDERDOG_WIN);
  });

  it('earns nothing for a loss, whatever the card did', () => {
    for (const confidence of CONFIDENCE_LABELS) {
      for (const cardDeployed of [true, false]) {
        const view = playerResultView({
          backed: 'AAPL',
          winner: 'NVDA',
          winnerConfidence: confidence,
          cardDeployed,
        });
        expect(view.won).toBe(false);
        expect(view.warPoints).toBe(0);
        expect(view.cardAssist).toBe(false);
        expect(view.upset).toBe(false);
      }
    }
  });

  it('marks an upset only for the underdog labels', () => {
    const upsets = CONFIDENCE_LABELS.filter(
      (confidence) =>
        playerResultView({
          backed: 'GME',
          winner: 'GME',
          winnerConfidence: confidence,
          cardDeployed: false,
        }).upset,
    );
    expect([...upsets]).toEqual(['HEAVY_UNDERDOG', 'UNDERDOG']);
  });
});
