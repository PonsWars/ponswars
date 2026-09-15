import type { SecretClaim } from '@ponswars/schemas';
import { formatTokenAmount } from '../presentation/token-amount.js';
import { claimFailureDetail, type ClaimFailure } from './claim-runner.js';
import { claimCopy, type ClaimState } from './reward-view.js';

/**
 * The Secret a wallet holds, as the rewards page shows it (§8.5, §35.7).
 *
 * `null` for every wallet that holds none, which is nearly all of them: §6
 * gives one Genesis per wallet and §8.2 makes the Secret a 0.1% outcome, so a
 * panel about an entitlement nobody has would be noise on every other screen.
 * A vault that could not be read shows nothing rather than "you have none" —
 * §8.5 gives a reservation no expiry, and a slow endpoint must not read as one
 * that has gone.
 */
export interface SecretClaimView {
  /** `0.20 SPY`, truncated, never rounded up. */
  readonly amount: string;
  readonly vault: string;
  /** `CLAIMED` as the vault says, or where the claim flow has got to. */
  readonly status: 'CLAIMED' | ClaimState;
  readonly headline: string;
  readonly detail: string | null;
  /** Whether the button does anything right now. */
  readonly actionable: boolean;
}

export function secretClaimView(
  secret: SecretClaim,
  progress: { readonly state: ClaimState; readonly failure: ClaimFailure | null } | null,
): SecretClaimView | null {
  if (secret.status !== 'READ' || secret.entitlement === 'NONE') {
    return null;
  }
  const status: SecretClaimView['status'] =
    progress?.state === 'CONFIRMED' || secret.entitlement === 'CLAIMED'
      ? 'CLAIMED'
      : (progress?.state ?? 'READY_TO_CLAIM');
  const copy =
    status === 'CLAIMED'
      ? { headline: 'CLAIMED ✓', detail: null, actionable: false }
      : claimCopy(status);
  return {
    amount: `${formatTokenAmount(secret.amount, secret.decimals)} SPY`,
    vault: secret.vault,
    status,
    headline: copy.headline,
    detail:
      status === 'FAILED' && progress?.failure != null
        ? claimFailureDetail(progress.failure)
        : copy.detail,
    actionable: copy.actionable,
  };
}
