import type { UnitSlot } from '@ponswars/shared-types';
import type { JSX } from 'react';

/**
 * The five unit classes, drawn (§36.8, §39).
 *
 * §36.8 gives every faction the same five slots — infantry, elite, heavy, air
 * and a forward base — and each faction names its own. Ten factions times five
 * slots is fifty units, and fifty drawings would be fifty chances to make one
 * faction look stronger than another when §12 scores all of them identically.
 *
 * The *class* is what is drawn. One icon per slot, tinted with whichever
 * faction is holding it, so a player learns five shapes once and reads them on
 * any faction — which is what §36.8 wants the slots to be for. The faction's
 * own identity stays where it belongs: its emblem, its accent and the name it
 * gives the unit.
 *
 * Same flat geometry on the same 64-unit field as the faction emblems and the
 * card devices, so the whole product reads as one hand.
 */
const DEVICE: Readonly<Record<UnitSlot, readonly string[]>> = {
  // A soldier: helmet, shoulders, stance.
  infantry: [
    'M23 23 L25 14 L39 14 L41 23 Z',
    'M20 26 L44 26 L46 45 L18 45 Z',
    'M23 47 L30 47 L29 59 L22 59 Z',
    'M34 47 L41 47 L42 59 L35 59 Z',
  ],
  // The same soldier, carrying more: a crest and a pair of pauldrons.
  elite: [
    'M29 5 L35 5 L35 14 L29 14 Z',
    'M23 23 L25 14 L39 14 L41 23 Z',
    'M11 27 L22 24 L22 35 L11 35 Z',
    'M53 27 L42 24 L42 35 L53 35 Z',
    'M22 26 L42 26 L44 45 L20 45 Z',
    'M24 47 L31 47 L30 59 L23 59 Z',
    'M33 47 L40 47 L41 59 L34 59 Z',
  ],
  // A tracked hull with a gun over it.
  heavy: [
    'M24 19 L40 19 L40 30 L24 30 Z',
    'M40 22 L58 22 L58 27 L40 27 Z',
    'M11 31 L53 31 L53 44 L11 44 Z',
    'M9 46 L55 46 L55 55 L9 55 Z M15 49 L49 49 L49 52 L15 52 Z',
  ],
  // A delta, seen from above.
  air: ['M32 8 L53 40 L32 31 L11 40 Z', 'M28 33 L36 33 L34 54 L30 54 Z'],
  // The mast on a footing the world already draws in three dimensions (§38.5).
  base: [
    'M32 6 L39 16 L32 26 L25 16 Z',
    'M29 24 L35 24 L35 47 L29 47 Z',
    'M13 47 L51 47 L51 56 L13 56 Z',
  ],
};

export function UnitIcon({
  slot,
  color,
  size = 20,
}: {
  readonly slot: UnitSlot;
  readonly color: string;
  readonly size?: number;
}): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden
      focusable="false"
      style={{ display: 'block', flex: 'none' }}
    >
      <g fill={color} fillRule="evenodd">
        {DEVICE[slot].map((path) => (
          <path key={path} d={path} />
        ))}
      </g>
    </svg>
  );
}
