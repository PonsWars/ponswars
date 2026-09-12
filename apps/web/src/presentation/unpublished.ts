/**
 * What a personal page says when there is nothing true to put on it (§42.14,
 * §110.5).
 *
 * The profile, the rewards hub and the Genesis reveal show a player's own
 * record, and every number on them comes from a service — the indexer, the
 * Player Service, the Rewards Engine — that publishes it. Until one does, the
 * page has two honest things it can say, and which one depends on the visitor:
 *
 * - **no wallet connected** — these numbers belong to a wallet, so the next step
 *   is to connect one;
 * - **connected, nothing published** — the wallet is known and the service that
 *   would describe it is not answering, so the page says so rather than guess.
 *
 * The pages used to be filled with preview figures in both cases — 1,180 War
 * Points and "qualified for distribution" for a visitor with no wallet at all,
 * a Legendary card for a wallet that had never been asked about. Preview
 * figures are still what a preview shows, under its own banner; they are never
 * what a live round shows.
 */

/** Something a service publishes, or the fact that it has not. */
export type Published<T> =
  { readonly published: false } | { readonly published: true; readonly value: T };

export type PersonalPage = 'PROFILE' | 'REWARDS' | 'GENESIS';

export interface UnpublishedCopy {
  readonly headline: string;
  readonly body: string;
}

export function unpublishedCopy(page: PersonalPage, connected: boolean): UnpublishedCopy {
  if (!connected) {
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
  switch (page) {
    case 'PROFILE':
      return {
        headline: 'YOUR RECORD IS NOT PUBLISHED YET',
        body: 'This server does not publish commander records yet. Rather than show figures that are not yours, this page stays empty until it does.',
      };
    case 'REWARDS':
      return {
        headline: 'THE DISTRIBUTION IS NOT PUBLISHED YET',
        body: 'The distribution window, the pool and your standing come from the rewards service, which this server does not run yet. Rather than estimate them, this page stays empty until it does.',
      };
    case 'GENESIS':
      return {
        headline: 'GENESIS CLAIMS ARE NOT PUBLISHED YET',
        body: 'Claims are read from the chain by the Genesis service, which this server does not run yet. Whether this wallet holds one is not something this page will guess.',
      };
  }
}
