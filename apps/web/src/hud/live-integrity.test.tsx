// @vitest-environment jsdom
import {
  CONFIDENCE_LABELS,
  MOMENTUM_STATES,
  type ConfidenceSnapshot,
} from '@ponswars/shared-types';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientBattle } from '../state/session.js';
import { BattleIntel } from './BattleIntel.js';
import { LiveBattle } from './LiveBattle.js';

/**
 * What the live HUD may never show (§24, §12.5, §48.3, §10.2).
 *
 * The exact score is hidden for the whole live battle and revealed on the
 * result screen. Three of the delivered mockups put a live score on these
 * panels and a fourth puts `67% vs 33%` on the confidence, so the temptation
 * is real, documented, and exactly the kind of thing that returns quietly in a
 * later change. The types make it hard — `ClientBattle` carries no score — and
 * this makes it visible: what is rendered, checked for figures.
 */

const INTEL: ConfidenceSnapshot = {
  label: 'FAVORED',
  priceTrend: 'STRONG',
  volumePulse: 'RISING',
  ponsActivity: 'HIGH',
  momentumStability: 'STABLE',
};

const BATTLE: ClientBattle = {
  battleId: 'battle-1',
  sectorIndex: 0,
  left: 'NVDA',
  right: 'AAPL',
  leftIntel: INTEL,
  rightIntel: { ...INTEL, label: 'UNDERDOG' },
  momentum: 'SURGING',
  frontline: 0.63,
  backing: null,
};

/** Every word the panels put on the screen. */
function visibleText(): string {
  // `textContent` rather than `innerText`: jsdom does not lay anything out, so
  // it has no rendered text to give — and what is asserted here is what was
  // put on the screen at all, not how it was arranged.
  return document.body.textContent;
}

afterEach(cleanup);

describe('the live battle readout', () => {
  it('shows momentum in the words the engine uses, and only those', () => {
    render(<LiveBattle battle={BATTLE} showDeployedCard={false} />);

    expect(screen.getByText('SURGING')).toBeDefined();
  });

  it('puts no figure on the screen while the battle is live (§24)', () => {
    // Not a score, not a percentage, not a share of the field: the number
    // exists nowhere a component could reach, and this is what a player sees.
    render(<LiveBattle battle={BATTLE} showDeployedCard />);

    expect(visibleText()).not.toMatch(/\d/);
    expect(visibleText()).not.toContain('%');
  });

  it('keeps that true for every momentum state', () => {
    for (const momentum of MOMENTUM_STATES) {
      cleanup();
      render(<LiveBattle battle={{ ...BATTLE, momentum }} showDeployedCard />);
      expect(visibleText()).not.toMatch(/\d/);
    }
  });

  it('keeps that true wherever the frontline stands', () => {
    for (const frontline of [0, 0.07, 0.5, 0.93, 1]) {
      cleanup();
      render(<LiveBattle battle={{ ...BATTLE, frontline }} showDeployedCard />);
      expect(visibleText()).not.toMatch(/\d/);
    }
  });

  it('says who the player backed, in words', () => {
    render(
      <LiveBattle
        battle={{ ...BATTLE, backing: { ticker: 'NVDA', cardDeployed: true } }}
        showDeployedCard
      />,
    );

    expect(screen.getByText('NVDA')).toBeDefined();
    expect(screen.getByText('DEPLOYED')).toBeDefined();
  });
});

describe('the pre-battle intel', () => {
  it('shows the label the engine sent, qualitatively (§10.2)', () => {
    render(<BattleIntel ticker="NVDA" intel={INTEL} align="left" />);

    expect(screen.getByText('FAVORED')).toBeDefined();
  });

  it('never shows a confidence percentage, for any label', () => {
    // §10.2 gives a label and four sub-signals and deliberately no percentage;
    // deriving one is what the qualitative vocabulary exists to prevent.
    for (const label of CONFIDENCE_LABELS) {
      cleanup();
      render(<BattleIntel ticker="AAPL" intel={{ ...INTEL, label }} align="right" />);
      expect(visibleText()).not.toContain('%');
      expect(visibleText()).not.toMatch(/\d/);
    }
  });
});
