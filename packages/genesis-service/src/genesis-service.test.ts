import {
  baseUnits,
  parseDecimalToBaseUnits,
  RARITY_USES,
  tokenDecimals,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  checkEligibility,
  commitEntropy,
  finalizeGenesis,
  openRequest,
  resolveRequest,
  warThreshold,
  type SecretReservation,
} from './genesis-service.js';

const T0 = 1_800_000_000_000 as UtcTimestamp;
const WALLET = '0x1234567890abcdef1234567890abcdef12345678' as WalletAddress;
const BLOCK = `0x${'7f'.repeat(32)}`;
const WAR = tokenDecimals(18);
const SPY = tokenDecimals(6);

const RESERVATION: SecretReservation = {
  entitlementId: 'ent-1',
  amount: parseDecimalToBaseUnits('0.2', SPY),
  reservationTx: `0x${'cc'.repeat(32)}`,
};

/** Opens and commits a request, ready to resolve. */
const committed = (requestId = 'req-1') =>
  commitEntropy(openRequest(requestId, WALLET, T0), 1_000, BLOCK, T0);

/** Finds a request id that resolves to the given rarity under the funded table. */
const requestResolvingTo = (rarity: string, secretAvailable = true): string => {
  for (let i = 0; i < 500_000; i += 1) {
    const id = `search-${String(i)}`;
    if (resolveRequest(committed(id), secretAvailable).outcome.rarity === rarity) {
      return id;
    }
  }
  throw new Error(`No request found resolving to ${rarity}`);
};

describe('eligibility', () => {
  it('requires one million WAR held now', () => {
    // §6.
    expect(
      checkEligibility({
        warBalance: warThreshold(WAR),
        warDecimals: WAR,
        hasClaimedBefore: false,
      }),
    ).toEqual({ eligible: true });

    expect(
      checkEligibility({
        warBalance: baseUnits(warThreshold(WAR) - 1n),
        warDecimals: WAR,
        hasClaimedBefore: false,
      }),
    ).toEqual({ eligible: false, reason: 'INSUFFICIENT_WAR' });
  });

  it('converts the threshold exactly at any token precision', () => {
    // $WAR decimals are OPEN, so the locked figure must survive whatever the
    // token turns out to use.
    expect(warThreshold(tokenDecimals(18))).toBe(1_000_000_000_000_000_000_000_000n);
    expect(warThreshold(tokenDecimals(6))).toBe(1_000_000_000_000n);
  });

  it('grants one claim per wallet forever', () => {
    // §6: selling $WAR after claiming does not reset eligibility, and holding a
    // fortune does not create a second claim.
    expect(
      checkEligibility({
        warBalance: baseUnits(warThreshold(WAR) * 1_000n),
        warDecimals: WAR,
        hasClaimedBefore: true,
      }),
    ).toEqual({ eligible: false, reason: 'ALREADY_CLAIMED' });
  });

  it('imposes no holding-duration gate', () => {
    // §6 accepts that trade-off knowingly for instant onboarding. A wallet that
    // acquired $WAR a moment ago is eligible, and nothing in the input even
    // carries a holding time to gate on.
    expect(
      checkEligibility({ warBalance: warThreshold(WAR), warDecimals: WAR, hasClaimedBefore: false })
        .eligible,
    ).toBe(true);
  });
});

describe('request lifecycle', () => {
  it('opens pending with no entropy', () => {
    const request = openRequest('req-1', WALLET, T0);
    expect(request.state).toBe('PENDING');
    expect(request.entropyBlockHash).toBeNull();
  });

  it('binds a block on commit', () => {
    const request = committed();
    expect(request.state).toBe('COMMITTED');
    expect(request.entropyTargetBlock).toBe(1_000);
    expect(request.entropyBlockHash).toBe(BLOCK);
  });

  it('refuses to select a different block', () => {
    // §76.1: neither user nor backend may pick another block because the
    // resulting rarity is undesirable. The surest enforcement is having no code
    // path that overwrites one.
    expect(() => commitEntropy(committed(), 2_000, `0x${'11'.repeat(32)}`, T0)).toThrow();
  });

  it('rejects an invalid block number', () => {
    const request = openRequest('req-1', WALLET, T0);
    expect(() => commitEntropy(request, 0, BLOCK, T0)).toThrow(RangeError);
    expect(() => commitEntropy(request, 1.5, BLOCK, T0)).toThrow(RangeError);
  });

  it('refuses to resolve before entropy is committed', () => {
    expect(() => resolveRequest(openRequest('req-1', WALLET, T0), true)).toThrow();
  });
});

