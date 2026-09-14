import type { RewardClaims } from '@ponswars/schemas';
import { formatTokenAmount } from '../presentation/token-amount.js';
import { claimFailureDetail, type ClaimFailure } from './claim-runner.js';
import type { ClaimState } from './reward-view.js';

/**
 * The wallet's published rewards, as the hub lists them (§35.4, §35.6).
 *
 * Formatting and the claim state machine only. Amounts, proofs and whether a
 * reward was claimed are the server's and the contract's.
 */
export interface ClaimEntryView {
  readonly distributionId: string;
  /** `REWARDS DISTRIBUTION #008`. */
  readonly label: string;
  /** `0.39 SPY`, truncated, never rounded up. */
  readonly amount: string;
  /**
   * `CLAIMED` as the contract says; `UNKNOWN` when the chain did not answer —
   * offered no button, since a claim sent for a claimed reward reverts; or where
   * the claim flow has got to.
   */
  readonly status: 'CLAIMED' | 'UNKNOWN' | ClaimState;
  /** Why the last attempt failed, in the player's words. */
  readonly failure: string | null;
}

export function claimEntries(
  claims: Extract<RewardClaims, { status: 'READ' }>,
  progress: ReadonlyMap<
    string,
    { readonly state: ClaimState; readonly failure: ClaimFailure | null }
  >,
): readonly ClaimEntryView[] {
  return claims.claims.map((claim) => {
    const running = progress.get(claim.distributionId);
    const status: ClaimEntryView['status'] =
      running?.state === 'CONFIRMED' || claim.claimed === true
        ? 'CLAIMED'
        : running !== undefined
          ? running.state
          : claim.claimed === null
            ? 'UNKNOWN'
            : 'READY_TO_CLAIM';
    return {
      distributionId: claim.distributionId,
      label: `REWARDS DISTRIBUTION #${claim.distributionId.padStart(3, '0')}`,
      amount: `${formatTokenAmount(claim.amount, claims.decimals)} SPY`,
      status,
      failure:
        status === 'FAILED' && running?.failure != null
          ? claimFailureDetail(running.failure)
          : null,
    };
  });
}
