import type { SecretClaim } from '@ponswars/schemas';
import { describe, expect, it } from 'vitest';
import { secretClaimView } from './secret-view.js';

const READ = (entitlement: 'NONE' | 'RESERVED' | 'CLAIMED'): SecretClaim => ({
  status: 'READ',
  chainId: 4663,
  vault: `0x${'5e'.repeat(20)}`,
  decimals: 6,
  amount: '200000',
  entitlement,
});

describe('secretClaimView', () => {
  it('shows nothing to a wallet that holds no Secret', () => {
    expect(secretClaimView(READ('NONE'), null)).toBeNull();
  });

  it('shows nothing when the vault could not be read, rather than "you have none"', () => {
    // §8.5 gives a reservation no expiry. A slow endpoint must not read as one
    // that has gone, so an unread vault says nothing at all.
    expect(secretClaimView({ status: 'UNAVAILABLE' }, null)).toBeNull();
  });

  it('offers the claim to a wallet holding a reserved Secret', () => {
    const view = secretClaimView(READ('RESERVED'), null);

    expect(view).toMatchObject({
      amount: '0.2 SPY',
      status: 'READY_TO_CLAIM',
      headline: 'READY TO CLAIM',
      actionable: true,
    });
  });

  it('keeps the trophy on a claimed Secret, with no button', () => {
    const view = secretClaimView(READ('CLAIMED'), null);

    expect(view).toMatchObject({ status: 'CLAIMED', actionable: false });
  });

  it('says a confirmed claim is claimed before the vault is read again', () => {
    const view = secretClaimView(READ('RESERVED'), { state: 'CONFIRMED', failure: null });

    expect(view?.status).toBe('CLAIMED');
  });

  it('says what a failure was, and that the reward is still there', () => {
    const view = secretClaimView(READ('RESERVED'), { state: 'FAILED', failure: 'DECLINED' });

    expect(view).toMatchObject({ status: 'FAILED', actionable: true });
    expect(view?.detail).toContain('not approved');
  });
});
