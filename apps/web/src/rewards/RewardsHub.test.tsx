// @vitest-environment jsdom
import { utcTimestamp } from '@ponswars/shared-types';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeWindowView, finalizedWindowView } from './reward-view.js';
import { RewardsHub } from './RewardsHub.js';

/**
 * What the Rewards Hub may say about money (§35, §16).
 *
 * The other place in the product where value moves. §35.2 bans an estimated
 * SPY figure while a window is open, and one of the delivered mockups shows
 * one — so the ban is documented, tempting, and worth holding to what a player
 * actually sees rather than to the shape of a type.
 */

const OPEN = activeWindowView({
  distributionId: 42,
  warPoints: 900,
  closesAt: utcTimestamp(1_800_000_600_000),
});

const PUBLISHED = finalizedWindowView({
  distributionId: 42,
  warPoints: 900,
  allocation: '12.4821',
  carriedForward: false,
  capReached: false,
});

const POOL = { balance: '104,500.00' };

function shown(): string {
  return document.body.textContent;
}

afterEach(cleanup);

describe('while the window is open (§35.2)', () => {
  it('shows no reward figure for this wallet, and says why', () => {
    render(<RewardsHub view={OPEN} pool={POOL} claim={null} onClaim={vi.fn()} />);

    // The blank is stated rather than left as a gap that reads as a failure.
    expect(screen.getByText('YOUR REWARD (LIVE WINDOW)')).toBeDefined();
    expect(shown()).toContain('— — — SPY');
    expect(shown()).toContain('no estimates during an open window');
  });

  it("puts no figure in the wallet's reward panel at all", () => {
    render(<RewardsHub view={OPEN} pool={POOL} claim={null} onClaim={vi.fn()} />);

    // Scoped to that panel on purpose: the pool's own balance is a published
    // fact and may be shown. What §35.2 bans is a figure for *this wallet*
    // while the window is open.
    const panel = screen.getByText('YOUR REWARD (LIVE WINDOW)').parentElement;
    expect(panel?.textContent).not.toMatch(/\d/);
  });

  it('offers nothing to claim yet', () => {
    render(<RewardsHub view={OPEN} pool={POOL} claim={null} onClaim={vi.fn()} />);

    expect(screen.queryByText('CLAIM')).toBeNull();
    expect(shown()).not.toContain('FINAL ALLOCATION');
  });

  it('says what is still needed to qualify (§16.4)', () => {
    const short = activeWindowView({
      distributionId: 42,
      warPoints: 10,
      closesAt: utcTimestamp(1_800_000_600_000),
    });

    render(<RewardsHub view={short} pool={POOL} claim={null} onClaim={vi.fn()} />);

    // A weight below the floor earns nothing, and showing one would invite the
    // reading that a share is already accruing.
    expect(shown()).not.toContain('YOUR REWARD WEIGHT');
  });
});

describe('once the distribution is published (§35.4)', () => {
  it('shows the final allocation and offers the claim', () => {
    render(<RewardsHub view={PUBLISHED} pool={POOL} claim="READY_TO_CLAIM" onClaim={vi.fn()} />);

    expect(screen.getByText('FINAL ALLOCATION')).toBeDefined();
    expect(shown()).toContain('12.4821 SPY');
    expect(screen.getByText('CLAIM')).toBeDefined();
  });

  it('claims when the control is pressed', () => {
    const onClaim = vi.fn();
    render(<RewardsHub view={PUBLISHED} pool={POOL} claim="READY_TO_CLAIM" onClaim={onClaim} />);

    fireEvent.click(screen.getByText('CLAIM'));

    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  it('says a failed claim did not take the allocation away (§35.6)', () => {
    render(<RewardsHub view={PUBLISHED} pool={POOL} claim="FAILED" onClaim={vi.fn()} />);

    expect(screen.getByText('CLAIM NOT COMPLETED')).toBeDefined();
    expect(shown()).toContain('Your allocation is still available.');
    // And the way back is offered rather than described.
    expect(screen.getByText('TRY AGAIN')).toBeDefined();
  });

  it('says a carried-forward reward is not lost (§16.7, §35.5)', () => {
    const carried = finalizedWindowView({
      distributionId: 42,
      warPoints: 900,
      allocation: '0.0004',
      carriedForward: true,
      capReached: false,
    });

    render(<RewardsHub view={carried} pool={POOL} claim={null} onClaim={vi.fn()} />);

    expect(screen.getByText('CARRIED FORWARD')).toBeDefined();
    expect(shown()).toContain('It is not lost.');
    // Nothing to claim: it rolls into the next distribution instead.
    expect(screen.queryByText('CLAIM')).toBeNull();
  });

  it('says when the per-wallet cap was reached (§16.6, §35.8)', () => {
    const capped = finalizedWindowView({
      distributionId: 42,
      warPoints: 90_000,
      allocation: '210.0000',
      carriedForward: false,
      capReached: true,
    });

    render(<RewardsHub view={capped} pool={POOL} claim="READY_TO_CLAIM" onClaim={vi.fn()} />);

    expect(screen.getByText('MAX ALLOCATION CAP REACHED')).toBeDefined();
  });
});
