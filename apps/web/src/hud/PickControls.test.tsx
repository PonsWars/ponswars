// @vitest-environment jsdom
import { utcTimestamp, type CanonicalClock } from '@ponswars/shared-types';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSession, type ClientBattle, type ClientRound } from '../state/session.js';
import type { CardHolding } from './pick-flow.js';
import { PickControls } from './PickControls.js';

/**
 * Backing a side, and what the client may claim about it (§27.6, §22, §42.5).
 *
 * The one flow in the product that spends something: a Genesis card use. §22
 * makes the lock authoritative, and the rule that matters most here is the
 * negative one — a client that keeps its optimistic state after the server
 * refuses shows a player backing a stock the round never recorded, or a card
 * use they still hold.
 */

const CLOCK: CanonicalClock = {
  serverTime: utcTimestamp(1_800_000_000_000),
  pickOpenAt: utcTimestamp(1_800_000_000_000),
  lockAt: utcTimestamp(1_800_000_060_000),
  battleStartAt: utcTimestamp(1_800_000_060_000),
  battleEndAt: utcTimestamp(1_800_000_600_000),
};

const PICK_OPEN: ClientRound = {
  roundId: 'round-1',
  state: 'PICK_OPEN',
  clock: CLOCK,
  nextRoundOpensAt: utcTimestamp(1_800_000_600_000),
  feedHealth: 'HEALTHY',
};

const BATTLE: ClientBattle = {
  battleId: 'battle-1',
  sectorIndex: 0,
  left: 'NVDA',
  right: 'AAPL',
  leftIntel: {
    label: 'FAVORED',
    priceTrend: 'STRONG',
    volumePulse: 'RISING',
    ponsActivity: 'HIGH',
    momentumStability: 'STABLE',
  },
  rightIntel: {
    label: 'UNDERDOG',
    priceTrend: 'MIXED',
    volumePulse: 'NORMAL',
    ponsActivity: 'LOW',
    momentumStability: 'MIXED',
  },
  momentum: 'CONTESTED',
  frontline: 0.5,
  backing: null,
};

const CARD: CardHolding = {
  cardType: 'REINFORCEMENT',
  name: 'Reinforcement',
  rarity: 'COMMON',
  usesRemaining: 3,
};

const TAKEN = { ok: true } as const;
const REFUSED = {
  ok: false,
  message: 'Pick refused.',
  nextStep: 'Wait for the next round.',
} as const;

afterEach(() => {
  cleanup();
  useSession.setState({
    round: null,
    picks: null,
    pendingPick: null,
    cardDecision: null,
    card: null,
    pickError: null,
  });
});

describe('choosing a side', () => {
  it('offers both sides while the phase is open (§3.2)', () => {
    useSession.setState({ round: PICK_OPEN });
    render(<PickControls battle={BATTLE} />);

    // §42.5's CTA: BACK <TICKER>, named rather than coloured (§83.4).
    expect(screen.getByRole('button', { name: 'BACK NVDA' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'BACK AAPL' })).toBeDefined();
  });

  it('offers nothing to press once picks are closed (§42.1)', () => {
    // §42.1 would rather show less UI than a control that cannot be used.
    useSession.setState({ round: { ...PICK_OPEN, state: 'BATTLE_LIVE' } });
    render(<PickControls battle={BATTLE} />);

    expect(screen.getByText('SPECTATING')).toBeDefined();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('sends the pick to the gateway, for this battle and this side', async () => {
    const back = vi.fn().mockResolvedValue(TAKEN);
    useSession.setState({
      round: PICK_OPEN,
      picks: { back, withdraw: vi.fn(), decide: vi.fn() },
    });
    render(<PickControls battle={BATTLE} />);

    fireEvent.click(screen.getByRole('button', { name: 'BACK NVDA' }));

    await waitFor(() => {
      expect(back).toHaveBeenCalledWith('battle-1', 'NVDA');
    });
  });

  it('takes the pick back when the server refuses it (§22)', async () => {
    const back = vi.fn().mockResolvedValue(REFUSED);
    useSession.setState({
      round: PICK_OPEN,
      picks: { back, withdraw: vi.fn(), decide: vi.fn() },
    });
    render(<PickControls battle={BATTLE} />);

    fireEvent.click(screen.getByRole('button', { name: 'BACK AAPL' }));

    // The refusal is said in words, and the client stops claiming the pick.
    await waitFor(() => {
      expect(screen.getByText('Pick refused.')).toBeDefined();
    });
    expect(screen.getByText('Wait for the next round.')).toBeDefined();
    expect(useSession.getState().pendingPick).toBeNull();
  });

  it('says a refusal where a screen reader will hear it (§83)', async () => {
    const back = vi.fn().mockResolvedValue(REFUSED);
    useSession.setState({
      round: PICK_OPEN,
      picks: { back, withdraw: vi.fn(), decide: vi.fn() },
    });
    render(<PickControls battle={BATTLE} />);

    fireEvent.click(screen.getByRole('button', { name: 'BACK NVDA' }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Pick refused.');
    });
  });
});

describe('the card decision (§40.7)', () => {
  it('sends USE, and keeps it when the server takes it', async () => {
    const decide = vi.fn().mockResolvedValue(TAKEN);
    useSession.setState({
      round: PICK_OPEN,
      card: CARD,
      picks: { back: vi.fn().mockResolvedValue(TAKEN), withdraw: vi.fn(), decide },
      pendingPick: { battleId: 'battle-1', ticker: 'NVDA' },
    });
    render(<PickControls battle={BATTLE} />);

    fireEvent.click(screen.getByText('USE CARD'));

    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith('USE');
    });
    expect(useSession.getState().cardDecision).toBe('USE');
  });

  it('never leaves a card spent that the server refused (§22, §8)', async () => {
    const decide = vi.fn().mockResolvedValue(REFUSED);
    useSession.setState({
      round: PICK_OPEN,
      card: CARD,
      picks: { back: vi.fn().mockResolvedValue(TAKEN), withdraw: vi.fn(), decide },
      pendingPick: { battleId: 'battle-1', ticker: 'NVDA' },
    });
    render(<PickControls battle={BATTLE} />);

    fireEvent.click(screen.getByText('USE CARD'));

    await waitFor(() => {
      expect(screen.getByText('Pick refused.')).toBeDefined();
    });
    // The decision goes back to what it was: a use the player still holds.
    expect(useSession.getState().cardDecision).toBeNull();
  });
});

describe('changing a pick (§27.6, §47.5)', () => {
  it('withdraws it on the server rather than only locally', async () => {
    const withdraw = vi.fn().mockResolvedValue(TAKEN);
    useSession.setState({
      round: PICK_OPEN,
      card: CARD,
      picks: { back: vi.fn().mockResolvedValue(TAKEN), withdraw, decide: vi.fn() },
      pendingPick: { battleId: 'battle-1', ticker: 'NVDA' },
    });
    render(<PickControls battle={BATTLE} />);

    fireEvent.click(screen.getByText('CHANGE PICK'));

    await waitFor(() => {
      expect(withdraw).toHaveBeenCalled();
    });
    // Back to the start, not to a half-committed state.
    expect(useSession.getState().pendingPick).toBeNull();
    expect(useSession.getState().cardDecision).toBeNull();
  });
});
