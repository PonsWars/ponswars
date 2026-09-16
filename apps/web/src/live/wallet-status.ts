import { chainLabel } from '@ponswars/shared-types';
import type { AuthFailure } from './auth-client.js';
import type { WalletFailure } from './wallet-provider.js';

/**
 * What a sign-in failure says to the person looking at the bar (§110.5, §42.15).
 *
 * Pure, and kept out of the hook that calls it. §110.5 asks an error to say
 * what happened and what to do next, and §42.15 wants that in the player's
 * terms rather than the protocol's — both are wording decisions, and wording
 * decisions are worth a test rather than a render.
 */

export type WalletStatus =
  /** No wallet extension in this browser. Watching still works. */
  | { readonly kind: 'UNAVAILABLE' }
  /** A wallet is available and nobody has connected it. */
  | { readonly kind: 'DISCONNECTED' }
  /** Mid-flow. The wallet is showing a prompt, or the server is answering. */
  | { readonly kind: 'CONNECTING'; readonly step: 'WALLET' | 'SIGNATURE' | 'SESSION' }
  | { readonly kind: 'CONNECTED'; readonly wallet: string; readonly expiresAt: number }
  /** It did not work, and this is what to say about it (§110.5). */
  | {
      readonly kind: 'REFUSED';
      readonly message: string;
      readonly nextStep: string;
      /**
       * When connecting can work again, where the server said so.
       *
       * Only a rate-limited sign-in names one. The bar counts it down and keeps
       * the button from working until it passes, so pressing retry in a loop
       * cannot be what makes the wait longer.
       */
      readonly retryAt?: number;
    };

export function fromWallet(failure: WalletFailure): WalletStatus {
  switch (failure.kind) {
    case 'NO_WALLET':
      return { kind: 'UNAVAILABLE' };
    case 'DECLINED':
      // Changing your mind is not an error. Back to where you were, silently.
      return { kind: 'DISCONNECTED' };
    case 'WRONG_CHAIN':
      return {
        kind: 'REFUSED',
        message: `PonsWars runs on ${chainLabel(failure.expected)}.`,
        nextStep: `Switch your wallet to ${chainLabel(failure.expected)}, then connect again.`,
      };
    case 'FAILED':
      return {
        kind: 'REFUSED',
        message: `Your wallet could not complete the request: ${failure.detail}`,
        nextStep: 'Try again. Nothing was signed and no funds moved.',
      };
  }
}

export function fromServer(failure: AuthFailure): WalletStatus {
  switch (failure.kind) {
    case 'REFUSED':
      // The server's own `nextStep` names the instant as an ISO timestamp,
      // which is right for a client that parses it and wrong for a bar over a
      // battlefield (§42.15). The countdown is the sentence here.
      if (failure.code === 'RATE_LIMITED' && failure.retryAt !== undefined) {
        return {
          kind: 'REFUSED',
          message: failure.message,
          nextStep: 'Too many sign-in attempts from this network. Watching needs no wallet.',
          retryAt: failure.retryAt,
        };
      }
      return { kind: 'REFUSED', message: failure.message, nextStep: failure.nextStep };
    case 'UNREACHABLE':
      return {
        kind: 'REFUSED',
        message: 'The server did not answer.',
        nextStep: 'Check your connection and try again. Nothing was recorded.',
      };
    case 'MALFORMED':
      return {
        kind: 'REFUSED',
        message: 'The server answered with something this client cannot read.',
        nextStep: 'Reload the page. If it keeps happening, this build is out of date.',
      };
  }
}
