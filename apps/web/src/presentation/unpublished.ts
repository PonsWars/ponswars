import type { ProfileFailure } from '../live/profile-client.js';

/**
 * What a personal page says while it has no record to show (§42.14, §110.5).
 *
 * The profile, the rewards hub and the Genesis reveal show a player's own
 * standing. Before there is a record on screen, there are four honest things a
 * page can be doing, and each says something different:
 *
 * - **no wallet connected** — a record belongs to a wallet, so the next step is
 *   to connect one;
 * - **loading** — the wallet is known and its record is on the way;
 * - **failed** — the record did not arrive, and the page says why and what to
 *   do, rather than showing a record of nothing;
 * - **not published** — no service answers for it at all. Genesis claims are
 *   read from the chain, and nothing reads the chain yet.
 *
 * These pages were once filled with preview figures in every case — 1,180 War
 * Points and "qualified for distribution" for a visitor with no wallet at all.
 * Preview figures are still what a preview shows, under its own banner; they
 * are never what a live round shows.
 */

export type PersonalData<T> =
  | { readonly status: 'SIGNED_OUT' }
  | { readonly status: 'LOADING' }
  | { readonly status: 'UNPUBLISHED'; readonly copy: PageCopy }
  | { readonly status: 'FAILED'; readonly copy: PageCopy; readonly retry: () => void }
  | { readonly status: 'READY'; readonly value: T };

export type PersonalPage = 'PROFILE' | 'REWARDS' | 'GENESIS';

export interface PageCopy {
  readonly headline: string;
  readonly body: string;
}

/** What each page asks of a visitor with no wallet connected. */
export function signedOutCopy(page: PersonalPage): PageCopy {
  switch (page) {
    case 'PROFILE':
      return {
        headline: 'CONNECT A WALLET TO OPEN YOUR WAR ROOM',
        body: 'Your record, your card and your War Points belong to a wallet. Connect one from the bar above — watching the world needs none.',
      };
    case 'REWARDS':
      return {
        headline: 'CONNECT A WALLET TO SEE YOUR REWARDS',
        body: 'Rewards are paid to wallets according to their War Points. Connect one from the bar above to see where it stands in the current distribution.',
      };
    case 'GENESIS':
      return {
        headline: 'CONNECT THE WALLET THAT HOLDS YOUR CLAIM',
        body: 'A Genesis Card is revealed once, to the wallet that holds the claim. Connect that wallet from the bar above to open it.',
      };
  }
}

/** Genesis claims, which no service publishes yet. */
export const GENESIS_UNPUBLISHED: PageCopy = {
  headline: 'GENESIS CLAIMS ARE NOT PUBLISHED YET',
  body: 'Claims are read from the chain by the Genesis service, which this server does not run yet. Whether this wallet holds one is not something this page will guess.',
};

/**
 * Why a record did not load, in the player's terms (§110.5).
 *
 * Every variant says the record itself is safe — a failed read changes nothing
 * — and names the one thing worth doing next.
 */
export function failureCopy(failure: ProfileFailure): PageCopy {
  switch (failure.kind) {
    case 'UNREACHABLE':
      return {
        headline: 'YOUR RECORD DID NOT LOAD',
        body: 'The server could not be reached. Nothing about your record has changed — check your connection and try again.',
      };
    case 'REFUSED':
      return failure.status === 401
        ? {
            headline: 'SIGN IN AGAIN TO SEE YOUR RECORD',
            body: `Your session has ended. ${failure.nextStep}`,
          }
        : { headline: 'YOUR RECORD DID NOT LOAD', body: `${failure.message} ${failure.nextStep}` };
    case 'MALFORMED':
      return {
        headline: 'YOUR RECORD COULD NOT BE READ',
        body: 'The server answered in a form this page does not understand, which usually means this page is out of date. Reload to get the latest version.',
      };
  }
}
