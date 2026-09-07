import { describe, expect, it } from 'vitest';
import type { WalletAddress } from './ids.js';
import {
  can,
  CAPABILITIES_BY_VIEWER,
  PLAYER_CAPABILITIES,
  VIEWER_KINDS,
  winRate,
  type PlayerCapability,
  type PlayerStats,
} from './player.js';

const WALLET = '0x0000000000000000000000000000000000000001' as WalletAddress;

const stats = (overrides: Partial<PlayerStats>): PlayerStats => ({
  wallet: WALLET,
  lifetimeBattles: 0,
  lifetimeWins: 0,
  lifetimeUpsets: 0,
  lifetimeWarPoints: 0,
  currentWindowWarPoints: 0,
  ...overrides,
});

describe('viewer capabilities', () => {
  it('declares both viewer kinds', () => {
    expect([...VIEWER_KINDS]).toEqual(['SPECTATOR', 'CONNECTED']);
  });

  it('lists only known capabilities', () => {
    for (const viewer of VIEWER_KINDS) {
      for (const capability of CAPABILITIES_BY_VIEWER[viewer]) {
        expect(PLAYER_CAPABILITIES).toContain(capability);
      }
    }
  });

  it('lets a spectator watch everything public', () => {
    // §5: PonsWars must remain fully watchable without a wallet connection.
    for (const capability of [
      'VIEW_WAR_MAP',
      'INSPECT_LIVE_MATCHUPS',
      'SWITCH_BETWEEN_BATTLES',
      'VIEW_WAR_MOMENTUM',
      'VIEW_PUBLIC_RESULTS',
    ] as const satisfies readonly PlayerCapability[]) {
      expect(can('SPECTATOR', capability)).toBe(true);
    }
  });

  it('lets a spectator change nothing', () => {
    for (const capability of [
      'MAKE_PICK',
      'DEPLOY_CARD',
      'EARN_WAR_POINTS',
      'CLAIM_REWARDS',
      'VIEW_OWN_PROFILE',
    ] as const satisfies readonly PlayerCapability[]) {
      expect(can('SPECTATOR', capability)).toBe(false);
    }
  });

  it('gives a connected player every capability', () => {
    for (const capability of PLAYER_CAPABILITIES) {
      expect(can('CONNECTED', capability)).toBe(true);
    }
  });

  it('never removes a capability by connecting', () => {
    // Connecting is strictly additive. A regression that gated a public view
    // behind a wallet would break the spectator promise in §5.
    for (const capability of CAPABILITIES_BY_VIEWER.SPECTATOR) {
      expect(can('CONNECTED', capability)).toBe(true);
    }
  });

  it('lists no capability twice', () => {
    for (const viewer of VIEWER_KINDS) {
      const list = CAPABILITIES_BY_VIEWER[viewer];
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

describe('winRate', () => {
  it('returns null before any battle has resolved', () => {
    // Zero battles is not a zero win rate. Rendering 0% for a new wallet would
    // be a claim the data does not support.
    expect(winRate(stats({}))).toBeNull();
  });

  it('computes a fraction once battles exist', () => {
    expect(winRate(stats({ lifetimeBattles: 4, lifetimeWins: 1 }))).toBe(0.25);
    expect(winRate(stats({ lifetimeBattles: 3, lifetimeWins: 3 }))).toBe(1);
    expect(winRate(stats({ lifetimeBattles: 3, lifetimeWins: 0 }))).toBe(0);
  });

  it('stays within the unit interval', () => {
    for (const [battles, wins] of [
      [1, 0],
      [1, 1],
      [7, 3],
      [1_000, 999],
    ] as const) {
      const rate = winRate(stats({ lifetimeBattles: battles, lifetimeWins: wins }));
      expect(rate).not.toBeNull();
      expect(rate!).toBeGreaterThanOrEqual(0);
      expect(rate!).toBeLessThanOrEqual(1);
    }
  });
});
