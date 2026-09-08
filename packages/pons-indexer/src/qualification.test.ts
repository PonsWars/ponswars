import type { UtcTimestamp, WalletAddress } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  EXCLUSION_REASONS,
  qualify,
  totalConsidered,
  type NormalizedActivity,
  type QualificationPolicy,
  type QualificationWindow,
} from './qualification.js';

const T0 = 1_800_000_000_000 as UtcTimestamp;
const at = (offset: number): UtcTimestamp => (T0 + offset) as UtcTimestamp;

const WINDOW: QualificationWindow = { from: T0, to: at(600_000) };
const ROUTER = '0x00000000000000000000000000000000000f0000' as WalletAddress;

const POLICY: QualificationPolicy = {
  minimumAmount: 1_000n,
  maxIdenticalPerWallet: 3,
  excludedAddresses: new Set([ROUTER]),
  version: 'pons-qualification-v1',
};

const wallet = (n: number): WalletAddress =>
  `0x${n.toString(16).padStart(40, '0')}` as WalletAddress;

let sequence = 0;
const event = (overrides: Partial<NormalizedActivity> = {}): NormalizedActivity => {
  sequence += 1;
  return {
    eventId: `0xtx${String(sequence).padStart(4, '0')}:0`,
    wallet: wallet(1),
    ticker: 'NVDA',
    amount: 5_000n,
    blockNumber: 1_000 + sequence,
    at: at(1_000 * sequence),
    ...overrides,
  };
};

const run = (events: readonly NormalizedActivity[], policy = POLICY) =>
  qualify('NVDA', events, WINDOW, policy);

describe('qualification basics', () => {
  it('counts ordinary activity', () => {
    const result = run([event(), event({ wallet: wallet(2) })]);
    expect(result.qualifiedCount).toBe(2);
    expect(result.qualifiedAmount).toBe(10_000n);
    expect(result.uniqueActiveWallets).toBe(2);
    expect(result.excludedCount).toBe(0);
  });

  it('stamps the filter version', () => {
    // §75.5 and §73.1: a Pons score has to say which filter produced it, or a
    // replay after tuning cannot reproduce it.
    expect(run([event()]).version).toBe('pons-qualification-v1');
  });

  it('accounts for every event it was given', () => {
    // §75.5 asks for the included and excluded aggregates side by side. Nothing
    // may fall between them.
    const events = [
      event(),
      event({ amount: 1n }),
      event({ wallet: ROUTER }),
      event({ at: at(900_000) }),
    ];
    const result = run(events);
    expect(totalConsidered(result)).toBe(events.length);
  });

  it('ignores events for another ticker entirely', () => {
    // Not an exclusion: an AAPL event is not AAPL activity that failed NVDA's
    // filters, it is simply not in this aggregate.
    const result = run([event(), event({ ticker: 'AAPL' })]);
    expect(result.qualifiedCount).toBe(1);
    expect(totalConsidered(result)).toBe(1);
  });
});

describe('filters', () => {
  it('excludes dust', () => {
    // §75.3: a minimum economically meaningful amount. Without it, a fraction
    // of a cent repeated cheaply buys Pons Power.
    const result = run([event({ amount: 999n }), event({ amount: 1_000n })]);
    expect(result.qualifiedCount).toBe(1);
    expect(result.exclusionCounts.DUST).toBe(1);
  });

  it('excludes self-routing', () => {
    // §75.3: value routed to itself moved nothing, and it is the cheapest way
    // to manufacture activity.
    const self = wallet(9);
    const result = run([event({ wallet: self, counterparty: self })]);
    expect(result.qualifiedCount).toBe(0);
    expect(result.exclusionCounts.SELF_ROUTING).toBe(1);
  });

  it('excludes known router and system addresses', () => {
    const result = run([event({ wallet: ROUTER })]);
    expect(result.exclusionCounts.EXCLUDED_ADDRESS).toBe(1);
  });

  it('excludes events outside the window', () => {
    // The lower bound is inclusive and the upper exclusive, matching the §12.6
    // hard cutoff convention: an event at the closing instant is outside.
    const result = run([
      event({ at: at(-1) }),
      event({ at: at(0) }),
      event({ at: at(599_999) }),
      event({ at: at(600_000) }),
    ]);
    expect(result.qualifiedCount).toBe(2);
    expect(result.exclusionCounts.OUT_OF_WINDOW).toBe(2);
  });

  it('excludes a duplicate event id', () => {
    // A reorg replay or a retried ingest must not count twice.
    const once = event();
    const result = run([once, { ...once }]);
    expect(result.qualifiedCount).toBe(1);
    expect(result.exclusionCounts.DUPLICATE).toBe(1);
  });

  it('caps identical repeats from one wallet', () => {
    // §75.3 targets a wallet doing the same thing many times. The cap is not
    // zero: a market maker legitimately repeats sizes, so being active is fine
    // and being a loop is not.
    const events = Array.from({ length: 10 }, () => event({ amount: 5_000n }));
    const result = run(events);
    expect(result.qualifiedCount).toBe(POLICY.maxIdenticalPerWallet);
    expect(result.exclusionCounts.REPEATED_LOOP).toBe(10 - POLICY.maxIdenticalPerWallet);
  });

  it('counts the same repeats from different wallets separately', () => {
    // Two wallets trading the same size is a market, not a loop.
    const events = Array.from({ length: 10 }, (_, i) =>
      event({ amount: 5_000n, wallet: wallet(100 + i) }),
    );
    expect(run(events).qualifiedCount).toBe(10);
  });

  it('counts different amounts from one wallet separately', () => {
    const events = Array.from({ length: 10 }, (_, i) => event({ amount: 5_000n + BigInt(i) }));
    expect(run(events).qualifiedCount).toBe(10);
  });
});