describe('resolution', () => {
  it('is deterministic from the committed request', () => {
    expect(resolveRequest(committed(), true).outcome).toEqual(
      resolveRequest(committed(), true).outcome,
    );
  });

  it('grants the charge count the rarity carries', () => {
    const resolved = resolveRequest(committed(), true);
    expect(resolved.initialUses).toBe(RARITY_USES[resolved.outcome.rarity]);
  });

  it('records the rarity table version', () => {
    // §76.3.
    expect(resolveRequest(committed(), true).outcome.rarityTableVersion).not.toBe(
      resolveRequest(committed(), false).outcome.rarityTableVersion,
    );
  });
});

describe('the reveal gate', () => {
  it('finalizes an ordinary card directly', () => {
    const commonId = requestResolvingTo('COMMON');
    const resolved = resolveRequest(committed(commonId), true);
    const outcome = finalizeGenesis(resolved, T0, null);

    expect(outcome.kind).toBe('REVEALABLE');
    if (outcome.kind !== 'REVEALABLE') return;
    expect(outcome.result.secretReservation).toBeNull();
    expect(outcome.request.state).toBe('FINALIZED');
  });

  it('refuses to reveal a Secret without a reservation', () => {
    // §8.4 and §76.5, the single most important ordering rule in Genesis: a
    // user must never see a successful Secret reveal without secured coverage.
    const secretId = requestResolvingTo('SECRET');
    const resolved = resolveRequest(committed(secretId), true);
    expect(resolved.outcome.rarity).toBe('SECRET');

    const outcome = finalizeGenesis(resolved, T0, null);
    expect(outcome.kind).toBe('RESERVATION_FAILED');
    if (outcome.kind !== 'RESERVATION_FAILED') return;
    // The request stays COMMITTED so recovery can retry the reservation.
    // Reissuing it would be the reroll §9 forbids.
    expect(outcome.request.state).toBe('COMMITTED');
  });

  it('reveals a Secret once the reservation is committed', () => {
    const secretId = requestResolvingTo('SECRET');
    const resolved = resolveRequest(committed(secretId), true);
    const outcome = finalizeGenesis(resolved, T0, RESERVATION);

    expect(outcome.kind).toBe('REVEALABLE');
    if (outcome.kind !== 'REVEALABLE') return;
    expect(outcome.result.rarity).toBe('SECRET');
    expect(outcome.result.secretReservation).toEqual(RESERVATION);
    // §76.5 requires the reservation reference to be committed before reveal.
    expect(outcome.result.secretReservation?.reservationTx).toBeTruthy();
  });

  it('refuses a reservation for a card that grants no reward', () => {
    // SPY set aside for a non-Secret card is coverage leaking to a winner who
    // was never owed it, and §8.3 gates the whole Secret band on that coverage.
    const commonId = requestResolvingTo('COMMON');
    const resolved = resolveRequest(committed(commonId), true);
    expect(() => finalizeGenesis(resolved, T0, RESERVATION)).toThrow(RangeError);
  });

  it('never produces a revealable Secret without coverage, across many requests', () => {
    // The property stated as a sweep rather than a single case.
    for (let i = 0; i < 3_000; i += 1) {
      const resolved = resolveRequest(committed(`sweep-${String(i)}`), true);
      if (resolved.outcome.rarity !== 'SECRET') continue;

      const withoutReservation = finalizeGenesis(resolved, T0, null);
      expect(withoutReservation.kind).toBe('RESERVATION_FAILED');
    }
  });

  it('cannot resolve to SECRET at all while the vault is uncovered', () => {
    // §8.3: the band is reassigned to Legendary, so the reveal gate is the
    // second line of defence rather than the only one.
    for (let i = 0; i < 3_000; i += 1) {
      expect(resolveRequest(committed(`dry-${String(i)}`), false).outcome.rarity).not.toBe(
        'SECRET',
      );
    }
  });
});

describe('the revealable result', () => {
  it('carries everything an audit needs to recompute it', () => {
    // §76.6 describes an audit tool taking wallet, request id, block and
    // version. The result carries each of them.
    const resolved = resolveRequest(committed('audit-1'), true);
    const outcome = finalizeGenesis(
      resolved,
      T0,
      resolved.outcome.rarity === 'SECRET' ? RESERVATION : null,
    );
    if (outcome.kind !== 'REVEALABLE') throw new Error('expected a revealable result');

    expect(outcome.result.wallet).toBe(WALLET);
    expect(outcome.result.requestId).toBe('audit-1');
    expect(outcome.result.seed).toBe(resolved.outcome.seed);
    expect(outcome.result.slot).toBe(resolved.outcome.slot);
    expect(outcome.result.rarityTableVersion).toBeTruthy();
  });
});
