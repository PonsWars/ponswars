import { describe, expect, it } from 'vitest';
import { RARITY_RATE_BPS, rarityForSlot } from './genesis.js';
import { baseUnits, parseDecimalToBaseUnits, tokenDecimals } from './money.js';
import {
  availableSecretBalance,
  isSecretRngActive,
  SECRET_ENTITLEMENT_STATES,
  SECRET_RESERVE_BEFORE_REVEAL,
  SECRET_REWARD_SPY_DECIMAL,
  SECRET_VAULT_PUBLIC_STATES,
  secretVaultPublicState,
} from './secret.js';

const SPY = tokenDecimals(6);
const REWARD = parseDecimalToBaseUnits(SECRET_REWARD_SPY_DECIMAL, SPY);
const spy = (decimal: string): ReturnType<typeof parseDecimalToBaseUnits> =>
  parseDecimalToBaseUnits(decimal, SPY);

describe('locked secret parameters', () => {
  it('fixes the reward at 0.2 SPY', () => {
    expect(SECRET_REWARD_SPY_DECIMAL).toBe('0.2');
    expect(REWARD).toBe(200_000n);
  });

  it('drops at 0.1 percent', () => {
    expect(RARITY_RATE_BPS.SECRET).toBe(10);
  });

  it('reserves before revealing', () => {
    // §8.4 — the single most important ordering constraint in Genesis. A user
    // must never see a successful Secret reveal without secured coverage.
    expect(SECRET_RESERVE_BEFORE_REVEAL).toBe(true);
  });

  it('exposes only a coarse public vault state', () => {
    // §8.6: the UI must not emphasise remaining Secret inventory.
    expect([...SECRET_VAULT_PUBLIC_STATES]).toEqual(['ACTIVE', 'DORMANT']);
  });

  it('tracks entitlements as reserved then claimed', () => {
    expect([...SECRET_ENTITLEMENT_STATES]).toEqual(['RESERVED', 'CLAIMED']);
  });
});

describe('availableSecretBalance', () => {
  it('subtracts reserved from vault balance', () => {
    // §8.3. Reserved SPY belongs to a named winner and is never available.
    expect(availableSecretBalance(spy('1'), spy('0.4'))).toBe(600_000n);
    expect(availableSecretBalance(spy('1'), spy('0'))).toBe(1_000_000n);
    expect(availableSecretBalance(spy('0.4'), spy('0.4'))).toBe(0n);
  });

  it('floors at zero rather than reporting negative coverage', () => {
    // Over-reservation is a bug, but it must not read as negative coverage and
    // then compare true against a reward amount.
    expect(availableSecretBalance(spy('0.2'), spy('1'))).toBe(0n);
  });
});

describe('isSecretRngActive', () => {
  it('is active only when coverage meets one full reward', () => {
    expect(isSecretRngActive(spy('0.2'), REWARD)).toBe(true);
    expect(isSecretRngActive(spy('0.3'), REWARD)).toBe(true);
    expect(isSecretRngActive(spy('0.199999'), REWARD)).toBe(false);
    expect(isSecretRngActive(baseUnits(0n), REWARD)).toBe(false);
  });

  it('allows one final reservation when exactly one reward remains', () => {
    // §8.4: if only 0.2 SPY remains, one final Secret may be reserved, after
    // which the vault is inactive until refunded.
    const available = availableSecretBalance(spy('0.2'), spy('0'));
    expect(isSecretRngActive(available, REWARD)).toBe(true);
    const afterReservation = availableSecretBalance(spy('0.2'), spy('0.2'));
    expect(isSecretRngActive(afterReservation, REWARD)).toBe(false);
  });
});

describe('secretVaultPublicState', () => {
  it('reads ACTIVE while covered and DORMANT once not', () => {
    expect(secretVaultPublicState(spy('1'), REWARD)).toBe('ACTIVE');
    expect(secretVaultPublicState(spy('0.2'), REWARD)).toBe('ACTIVE');
    expect(secretVaultPublicState(spy('0.1'), REWARD)).toBe('DORMANT');
    expect(secretVaultPublicState(baseUnits(0n), REWARD)).toBe('DORMANT');
  });

  it('agrees with the RNG gate at every coverage level', () => {
    // The public label must never say ACTIVE while the RNG is disabled, or a
    // player would be told a Secret is possible when it is not.
    for (const decimal of ['0', '0.000001', '0.199999', '0.2', '0.200001', '5']) {
      const available = spy(decimal);
      const active = isSecretRngActive(available, REWARD);
      expect(secretVaultPublicState(available, REWARD)).toBe(active ? 'ACTIVE' : 'DORMANT');
    }
  });
});

describe('vault coverage and the rarity table agree', () => {
  it('never yields SECRET while the vault is dormant', () => {
    // The two halves of §8.3 tied together: coverage decides availability, and
    // availability decides whether the Secret band is reachable at all.
    const available = spy('0.1');
    const active = isSecretRngActive(available, REWARD);
    expect(active).toBe(false);
    expect(rarityForSlot(999_500, active)).toBe('LEGENDARY');
  });

  it('yields SECRET in the top band once coverage returns', () => {
    const available = spy('0.2');
    const active = isSecretRngActive(available, REWARD);
    expect(active).toBe(true);
    expect(rarityForSlot(999_500, active)).toBe('SECRET');
  });
});
