import {
  DISTRIBUTION_WINDOW,
  MIN_QUALIFYING_WP,
  PER_WALLET_CAP_BPS,
  POOL_CARRYOVER_BPS,
  POOL_DISTRIBUTABLE_BPS,
  WP_AWARDS,
} from '@ponswars/shared-types';

/**
 * How rewards are earned and paid, in the numbers that decide them (§11, §16).
 *
 * The Rewards page, to a visitor with no wallet connected, was one panel and
 * then half a screen of nothing — the same thing the Genesis page had before
 * `card-ladder.ts`, and it reads the same way: as a page that failed to load.
 * What belongs in that space is what the page is about, and for rewards that
 * is the arithmetic, which is public and the same for everyone.
 *
 * Every figure is read from the locked constants (§11, §16). Nothing here is
 * written down a second time: a page that says "10 War Points for a win" in
 * its own words is a page that will one day disagree with the ledger.
 *
 * Two things are deliberately absent. The **pool** is not here — what it holds
 * and what a wallet's share of it would be belong to the signed-in page, and
 * §30 forbids promising an amount. The **minimum claim threshold** is not here
 * either: §16.7 leaves it `BASELINE`, so it is configuration rather than a
 * fact about the game, and printing it would make it policy (§102).
 */

export interface EarningRule {
  /** What the wallet did. */
  readonly what: string;
  /** War Points awarded for it. */
  readonly points: number;
}

export interface DistributionRule {
  readonly title: string;
  readonly detail: string;
}

/** What earns War Points, most valuable last: an upset is worth more than a win. */
export function earningRules(): readonly EarningRule[] {
  return [
    { what: 'Back the winning side', points: WP_AWARDS.WIN },
    { what: 'Back an underdog that wins', points: WP_AWARDS.UNDERDOG_WIN },
    { what: 'Back a heavy underdog that wins', points: WP_AWARDS.HEAVY_UNDERDOG_WIN },
    { what: 'Deploy a card on the winning side', points: WP_AWARDS.CARD_ASSIST },
  ];
}

/** How a window turns those points into SPY. */
export function distributionRules(): readonly DistributionRule[] {
  const hours = Math.round(DISTRIBUTION_WINDOW / 3_600_000);
  return [
    {
      title: `EVERY ${String(hours)} HOURS`,
      detail:
        'A window closes, the points earned in it are counted, and a Merkle root is published on Robinhood Chain. Claims are made from your own wallet.',
    },
    {
      title: `${String(MIN_QUALIFYING_WP)} WAR POINTS TO QUALIFY`,
      detail: `A wallet takes part in a window once it has earned ${String(MIN_QUALIFYING_WP)} War Points inside it. Points are not carried between windows.`,
    },
    {
      title: `${String(percent(POOL_DISTRIBUTABLE_BPS))}% PAID, ${String(percent(POOL_CARRYOVER_BPS))}% CARRIED`,
      detail:
        'Each window pays out most of the pool and keeps the rest, so a quiet window leaves something behind for the next one rather than emptying it.',
    },
    {
      title: 'BY THE SQUARE ROOT OF YOUR POINTS',
      detail:
        'Shares are weighted by the square root of a wallet’s War Points, so ten times the points is a little over three times the share — the wallets that play most do not take everything.',
    },
    {
      title: `${String(percent(PER_WALLET_CAP_BPS))}% CAP PER WALLET`,
      detail: `No wallet takes more than ${String(percent(PER_WALLET_CAP_BPS))}% of a window, however many points it earned. What a cap turns away is shared among everyone else.`,
    },
  ];
}

/** Basis points as whole percent, which is what every share above is. */
function percent(basisPoints: number): number {
  return basisPoints / 100;
}
