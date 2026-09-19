import { FACTIONS, type ActiveTicker } from '@ponswars/shared-types';

/**
 * The ticker tape that circles each side's district (§38.11, §36.4).
 *
 * §38.11 asks for market data *as environment* — data streams, holographic
 * ticker fragments, energy routing — and forbids the easy version, literal
 * charts on terrain. The deck had none of it: a district was a skyline and an
 * army, and nothing about the place said it was built on a market.
 *
 * So a band of holographic tape runs round each district, carrying the one
 * thing it can truthfully say: whose district it is. The ticker and the
 * faction's name, over and over, the way a tape carries a symbol.
 *
 * ## What it must never carry
 *
 * A number. The client holds no price — the market is the server's (§23) — and
 * §24 keeps the score hidden for the whole live battle, so any figure on this
 * tape would be one this client invented and presented as market data. The art
 * bible's mockup corrections forbid exactly that. The test for this file is
 * mostly the test that it cannot happen.
 *
 * Pure, no three: the text and the bands are data, and the scene draws them.
 */

/** The separator between repeats: a mid dot, which reads as tape rather than prose. */
const SEPARATOR = '  ·  ';

/**
 * One repeat of the tape for a faction.
 *
 * Upper case because it is tape, and because §36.12 keeps pixel-and-terminal
 * typography for status and faction accents — this is both.
 */
export function tapeText(ticker: ActiveTicker): string {
  return `${ticker}${SEPARATOR}${FACTIONS[ticker].name.toUpperCase()}${SEPARATOR}`;
}

export interface HoloBand {
  /** Height of the band's centre above the sector's origin. */
  readonly y: number;
  /** Half-extent of the band's ellipse across the deck and along it. */
  readonly radiusX: number;
  readonly radiusZ: number;
  /** How tall the band of tape is. */
  readonly height: number;
  /** How much of a full turn the band covers, `0`–`1`. */
  readonly arc: number;
  /** Tape speed in repeats per second; the sign is the direction. */
  readonly scroll: number;
  /** How bright, relative to the sector's own level. */
  readonly strength: number;
}

/**
 * The bands round one district, in the district's own space.
 *
 * Inside the skyline's envelope rather than over it: the camera poses keep
 * clear of `SECTOR_SKYLINE_HEIGHT`, and a band floated above the towers is a
 * band a battlefield camera could fly through. At mid-height the towers stand
 * through the tape, which is also what makes it read as a hologram rather than
 * as a ring someone hung up.
 *
 * Narrow across the deck, long along it — the district is 22 wide and 90 deep —
 * so no band reaches over the contested ground in front of it (§36.15). The
 * upper band covers only the outer side, for the same reason.
 */
export const HOLO_BANDS: readonly HoloBand[] = [
  { y: 48, radiusX: 10, radiusZ: 50, height: 9, arc: 1, scroll: 0.035, strength: 1 },
  { y: 67, radiusX: 8.5, radiusZ: 42, height: 6.5, arc: 0.62, scroll: -0.05, strength: 0.7 },
];

/**
 * Where the skyline stands across the deck.
 *
 * The district's deck is 62 out and its buildings are set back a further 12
 * behind the ground the army forms on, so the towers the bands circle are
 * centred 74 out.
 */
export const DISTRICT_CENTRE_X = 74;

/** Where the contested ground ends: half of its 76 across (§36.15). */
export const CONTESTED_EDGE_X = 38;

/**
 * Where a forward base's tall parts begin (§38.5).
 *
 * The base stands 92 out and its masts, boosters and pylons sit within about
 * seven of its centre. A band that reached past this would pass through them.
 */
export const BASE_INNER_X = 85;
