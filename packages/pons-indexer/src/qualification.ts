import type { Ticker, UtcTimestamp, WalletAddress } from '@ponswars/shared-types';

/**
 * The Pons qualification engine (§75).
 *
 * Raw chain activity is not Pons Power. §12.3 requires activity to pass
 * anti-abuse qualification *before* scoring, and §75.5 requires operations to
 * be able to explain any final score: what was included, what was excluded, why,
 * and under which filter version.
 *
 * So this module does not return a number. It returns an aggregate with its
 * exclusions itemised, because a score nobody can account for is exactly what
 * §26 rules out.
 */

/** A normalized chain event (§75.2). Raw logs are translated before they arrive. */
export interface NormalizedActivity {
  /** Deterministic identity: transaction hash plus log index. */
  readonly eventId: string;
  readonly wallet: WalletAddress;
  readonly ticker: Ticker;
  /**
   * Economic size in integer base units.
   *
   * `bigint` for the same reason every other amount is (§66.3): a dust
   * threshold compared against a rounded float would admit or reject the wrong
   * events at the boundary.
   */
  readonly amount: bigint;
  readonly blockNumber: number;
  readonly at: UtcTimestamp;
  /** Counterparty or routing target, where the protocol exposes one. */
  readonly counterparty?: WalletAddress;
}

/** Why an event did not count. */
export const EXCLUSION_REASONS = [
  /** Below the minimum economically meaningful amount (§75.3). */
  'DUST',
  /** Repeated identical loops from one wallet (§75.3). */
  'REPEATED_LOOP',
  /** Wallet routing value to itself (§75.3). */
  'SELF_ROUTING',
  /** A known system or router address (§75.3). */
  'EXCLUDED_ADDRESS',
  /** Outside the measurement window. */
  'OUT_OF_WINDOW',
  /** Already counted. Reorg replays and retries must not double-count. */
  'DUPLICATE',
] as const;

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/**
 * Filter thresholds.
 *
 * `TUNABLE` per §75.3 — *"Exact thresholds are TUNABLE and should be calibrated
 * rather than guessed."* An input, never a compiled default, so no engineer
 * ships a calibration as product policy (§102).
 */
export interface QualificationPolicy {
  /** Smallest amount that counts as economically meaningful. */
  readonly minimumAmount: bigint;
  /**
   * How many identical-amount events from one wallet count before the rest are
   * treated as a loop.
   *
   * Not zero: a market maker legitimately repeats sizes. The filter targets a
   * wallet doing the *same* thing many times, not a wallet being active.
   */
  readonly maxIdenticalPerWallet: number;
  /** Addresses that never contribute — routers, system contracts. */
  readonly excludedAddresses: ReadonlySet<string>;
  /** Version stamped on the result, so a score stays explicable (§75.5, §73.1). */
  readonly version: string;
}

export interface QualificationWindow {
  readonly from: UtcTimestamp;
  /** Exclusive, matching the hard cutoff convention in §12.6. */
  readonly to: UtcTimestamp;
}

export interface QualificationResult {
  readonly ticker: Ticker;
  /** Events that counted. */
  readonly qualifiedCount: number;
  /** Sum of qualified amounts. */
  readonly qualifiedAmount: bigint;
  /**
   * Wallets with at least one qualified event (§75.4).
   *
   * *"A wallet counts as active only after at least one qualified event in the
   * relevant measurement window."* A wallet whose every event was filtered is
   * not active — counting it would let dust buy a wallet count.
   */
  readonly uniqueActiveWallets: number;
  /** Events that did not count, and the sum they carried. */
  readonly excludedCount: number;
  readonly excludedAmount: bigint;
  /** How many events each filter removed (§75.5). */
  readonly exclusionCounts: Readonly<Record<ExclusionReason, number>>;
  readonly version: string;
}