describe('unique active wallets', () => {
  it('counts a wallet only after a qualified event', () => {
    // §75.4 exactly. A wallet whose every event was filtered is not active —
    // counting it would let dust buy a wallet count, which is 30% of Pons
    // Power under §12.3.
    const duster = wallet(50);
    const result = run([
      event({ wallet: duster, amount: 1n }),
      event({ wallet: duster, amount: 2n }),
      event({ wallet: wallet(51), amount: 5_000n }),
    ]);
    expect(result.uniqueActiveWallets).toBe(1);
  });

  it('counts a wallet once however many times it qualifies', () => {
    const result = run([
      event({ wallet: wallet(60), amount: 5_000n }),
      event({ wallet: wallet(60), amount: 6_000n }),
      event({ wallet: wallet(60), amount: 7_000n }),
    ]);
    expect(result.qualifiedCount).toBe(3);
    expect(result.uniqueActiveWallets).toBe(1);
  });
});

describe('determinism', () => {
  it('is independent of the order events arrive in', () => {
    // RPC ordering is not guaranteed. If it changed which of a wallet's
    // repeats counted, two indexers would disagree about the same window and
    // the battle score would depend on which one answered.
    const events = [
      event({ amount: 5_000n }),
      event({ amount: 5_000n }),
      event({ amount: 5_000n }),
      event({ amount: 5_000n }),
      event({ amount: 9_000n, wallet: wallet(2) }),
    ];
    const forward = run(events);
    const reversed = run([...events].reverse());
    expect(reversed).toEqual(forward);
  });

  it('produces the same aggregate on repeated evaluation', () => {
    const events = Array.from({ length: 40 }, (_, i) =>
      event({ amount: BigInt(1_000 + i * 37), wallet: wallet(i % 7) }),
    );
    expect(run(events)).toEqual(run(events));
  });
});

describe('input validation', () => {
  it('rejects an empty window', () => {
    expect(() => qualify('NVDA', [], { from: T0, to: T0 }, POLICY)).toThrow(RangeError);
  });

  it('rejects a zero minimum, which would disable the dust filter', () => {
    expect(() => run([], { ...POLICY, minimumAmount: 0n })).toThrow(RangeError);
  });

  it('rejects a cap that would exclude every repeat', () => {
    expect(() => run([], { ...POLICY, maxIdenticalPerWallet: 0 })).toThrow(RangeError);
  });
});

describe('exclusion reporting', () => {
  it('reports a count for every declared reason', () => {
    // §75.5: operations must be able to retrieve filter reason counts. A
    // missing key would read as "never happened" rather than "zero".
    const result = run([event()]);
    for (const reason of EXCLUSION_REASONS) {
      expect(result.exclusionCounts[reason]).toBeDefined();
    }
  });

  it('separates the excluded aggregate from the included one', () => {
    const result = run([event({ amount: 5_000n }), event({ amount: 10n })]);
    expect(result.qualifiedAmount).toBe(5_000n);
    expect(result.excludedAmount).toBe(10n);
  });
});
