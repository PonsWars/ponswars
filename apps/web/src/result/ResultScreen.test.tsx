// @vitest-environment jsdom
import {
  BATTLE_POINT_SCALE,
  totalScore,
  type BattleScoreBreakdown,
  type FinalizedBattleResult,
} from '@ponswars/shared-types';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatScore, playerResultView } from './result-view.js';
import { ResultScreen } from './ResultScreen.js';

/**
 * The battle result (§25, §26, §27.8).
 *
 * The one screen in the product that shows a score — and the one that has to
 * carry enough for a player to argue with it. §26 makes a result reproducible
 * from published evidence, so a winner announced without the four components
 * that produced it, the engine version and the evidence hash is a verdict
 * rather than a record.
 */

const POINT = Number(BATTLE_POINT_SCALE);

const LEFT: BattleScoreBreakdown = {
  priceMomentum: 24 * POINT,
  relativeVolume: 15 * POINT,
  ponsPower: 11 * POINT,
  holderCardSupport: 6.3 * POINT,
};

const RIGHT: BattleScoreBreakdown = {
  priceMomentum: 16 * POINT,
  relativeVolume: 10 * POINT,
  ponsPower: 9 * POINT,
  holderCardSupport: 8.7 * POINT,
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
  evidenceHash: '0xabc123',
} as unknown as FinalizedBattleResult;

function shown(): string {
  return document.body.textContent;
}

afterEach(cleanup);

describe('the result', () => {
  it('names the winner the engine chose and the label it earned', () => {
    render(<ResultScreen result={RESULT} player={null} />);

    expect(screen.getByText('DECISIVE VICTORY')).toBeDefined();
    expect(screen.getByText('WINNER')).toBeDefined();
  });

  it('shows each side its own total, at the scale the engine publishes', () => {
    render(<ResultScreen result={RESULT} player={null} />);

    expect(shown()).toContain(formatScore(totalScore(LEFT)));
    expect(shown()).toContain(formatScore(totalScore(RIGHT)));
  });

  it('shows all four components, so the result is a record and not a verdict (§26)', () => {
    render(<ResultScreen result={RESULT} player={null} />);

    // §12: the four the engine scores on, named the way the spec names them.
    expect(screen.getByText('SCORE BREAKDOWN')).toBeDefined();
    for (const component of ['PRICE MOMENTUM', 'RELATIVE VOLUME', 'PONS POWER', 'CARD SUPPORT']) {
      expect(screen.getByText(component)).toBeDefined();
    }
  });

  it('publishes what the result can be checked against (§26, §66.4)', () => {
    render(<ResultScreen result={RESULT} player={null} />);

    expect(shown()).toContain('battle-engine-v1');
    expect(shown()).toContain('0xabc123');
  });

  it('says nothing about a tiebreak when the totals did not tie (§12.7)', () => {
    render(<ResultScreen result={RESULT} player={null} />);

    expect(shown()).not.toContain('DECIDED BY TIEBREAK');
  });

  it('names the step when a tiebreak decided it, and the block it used', () => {
    // Hiding it would make the result look closer to arbitrary than it is —
    // and the block hash is the one input the evidence bundle does not carry.
    const tied = {
      ...RESULT,
      tiebreakStep: 'chainDerived',
      tiebreakBlockHash: '0xdeadbeef',
    } as unknown as FinalizedBattleResult;

    render(<ResultScreen result={tied} player={null} />);

    expect(shown()).toContain('DECIDED BY TIEBREAK');
    expect(shown()).toContain('0xdeadbeef');
  });
});

describe("the player's own war (§27.8)", () => {
  it('says what they backed, how it went, and what it earned', () => {
    const player = playerResultView({
      backed: 'NVDA',
      winner: 'NVDA',
      winnerConfidence: 'FAVORED',
      cardDeployed: false,
    });

    render(<ResultScreen result={RESULT} player={player} />);

    // Scoped to their own panel: both tickers are on the screen already, and
    // what is being checked is what it says about *them*.
    const panel = screen.getByText('YOUR WAR').parentElement;
    expect(panel).not.toBeNull();
    const own = within(panel!);
    expect(own.getByText('NVDA')).toBeDefined();
    expect(own.getByText('WON')).toBeDefined();
    expect(panel?.textContent).toContain(`+${String(player.warPoints)} WP`);
  });

  it('calls out an upset and a card assist when they applied (§11)', () => {
    const player = playerResultView({
      backed: 'AAPL',
      winner: 'AAPL',
      winnerConfidence: 'UNDERDOG',
      cardDeployed: true,
    });

    const upsetResult = { ...RESULT, winner: 'AAPL' } as unknown as FinalizedBattleResult;
    render(<ResultScreen result={upsetResult} player={player} />);

    expect(screen.getByText('UPSET')).toBeDefined();
    expect(screen.getByText('CARD ASSIST')).toBeDefined();
  });

  it('says a loss plainly, and awards nothing for it', () => {
    const player = playerResultView({
      backed: 'AAPL',
      winner: 'NVDA',
      winnerConfidence: 'FAVORED',
      cardDeployed: false,
    });

    render(<ResultScreen result={RESULT} player={player} />);

    expect(screen.getByText('LOST')).toBeDefined();
    expect(shown()).toContain('+0 WP');
  });

  it('shows the battle alone when the viewer had no part in it (§5)', () => {
    // Spectating is the normal case, and a panel about a war they did not
    // enter would be a panel about nothing.
    render(<ResultScreen result={RESULT} player={null} />);

    expect(screen.queryByText('YOUR WAR')).toBeNull();
  });
});