function emptyCounts(): Record<ExclusionReason, number> {
  return {
    DUST: 0,
    REPEATED_LOOP: 0,
    SELF_ROUTING: 0,
    EXCLUDED_ADDRESS: 0,
    OUT_OF_WINDOW: 0,
    DUPLICATE: 0,
  };
}

/**
 * Qualifies a window of activity for one ticker.
 *
 * Pure and order-independent in its result: events are sorted by block then
 * event id before the loop-detection pass, so two nodes indexing the same
 * window reach the same aggregate regardless of the order their RPC returned
 * things in.
 *
 * @throws RangeError on a malformed window or a non-positive minimum.
 */
export function qualify(
  ticker: Ticker,
  events: readonly NormalizedActivity[],
  window: QualificationWindow,
  policy: QualificationPolicy,
): QualificationResult {
  if (window.to <= window.from) {
    throw new RangeError('Qualification window must be non-empty');
  }
  if (policy.minimumAmount <= 0n) {
    throw new RangeError('Minimum amount must be positive; zero would disable the dust filter');
  }
  if (policy.maxIdenticalPerWallet < 1) {
    throw new RangeError('At least one event per identical amount must be allowed to count');
  }

  // Deterministic order, so the loop filter keeps the *same* events whichever
  // order the caller supplied. Without this, two indexers could disagree about
  // which of a wallet's repeats counted.
  const ordered = [...events].sort((a, b) =>
    a.blockNumber !== b.blockNumber
      ? a.blockNumber - b.blockNumber
      : a.eventId < b.eventId
        ? -1
        : a.eventId > b.eventId
          ? 1
          : 0,
  );

  const counts = emptyCounts();
  const seenEvents = new Set<string>();
  const identicalSeen = new Map<string, number>();
  const activeWallets = new Set<WalletAddress>();

  let qualifiedCount = 0;
  let qualifiedAmount = 0n;
  let excludedCount = 0;
  let excludedAmount = 0n;

  const exclude = (reason: ExclusionReason, amount: bigint): void => {
    counts[reason] += 1;
    excludedCount += 1;
    excludedAmount += amount;
  };

  for (const event of ordered) {
    if (event.ticker !== ticker) {
      continue;
    }
    if (seenEvents.has(event.eventId)) {
      // A reorg replay or a retried ingest must not count twice.
      exclude('DUPLICATE', event.amount);
      continue;
    }
    seenEvents.add(event.eventId);

    if (event.at < window.from || event.at >= window.to) {
      exclude('OUT_OF_WINDOW', event.amount);
      continue;
    }
    if (policy.excludedAddresses.has(event.wallet)) {
      exclude('EXCLUDED_ADDRESS', event.amount);
      continue;
    }
    if (event.counterparty !== undefined && event.counterparty === event.wallet) {
      // Value routed to itself moved nothing. §75.3 names self-recycling
      // explicitly, and it is the cheapest way to manufacture activity.
      exclude('SELF_ROUTING', event.amount);
      continue;
    }
    if (event.amount < policy.minimumAmount) {
      exclude('DUST', event.amount);
      continue;
    }

    const loopKey = `${event.wallet}|${event.amount.toString()}`;
    const repeats = identicalSeen.get(loopKey) ?? 0;
    if (repeats >= policy.maxIdenticalPerWallet) {
      exclude('REPEATED_LOOP', event.amount);
      continue;
    }
    identicalSeen.set(loopKey, repeats + 1);

    qualifiedCount += 1;
    qualifiedAmount += event.amount;
    activeWallets.add(event.wallet);
  }

  return {
    ticker,
    qualifiedCount,
    qualifiedAmount,
    uniqueActiveWallets: activeWallets.size,
    excludedCount,
    excludedAmount,
    exclusionCounts: counts,
    version: policy.version,
  };
}

/**
 * Total events considered, qualified or not.
 *
 * §75.5 asks for the included and excluded aggregates side by side; this is the
 * check that they account for everything and nothing went missing between them.
 */
export function totalConsidered(result: QualificationResult): number {
  return result.qualifiedCount + result.excludedCount;
}
