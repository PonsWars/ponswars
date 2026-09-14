import type { RewardClaims } from '@ponswars/schemas';
import { describe, expect, it } from 'vitest';
import { claimEntries } from './claims-view.js';

const CLAIMS: Extract<RewardClaims, { status: 'READ' }> = {
  status: 'READ',
  chainId: 46630,
  distributor: `0x${'d1'.repeat(20)}`,
  decimals: 18,
  claims: [
    { distributionId: '8', amount: '397490599996082683', proof: [], claimed: false },
    { distributionId: '7', amount: '1000000000000000000', proof: [], claimed: true },
    { distributionId: '6', amount: '5', proof: [], claimed: null },
  ],
};

describe('the claims list', () => {
  it('writes each reward down and says whether it can be claimed', () => {
    expect(claimEntries(CLAIMS, new Map())).toEqual([
      {
        distributionId: '8',
        label: 'REWARDS DISTRIBUTION #008',
        amount: '0.39 SPY',
        status: 'READY_TO_CLAIM',
        failure: null,
      },
      {
        distributionId: '7',
        label: 'REWARDS DISTRIBUTION #007',
        amount: '1 SPY',
        status: 'CLAIMED',
        failure: null,
      },
      // The chain did not answer: no button, rather than a claim that may revert.
      {
        distributionId: '6',
        label: 'REWARDS DISTRIBUTION #006',
        amount: '0 SPY',
        status: 'UNKNOWN',
        failure: null,
      },
    ]);
  });

  it('follows a claim in flight, and explains a failed one', () => {
    const entries = claimEntries(
      CLAIMS,
      new Map([
        ['8', { state: 'FAILED' as const, failure: 'WRONG_CHAIN' as const }],
        ['6', { state: 'CONFIRMED' as const, failure: null }],
      ]),
    );

    expect(entries[0]).toMatchObject({
      status: 'FAILED',
      failure: 'Your wallet is not on Robinhood Chain. Switch networks and try again.',
    });
    expect(entries[2]?.status).toBe('CLAIMED');
  });
});
