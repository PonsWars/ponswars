import { claimCalldata } from '../live/claim-calldata.js';
import { SECRET_CLAIM_CALLDATA } from '../live/secret-calldata.js';
import {
  connectWallet,
  currentChain,
  sendTransaction,
  switchChain,
  transactionOutcome,
  type Eip1193Provider,
} from '../live/wallet-provider.js';
import type { ClaimState } from './reward-view.js';

/**
 * Claiming one published reward from the player's wallet (§16.8, §35.6).
 *
 * `READY_TO_CLAIM → CONFIRM_IN_WALLET → SUBMITTING → CONFIRMED`, or `FAILED`
 * with the reason. Every failure leaves the allocation exactly where it was:
 * it is a published Merkle leaf, and nothing the wallet does or declines can
 * touch it (§35.6).
 *
 * Two checks come before the wallet is asked for anything:
 *
 * - **The account is the signed-in wallet.** A claim pays the account in its
 *   leaf whoever sends it, so a wallet switched to another account would only
 *   pay gas for somebody else's reward.
 * - **The wallet is on the distributor's network.** The claim is offered on
 *   Robinhood Chain and nowhere else.
 */

export type ClaimFailure =
  'WRONG_ACCOUNT' | 'WRONG_CHAIN' | 'DECLINED' | 'REVERTED' | 'NO_WALLET' | 'UNCONFIRMED';

export type ClaimResult =
  | { readonly state: 'CONFIRMED'; readonly transaction: `0x${string}` }
  | { readonly state: 'FAILED'; readonly reason: ClaimFailure };

/** What any claim needs from the wallet, whatever it is claiming. */
export interface WalletClaimRequest {
  readonly provider: Eip1193Provider;
  /** The wallet signed in to PonsWars. */
  readonly wallet: string;
  readonly chainId: number;
  readonly onState: (state: ClaimState) => void;
  /** How long to wait between receipt reads. */
  readonly pollMs?: number;
  /** How many receipt reads before giving up waiting. */
  readonly maxPolls?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ClaimRequest extends WalletClaimRequest {
  readonly distributor: string;
  readonly claim: {
    readonly distributionId: bigint;
    readonly amount: bigint;
    readonly proof: readonly string[];
  };
}

export interface SecretClaimRequest extends WalletClaimRequest {
  readonly vault: string;
}

export async function runClaim(request: ClaimRequest): Promise<ClaimResult> {
  return sendClaim(request, {
    to: request.distributor,
    data: claimCalldata({
      distributionId: request.claim.distributionId,
      account: request.wallet,
      amount: request.claim.amount,
      proof: request.claim.proof,
    }),
  });
}

/**
 * Claiming a Secret's reward from the vault (§8.5).
 *
 * The same walk through the wallet, and a call with no arguments: the vault
 * pays `msg.sender` what it reserved for them, so there is nothing for a
 * client to get wrong about the amount or the recipient.
 */
export function runSecretClaim(request: SecretClaimRequest): Promise<ClaimResult> {
  return sendClaim(request, { to: request.vault, data: SECRET_CLAIM_CALLDATA });
}

/** Everything both claims need from the wallet, with the call they differ by. */
async function sendClaim(
  request: WalletClaimRequest,
  call: { readonly to: string; readonly data: `0x${string}` },
): Promise<ClaimResult> {
  const { provider, onState } = request;
  const sleep =
    request.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const fail = (reason: ClaimFailure): ClaimResult => {
    onState('FAILED');
    return { state: 'FAILED', reason };
  };

  onState('CONFIRM_IN_WALLET');
  const connected = await connectWallet(provider);
  if (!connected.ok) {
    return fail(connected.failure.kind === 'NO_WALLET' ? 'NO_WALLET' : 'DECLINED');
  }
  if (connected.value.address.toLowerCase() !== request.wallet.toLowerCase()) {
    return fail('WRONG_ACCOUNT');
  }
  if (connected.value.chainId !== request.chainId) {
    const switched = await switchChain(provider, request.chainId);
    if (!switched.ok || (await currentChain(provider)) !== request.chainId) {
      return fail('WRONG_CHAIN');
    }
  }

  const sent = await sendTransaction(provider, {
    from: connected.value.address,
    to: call.to,
    data: call.data,
  });
  if (!sent.ok) {
    return fail(sent.failure.kind === 'DECLINED' ? 'DECLINED' : 'REVERTED');
  }

  onState('SUBMITTING');
  const pollMs = request.pollMs ?? 3_000;
  const maxPolls = request.maxPolls ?? 200;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const outcome = await transactionOutcome(provider, sent.value).catch(() => 'PENDING' as const);
    if (outcome === 'SUCCEEDED') {
      onState('CONFIRMED');
      return { state: 'CONFIRMED', transaction: sent.value };
    }
    if (outcome === 'REVERTED') {
      return fail('REVERTED');
    }
    await sleep(pollMs);
  }
  return fail('UNCONFIRMED');
}

/** What a failed claim tells the player, beside §35.6's "still available". */
export function claimFailureDetail(reason: ClaimFailure): string {
  switch (reason) {
    case 'WRONG_ACCOUNT':
      return 'Your wallet is on a different account from the one signed in. Switch back to it and try again.';
    case 'WRONG_CHAIN':
      return 'Your wallet is not on Robinhood Chain. Switch networks and try again.';
    case 'DECLINED':
      return 'The transaction was not approved in your wallet.';
    case 'REVERTED':
      return 'The transaction did not go through. If it was already claimed, it shows as claimed once the page refreshes.';
    case 'NO_WALLET':
      return 'No wallet is available in this browser.';
    case 'UNCONFIRMED':
      return 'The transaction has not confirmed yet. Check your wallet before trying again.';
  }
}
