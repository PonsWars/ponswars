import { walletAddress, type WalletAddress } from '@ponswars/shared-types';
import { recoverMessageAddress } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';

/**
 * Checking that a signature answers the challenge that was issued (§45.2, §69.5).
 *
 * Six things have to hold, and §45.2 names all six: the challenge exists, its
 * nonce is unused, the signature is valid, the address matches, the domain
 * matches, and it has not expired. The first two belong to the store — "unused"
 * across processes is a database constraint. The rest are here.
 *
 * ## What this does not do
 *
 * Smart-contract wallets. EIP-1271 verification is a call to the wallet's own
 * contract, which needs a chain client, and the RPC vendor is an `OPEN`
 * decision (§59.3). Rather than pretend, a signature that does not recover to
 * the expected address is refused — a contract wallet gets a clear refusal
 * today instead of a silent acceptance nobody checked.
 */

export type VerificationFailure =
  'MESSAGE_MALFORMED' | 'DOMAIN_MISMATCH' | 'CHAIN_MISMATCH' | 'EXPIRED' | 'SIGNATURE_INVALID';

export interface VerifyInput {
  /**
   * The message the server issued for this nonce, read back from the store.
   *
   * Never a copy sent by the client. An echoed message is either identical, in
   * which case it adds nothing, or different, in which case believing it is the
   * bug — a wallet could be shown one thing and the server told another.
   */
  readonly message: string;
  readonly signature: string;
  readonly expectedWallet: WalletAddress;
  readonly expectedDomain: string;
  readonly expectedChainId: number;
  readonly at: Date;
}

export type VerifyResult =
  | { readonly ok: true; readonly wallet: WalletAddress }
  | { readonly ok: false; readonly reason: VerificationFailure };

export async function verifySignedChallenge(input: VerifyInput): Promise<VerifyResult> {
  const parsed = parseSiweMessage(input.message);
  if (parsed.address === undefined || parsed.nonce === undefined) {
    return { ok: false, reason: 'MESSAGE_MALFORMED' };
  }

  // Checked against what the server expects rather than against what the
  // message claims: a message that says its own domain is correct is not
  // evidence of anything.
  if (parsed.domain !== input.expectedDomain) {
    return { ok: false, reason: 'DOMAIN_MISMATCH' };
  }
  if (parsed.chainId !== input.expectedChainId) {
    return { ok: false, reason: 'CHAIN_MISMATCH' };
  }
  if (!validateSiweMessage({ message: parsed, time: input.at })) {
    return { ok: false, reason: 'EXPIRED' };
  }

  let recovered: string;
  try {
    recovered = await recoverMessageAddress({
      message: input.message,
      signature: input.signature as `0x${string}`,
    });
  } catch {
    // A signature that is not a signature — wrong length, not hex, truncated by
    // a client. Indistinguishable from a wrong one as far as the caller is
    // concerned, and deliberately reported the same way.
    return { ok: false, reason: 'SIGNATURE_INVALID' };
  }

  // Compared as branded values, which are lowercase by construction, so this is
  // not a case-sensitive comparison of two spellings of the same address.
  return walletAddress(recovered) === input.expectedWallet
    ? { ok: true, wallet: input.expectedWallet }
    : { ok: false, reason: 'SIGNATURE_INVALID' };
}
