import {
  applyBasisPoints,
  baseUnits,
  MIN_QUALIFYING_WP,
  mulDivFloor,
  PER_WALLET_CAP_BPS,
  POOL_DISTRIBUTABLE_BPS,
  qualifiesForDistribution,
  rewardWeight,
  type BaseUnits,
  type WalletAddress,
} from '@ponswars/shared-types';

/**
 * The 24-hour Rewards Distribution allocation procedure.
 *
 * Masterplan §16 (distribution), §77 (detailed procedure).
 *
 * Every amount is `bigint` base units (§66.3). The module's central guarantee
 * is conservation: **allocated + carried forward equals the distributable pool
 * exactly**, for every input. No SPY is created and none is lost.
 */

/** One wallet's window standing, as read from the WP ledger at snapshot. */
export interface WalletStanding {
  readonly wallet: WalletAddress;
  /** War Points earned in this window. Lifetime WP is not used here (§16.2). */
  readonly windowWarPoints: number;
}

/** What a qualified wallet receives. */
export interface WalletAllocation {
  readonly wallet: WalletAddress;
  readonly windowWarPoints: number;
  /** `sqrt(WP)`, scaled (§16.5). Retained so an allocation is checkable. */
  readonly weight: bigint;
  /** Amount claimable this window. Zero when below the claim threshold. */
  readonly amount: BaseUnits;
  /** True when the 2% per-wallet cap bound this wallet (§16.6). */
  readonly capped: boolean;
  /**
   * Amount that fell below the minimum claim threshold and rolls forward
   * instead of being claimable (§16.7).
   */
  readonly carriedForward: BaseUnits;
}

export interface AllocationInput {
  /** Rewards Distribution pool balance read at snapshot (§16.3). */
  readonly poolBalance: BaseUnits;
  /** Every wallet with any window War Points. Filtering happens here. */
  readonly standings: readonly WalletStanding[];
  /**
   * Minimum claimable amount (§16.7).
   *
   * `BASELINE` in the masterplan and supplied from configuration, because the
   * figure decides who gets paid this window rather than carried forward.
   */
  readonly minimumClaim: BaseUnits;
}

export interface AllocationResult {
  /** Only qualified wallets, in descending weight then ascending address. */
  readonly allocations: readonly WalletAllocation[];
  /** 80% of the pool (§16.3). */
  readonly distributable: BaseUnits;
  /** 20% buffer, plus everything not allocated this window (§16.3, §16.7). */
  readonly carriedForward: BaseUnits;
  /** Sum of every claimable amount. */
  readonly totalAllocated: BaseUnits;
  /** Sum of `sqrt(WP)` across qualified wallets. */
  readonly totalWeight: bigint;
  /** How many wallets the 2% cap bound. */
  readonly cappedWalletCount: number;
  /** Wallets that had War Points but did not reach the 50 WP floor (§16.4). */
  readonly unqualifiedWalletCount: number;
}

/**
 * Runs the allocation for one window.
 *
 * The procedure follows §16 in order: snapshot the pool, take 80% as
 * distributable, drop wallets below 50 WP, weight the rest by `sqrt(WP)`,
 * allocate proportionally, apply the 2% cap and redistribute the excess, then
 * carry forward anything below the claim threshold.
 *
 * ### Cap redistribution
 *
 * §16.6 says excess above the cap *"is redistributed among other qualified
 * users according to the allocation algorithm"*. Redistributing can push
 * another wallet over the cap, so the pass repeats until no uncapped wallet
 * exceeds the cap. It terminates because each pass either caps at least one
 * more wallet or changes nothing, and there are finitely many wallets.
 *
 * ### An ambiguity, resolved explicitly
 *
 * §16.6 caps a wallet at *"2% of the distribution pool"* while §16.5 computes
 * from `distributablePool`. This implementation reads both as the same
 * quantity — the 80% distributable amount — because §16.5 names it that way and
 * a cap measured against a base nobody is paid from would be arbitrary. If the
 * intent was 2% of the *full* pool, the cap is 2.5% of what is actually
 * distributed, and this needs a masterplan clarification rather than a code
 * change made quietly.
 */
