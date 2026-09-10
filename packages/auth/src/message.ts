import type { WalletAddress } from '@ponswars/shared-types';
import { getAddress } from 'viem';
import { createSiweMessage, type SiweMessage } from 'viem/siwe';

/**
 * The message a wallet is asked to sign (§45.2, §69.4).
 *
 * EIP-4361 ("Sign-In with Ethereum"), built by `viem` rather than by
 * concatenation here. §45.2 requires the backend to verify chain, address,
 * nonce, origin and expiry, and every one of those is a field of that format —
 * a hand-rolled string would be a second, worse specification of the same
 * thing, and the wallets that show a readable prompt rather than a hex blob are
 * the ones that recognise this format.
 *
 * Nothing in here is secret. The security of the flow is in the nonce being
 * single-use and the signature being unforgeable, not in the message being
 * unpredictable.
 */

/**
 * The sentence a player reads in their wallet.
 *
 * §110 wants copy that says what is happening. "Authenticate" tells someone
 * nothing about what they are agreeing to; this says what the signature is for
 * and, just as importantly, what it is not for — a signature is not a
 * transaction, and the one moment to say so is the moment somebody is being
 * asked for one.
 */
export const CHALLENGE_STATEMENT =
  'Sign in to PonsWars. This proves you control this wallet. It is not a transaction and moves no funds.';

export interface ChallengeInput {
  /**
   * The origin asking, exactly as the browser knows it (`ponswars.example`).
   *
   * §45.2 lists origin/domain context among the things the backend verifies,
   * and this is the field that carries it: a signature produced for one domain
   * must not authenticate at another. Host and port, never a scheme.
   */
  readonly domain: string;
  /** The full origin, including scheme, that the message names as `URI`. */
  readonly uri: string;
  readonly address: WalletAddress;
  readonly chainId: number;
  /** Single-use, from `generateNonce`. */
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/**
 * The exact bytes to sign.
 *
 * `address` is checksummed on the way in because EIP-4361 requires it, and
 * `walletAddress` lowercases by construction (a lowercase address in the
 * message is rejected by strict verifiers).
 */
export function challengeMessage(input: ChallengeInput): string {
  const message: SiweMessage = {
    domain: input.domain,
    address: checksum(input.address),
    statement: CHALLENGE_STATEMENT,
    uri: input.uri,
    version: '1',
    chainId: input.chainId,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    expirationTime: input.expiresAt,
  };
  return createSiweMessage(message);
}

/**
 * EIP-55 checksummed form, which is what the message format requires.
 *
 * The domain type is lowercase by construction (`walletAddress` normalises so
 * that channel names compare correctly), and a lowercase address in a SIWE
 * message is rejected by strict verifiers. So the conversion happens here, at
 * the one boundary that needs the other spelling.
 */
function checksum(address: WalletAddress): `0x${string}` {
  return getAddress(address);
}
