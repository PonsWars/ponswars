import type { ActiveTicker } from '@ponswars/shared-types';
import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import type { JSX } from 'react';

/**
 * Ten original faction emblems (§36.7, §39, §7.10).
 *
 * Drawn here rather than cropped from the delivered dossiers, because eight of
 * those carry the real corporate mark of the company behind the ticker and
 * §7.10 is explicit that those are not cleared production assets. These owe
 * nothing to any of them.
 *
 * The house style comes from the two marks in the pack that *are* original — the
 * NVDA banner crest and the emblem stamped on the Genesis cards. Both are the
 * same language: a blade device, vertically symmetric, held inside a diamond,
 * one flat colour and no gradient. Every emblem below shares that frame and
 * differs only in the device it holds, which is what makes ten of them read as
 * one faction system rather than ten logos.
 *
 * Each device says something about its legion — a compute cluster, a shield, a
 * grid, an ascent — but none of them illustrates a company. They are heraldry
 * for a fictional war.
 *
 * Geometry rather than an image file: an emblem is shown from 16 pixels in a
 * sector label to 120 in a faction panel, and one set of paths is sharp at
 * both. It also means a faction that changes accent changes emblem colour with
 * it, without anyone re-exporting anything.
 */

/** The shared frame every emblem is held in. Thin, so the device leads. */
const FRAME = 'M32 2 L60 32 L32 62 L4 32 Z';

/**
 * The device inside the frame, one per faction.
 *
 * Symmetric about x = 32 in every case. The symmetry is what carries the family
 * resemblance at small sizes, where the detail of any individual device stops
 * being legible and only its silhouette remains.
 */
const DEVICE: Readonly<Record<ActiveTicker, readonly string[]>> = {
  // Compute cluster: three blades, tallest at the centre.
  NVDA: [
    'M32 12 L37 32 L32 46 L27 32 Z',
    'M21 20 L25 33 L21 42 L17 33 Z',
    'M43 20 L47 33 L43 42 L39 33 Z',
  ],
  // A shield, cut hollow so it reads as carried rather than as a solid mass.
  AAPL: [
    'M32 13 L46 20 L46 36 L32 50 L18 36 L18 20 Z M32 20 L24 24 L24 34 L32 43 L40 34 L40 24 Z',
    'M29 26 L35 26 L35 38 L29 38 Z',
  ],
  // Four quadrants, connected: scale through structure.
  MSFT: [
    'M23 21 L31 21 L31 31 L23 31 Z',
    'M33 21 L41 21 L41 31 L33 31 Z',
    'M23 33 L31 33 L31 43 L23 43 Z',
    'M33 33 L41 33 L41 43 L33 43 Z',
  ],
  // Ascent: a chevron lifting off a stem.
  TSLA: ['M32 11 L45 27 L38 27 L32 19 L26 27 L19 27 Z', 'M29 30 L35 30 L35 50 L29 50 Z'],
  // A wedge driving up through a line that has already broken for it.
  GME: ['M32 12 L45 34 L19 34 Z', 'M16 39 L28 39 L28 45 L16 45 Z M36 39 L48 39 L48 45 L36 45 Z'],
  // Two worlds interlocked, cut square.
  META: [
    'M22 24 L32 32 L22 40 L14 32 Z',
    'M42 24 L50 32 L42 40 L32 32 Z',
    'M28 30 L36 30 L36 34 L28 34 Z',
  ],
  // Flow: a double chevron, always moving forward.
  AMZN: [
    'M32 13 L44 29 L36 29 L32 24 L28 29 L20 29 Z',
    'M32 30 L44 46 L36 46 L32 41 L28 46 L20 46 Z',
  ],
  // An aperture: the ring is the mark and the opening is the point, so the
  // centre is a hole rather than a shape of the same colour drawn on top of it.
  GOOGL: ['M32 14 L47 32 L32 50 L17 32 Z M32 24 L39 32 L32 40 L25 32 Z'],
  // A core with four radiating blades: performance from the centre out.
  AMD: [
    'M32 26 L38 32 L32 38 L26 32 Z',
    'M30 12 L34 12 L34 23 L30 23 Z',
    'M30 41 L34 41 L34 52 L30 52 Z',
    'M12 30 L23 30 L23 34 L12 34 Z',
    'M41 30 L52 30 L52 34 L41 34 Z',
  ],
  // Balance: a triangle resting on a level bar.
  SPY: ['M32 13 L45 37 L19 37 Z', 'M16 40 L48 40 L48 45 L16 45 Z'],
};

export function FactionEmblem({
  ticker,
  size = 24,
  color,
}: {
  readonly ticker: ActiveTicker;
  readonly size?: number;
  /** Overrides the faction accent, for a surface that is already tinted. */
  readonly color?: string;
}): JSX.Element {
  const tint = color ?? FACTION_ACCENT[ticker];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      // Decorative: every emblem sits beside its own ticker, which is the name
      // §36.7 requires a faction to remain identifiable by without colour.
      aria-hidden
      focusable="false"
      style={{ display: 'block', flex: 'none' }}
    >
      <path d={FRAME} fill="none" stroke={tint} strokeWidth={2.5} opacity={0.55} />
      {DEVICE[ticker].map((d, index) => (
        // `evenodd`, so a second subpath inside the first cuts a hole instead of
        // painting over it. Three of these devices are apertures rather than
        // solids, and without this they render as filled diamonds.
        <path key={index} d={d} fill={tint} fillRule="evenodd" />
      ))}
    </svg>
  );
}