export function allocateDistribution(input: AllocationInput): AllocationResult {
  const { poolBalance, standings, minimumClaim } = input;

  if (poolBalance < 0n) {
    throw new RangeError('Pool balance must not be negative');
  }
  if (minimumClaim < 0n) {
    throw new RangeError('Minimum claim threshold must not be negative');
  }
  const seen = new Set<WalletAddress>();
  for (const standing of standings) {
    if (seen.has(standing.wallet)) {
      throw new RangeError(`Wallet ${standing.wallet} appears twice in the standings`);
    }
    seen.add(standing.wallet);
    if (!Number.isInteger(standing.windowWarPoints) || standing.windowWarPoints < 0) {
      throw new RangeError(
        `Window War Points must be a non-negative integer for ${standing.wallet}`,
      );
    }
  }

  const distributable = applyBasisPoints(poolBalance, POOL_DISTRIBUTABLE_BPS);

  const qualified = standings.filter((standing) =>
    qualifiesForDistribution(standing.windowWarPoints),
  );
  const unqualifiedWalletCount = standings.length - qualified.length;

  if (qualified.length === 0 || distributable === 0n) {
    // Nothing to divide, or nobody to divide it among. The whole pool carries
    // forward rather than being stranded (§16.7).
    return {
      allocations: [],
      distributable,
      carriedForward: baseUnits(poolBalance),
      totalAllocated: baseUnits(0n),
      totalWeight: 0n,
      cappedWalletCount: 0,
      unqualifiedWalletCount,
    };
  }

  // Deterministic ordering. Two wallets with equal War Points must allocate in
  // a stable order, or the same snapshot could produce two different Merkle
  // roots depending on how the rows came back from the database.
  const ordered = [...qualified].sort((a, b) => {
    if (b.windowWarPoints !== a.windowWarPoints) {
      return b.windowWarPoints - a.windowWarPoints;
    }
    return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0;
  });

  const weights = new Map<WalletAddress, bigint>();
  for (const standing of ordered) {
    weights.set(standing.wallet, rewardWeight(standing.windowWarPoints));
  }
  const totalWeight = ordered.reduce((sum, s) => sum + (weights.get(s.wallet) ?? 0n), 0n);

  const cap = applyBasisPoints(distributable, PER_WALLET_CAP_BPS);
  const capped = new Set<WalletAddress>();
  const amounts = new Map<WalletAddress, bigint>();

  // Iterate until the cap is stable. Each pass shares whatever is left among
  // the wallets the cap has not yet bound.
  for (;;) {
    // Plain bigints: these are running totals mid-computation, not amounts a
    // wallet is owed. Branding them would claim a settled meaning they do not
    // have until the pass finishes.
    let remaining: bigint = distributable;
    let remainingWeight = 0n;
    for (const standing of ordered) {
      if (capped.has(standing.wallet)) {
        remaining -= cap;
      } else {
        remainingWeight += weights.get(standing.wallet) ?? 0n;
      }
    }

    if (remaining < 0n) {
      // More wallets are capped than the pool can pay at the cap. Only possible
      // when the cap exceeds an equal share, which means every wallet is capped
      // and the loop below will not add more.
      remaining = 0n;
    }

    let newlyCapped = false;
    for (const standing of ordered) {
      if (capped.has(standing.wallet)) {
        amounts.set(standing.wallet, cap);
        continue;
      }
      const weight = weights.get(standing.wallet) ?? 0n;
      const amount =
        remainingWeight === 0n ? 0n : mulDivFloor(baseUnits(remaining), weight, remainingWeight);
      if (amount > cap) {
        capped.add(standing.wallet);
        newlyCapped = true;
      }
      amounts.set(standing.wallet, amount);
    }

    if (!newlyCapped) {
      break;
    }
  }

  // Apply the claim threshold last, so a wallet is measured against it on the
  // amount it would actually have received (§16.7).
  const allocations: WalletAllocation[] = ordered.map((standing) => {
    const amount = amounts.get(standing.wallet) ?? 0n;
    const claimable = amount >= minimumClaim;
    return {
      wallet: standing.wallet,
      windowWarPoints: standing.windowWarPoints,
      weight: weights.get(standing.wallet) ?? 0n,
      amount: baseUnits(claimable ? amount : 0n),
      capped: capped.has(standing.wallet),
      carriedForward: baseUnits(claimable ? 0n : amount),
    };
  });

  const totalAllocated = allocations.reduce((sum, a) => sum + a.amount, 0n);

  // Everything not paid out this window rolls forward: the 20% buffer, the
  // flooring remainder, amounts below the threshold, and any residue left when
  // the cap binds every wallet.
  const carriedForward = baseUnits(poolBalance - totalAllocated);

  return {
    allocations,
    distributable,
    carriedForward,
    totalAllocated: baseUnits(totalAllocated),
    totalWeight,
    cappedWalletCount: capped.size,
    unqualifiedWalletCount,
  };
}

/** The 50 WP qualification floor, re-exported so callers need one import. */
export { MIN_QUALIFYING_WP };
