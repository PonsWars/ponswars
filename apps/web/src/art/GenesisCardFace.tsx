import {
  CARD_CATALOG,
  RARITY_USES,
  SUPPORT_UNIT_SCALE,
  type CardType,
  type Rarity,
} from '@ponswars/shared-types';
import { RARITY_COLOR } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { CARD_ART } from './manifest.js';

/**
 * A Genesis card, with a face (§7.2, §17, §40.6).
 *
 * §17 of the visual guide makes the card art the object a player owns, and
 * §40.6 makes opening one a reveal. Three of the fourteen cards in the pool
 * were drawn; the other eleven arrived as a paragraph of text, so eleven
 * fourteenths of every Genesis reveal was a form field where the object should
 * have been.
 *
 * So the card is a *frame* rather than a picture, and the picture is what goes
 * inside it. The three that have art show it in the window; the eleven that do
 * not show a device drawn for them here. Both are the same card — same border,
 * same rarity plate, same name plate, same footer — which is what stops the
 * deck reading as three real cards and eleven placeholders.
 *
 * Everything on it is read from the catalog `@ponswars/shared-types` locks:
 * the name, the rarity, the charge count. A card face that stated its own
 * rarity would be a second copy of the one fact the whole Genesis system is
 * keyed on.
 *
 * Drawn rather than exported. A card is shown at 90 pixels in a war room and
 * 320 in a reveal, and one set of paths is sharp at both — and a rarity that
 * changes colour changes the whole frame with it without anyone re-exporting
 * anything.
 */

/**
 * The device on the eleven cards with no art of their own.
 *
 * Each one is the card's own `visualSignature` from the catalog, drawn: the
 * supply drop is a canister under a chute, the triple engine is three nozzles
 * firing. Flat geometry on a 64-unit field, like the faction emblems, so the
 * cards and the heraldry read as one hand.
 *
 * Two entries are missing on purpose, and it is not an oversight: `GOLDEN_ARMY`
 * and `SECRET_STOCK_DROP` have painted art, and a fallback device for a card
 * that never falls back is a drawing nobody will ever see and nobody will ever
 * check.
 */
const DEVICE: Readonly<Partial<Record<CardType, readonly string[]>>> = {
  // Additional squad deployment: three ranks advancing.
  REINFORCEMENT: [
    'M32 14 L44 30 L38 30 L32 22 L26 30 L20 30 Z',
    'M32 28 L44 44 L38 44 L32 36 L26 44 L20 44 Z',
    'M32 42 L44 58 L38 58 L32 50 L26 58 L20 58 Z',
  ],
  // A signal flare: a burst held at the centre, throwing light four ways.
  MARKET_SIGNAL: [
    'M32 24 L38 32 L32 40 L26 32 Z',
    'M32 6 L35 20 L29 20 Z',
    'M32 58 L29 44 L35 44 Z',
    'M6 32 L20 29 L20 35 Z',
    'M58 32 L44 35 L44 29 Z',
  ],
  // A canister under a chute.
  SUPPLY_DROP: [
    'M12 20 L20 8 L44 8 L52 20 L44 20 L38 13 L26 13 L20 20 Z',
    'M20 21 L29 32 L26 34 Z',
    'M44 21 L35 32 L38 34 Z',
    'M24 34 L40 34 L40 56 L24 56 Z M28 39 L36 39 L36 44 L28 44 Z',
  ],
  // A heavy column: two broad ranks over a road.
  HEAVY_REINFORCEMENT: [
    'M32 10 L50 30 L41 30 L32 20 L23 30 L14 30 Z',
    'M32 24 L50 44 L41 44 L32 34 L23 44 L14 44 Z',
    'M16 50 L48 50 L48 57 L16 57 Z',
  ],
  // Throughput: each rank of the route carrying more than the last.
  VOLUME_BOOSTER: [
    'M13 45 L20 45 L20 54 L13 54 Z',
    'M23 35 L30 35 L30 54 L23 54 Z',
    'M34 25 L41 25 L41 54 L34 54 Z',
    'M44 12 L51 12 L51 54 L44 54 Z',
  ],
  // A broadcast, amplified: a mast throwing two widening arcs.
  MARKET_AMPLIFIER: [
    'M29 28 L35 28 L35 54 L29 54 Z',
    'M20 56 L44 56 L44 60 L20 60 Z',
    'M32 12 L42 22 L37 26 L32 21 L27 26 L22 22 Z',
    'M32 3 L50 20 L45 25 L32 13 L19 25 L14 20 Z',
  ],
  // A charge: horns thrown wide over an advance.
  BULL_RUN: [
    'M32 14 L47 27 L40 30 L32 23 L24 30 L17 27 Z',
    'M32 28 L45 44 L37 44 L37 58 L27 58 L27 44 L19 44 Z',
  ],
  // Flow: three bands crossing the field.
  LIQUIDITY_WAVE: [
    'M8 22 L21 16 L32 22 L43 16 L56 22 L56 28 L43 22 L32 28 L21 22 L8 28 Z',
    'M8 33 L21 27 L32 33 L43 27 L56 33 L56 39 L43 33 L32 39 L21 33 L8 39 Z',
    'M8 44 L21 38 L32 44 L43 38 L56 44 L56 50 L43 44 L32 50 L21 44 L8 50 Z',
  ],
  // The bridge the chain is named for, and a surge crossing it.
  PONS_SURGE: [
    'M32 6 L41 22 L35 22 L35 32 L29 32 L29 22 L23 22 Z',
    'M9 36 L55 36 L55 42 L9 42 Z',
    'M15 42 L22 42 L22 57 L15 57 Z',
    'M42 42 L49 42 L49 57 L42 57 Z',
  ],
  // A heavy walking in.
  WAR_MACHINE: [
    'M25 10 L39 10 L42 19 L22 19 Z',
    'M18 21 L46 21 L46 38 L18 38 Z M27 26 L37 26 L37 33 L27 33 Z',
    'M21 40 L30 40 L27 58 L18 58 Z',
    'M34 40 L43 40 L46 58 L37 58 Z',
  ],
  // Three channels lit at once.
  TRIPLE_ENGINE: [
    'M12 15 L25 15 L23 33 L14 33 Z',
    'M26 9 L38 9 L38 33 L26 33 Z',
    'M39 15 L52 15 L50 33 L41 33 Z',
    'M15 35 L22 35 L18 51 Z',
    'M28 35 L36 35 L32 59 Z',
    'M42 35 L49 35 L46 51 Z',
  ],
  // A sweep across every channel at once.
  MARKET_DOMINANCE: [
    'M12 31 L12 13 L22 23 L32 9 L42 23 L52 13 L52 31 Z',
    'M12 34 L52 34 L52 41 L12 41 Z',
    'M15 45 L49 45 L49 49 L15 49 Z',
    'M20 52 L44 52 L44 56 L20 56 Z',
  ],
};

/**
 * One Genesis card.
 *
 * `usesRemaining` is optional because a card has two lives: the moment it is
 * opened, when the only honest number is how many charges it *comes* with, and
 * every moment after, when what matters is how many are left. The reveal passes
 * nothing and gets the catalog's count; the war room passes what is left.
 */
export function GenesisCardFace({
  cardType,
  rarity,
  genesisId,
  usesRemaining,
  width = 260,
}: {
  readonly cardType: CardType;
  readonly rarity: Rarity;
  /**
   * The claim this card came from (§7.6).
   *
   * Absent when the card being drawn is a catalog entry rather than someone's
   * card — the pool on the about page is fourteen classes, not fourteen claims,
   * and printing a made-up number on each would be inventing fourteen records.
   */
  readonly genesisId?: string;
  readonly usesRemaining?: number;
  readonly width?: number;
}): JSX.Element {
  const card = CARD_CATALOG[cardType];
  const accent = RARITY_COLOR[rarity];
  const art = CARD_ART[cardType];
  const device = DEVICE[cardType];
  const total = RARITY_USES[rarity];
  const left = usesRemaining ?? total;
  const spent = left === 0;
  const clip = `pw-card-window-${cardType}`;
  // Below about this width the footer line is a grey smudge rather than text —
  // it is 12px on a 300-unit card, so a 148-pixel card renders it at six. A
  // gallery of the pool states the charge count once per rarity anyway, which
  // is the only thing down there a catalog view needs.
  const compact = width < 180;

  return (
    <svg
      viewBox="0 0 300 420"
      width={width}
      role="img"
      aria-label={`${card.name}, ${rarity.toLowerCase()}`}
      style={{ width, maxWidth: '100%', height: 'auto', display: 'block' }}
    >
      <defs>
        <clipPath id={clip}>
          <rect x="22" y="46" width="256" height="212" rx="4" />
        </clipPath>
      </defs>

      {/* The card stock, then the rarity's own border on top of it. A spent
          card keeps its face and loses its light: §34.2 makes a depleted card a
          permanent artifact rather than something that disappears. */}
      <g opacity={spent ? 0.62 : 1}>
        <rect x="2" y="2" width="296" height="416" rx="10" fill="#0a1219" />
        <rect
          x="4"
          y="4"
          width="292"
          height="412"
          rx="9"
          fill="none"
          stroke={accent}
          strokeWidth="2"
        />
        <rect
          x="12"
          y="12"
          width="276"
          height="396"
          rx="5"
          fill="none"
          stroke={accent}
          strokeWidth="1"
          opacity="0.4"
        />

        {/* Corner ties. Four short angles are what makes a rectangle read as a
            frame rather than as a box. */}
        {(
          [
            [12, 12, 1, 1],
            [288, 12, -1, 1],
            [12, 408, 1, -1],
            [288, 408, -1, -1],
          ] as const
        ).map(([x, y, sx, sy]) => (
          <path
            key={`${String(x)}-${String(y)}`}
            d={`M${String(x)} ${String(y + sy * 22)} L${String(x)} ${String(y)} L${String(x + sx * 22)} ${String(y)}`}
            fill="none"
            stroke={accent}
            strokeWidth="2.5"
          />
        ))}

        <text
          x="150"
          y="36"
          textAnchor="middle"
          fill={accent}
          style={{
            fontFamily: 'var(--pw-font-display)',
            fontSize: 13,
            letterSpacing: '0.22em',
          }}
        >
          {rarity}
        </text>

        {/* The window. Painted art where there is any, the card's own device
            where there is not — the frame does not change between the two. */}
        <rect x="22" y="46" width="256" height="212" rx="4" fill="#060d13" />
        {art === undefined ? (
          <g
            transform="translate(80 74) scale(2.1875)"
            fill={accent}
            fillRule="evenodd"
            opacity="0.92"
          >
            {(device ?? []).map((path) => (
              <path key={path} d={path} />
            ))}
          </g>
        ) : (
          <image
            href={art}
            x="22"
            y="46"
            width="256"
            height="212"
            preserveAspectRatio="xMidYMid slice"
            clipPath={`url(#${clip})`}
          />
        )}
        <rect
          x="22"
          y="46"
          width="256"
          height="212"
          rx="4"
          fill="none"
          stroke={accent}
          strokeWidth="1"
          opacity="0.55"
        />

        {/* The name plate. */}
        <rect x="22" y="272" width="256" height="40" rx="3" fill="#101d26" />
        <rect
          x="22"
          y="272"
          width="256"
          height="40"
          rx="3"
          fill="none"
          stroke={accent}
          strokeWidth="1"
          opacity="0.45"
        />
        <text
          x="150"
          y="298"
          textAnchor="middle"
          fill="#e8f1f6"
          style={{ fontFamily: 'var(--pw-font-display)', fontSize: 19, letterSpacing: '0.06em' }}
        >
          {card.name.toUpperCase()}
        </text>

        <text
          x="150"
          y="336"
          textAnchor="middle"
          fill="#9fb2bf"
          style={{ fontFamily: 'var(--pw-font-ui)', fontSize: 13 }}
        >
          {cardEffectLine(cardType)}
        </text>

        {compact ? null : (
          <>
            <path d="M40 352 L260 352" stroke={accent} strokeWidth="1" opacity="0.3" />

            <text
              x="40"
              y="374"
              fill={spent ? accent : '#9fb2bf'}
              style={{ fontFamily: 'var(--pw-font-data)', fontSize: 12, letterSpacing: '0.08em' }}
            >
              {spent
                ? 'DEPLETED'
                : `USES ${String(left).padStart(2, '0')} / ${String(total).padStart(2, '0')}`}
            </text>
            {genesisId === undefined ? null : (
              <text
                x="260"
                y="374"
                textAnchor="end"
                fill="#6f828f"
                style={{
                  fontFamily: 'var(--pw-font-data)',
                  fontSize: 12,
                  letterSpacing: '0.08em',
                }}
              >
                #{genesisId}
              </text>
            )}
            <text
              x="150"
              y="398"
              textAnchor="middle"
              fill="#5d7080"
              style={{ fontFamily: 'var(--pw-font-display)', fontSize: 10, letterSpacing: '0.3em' }}
            >
              PONSWARS · GENESIS
            </text>
          </>
        )}
      </g>
    </svg>
  );
}

/**
 * What the card does, in the product's own words.
 *
 * Built from the catalog's support values rather than from a second table of
 * strings: §12.4 fixes what each card contributes, and a card face that printed
 * a different number from the one the engine applies would be the worst place
 * in the product for the two to disagree.
 */
export function cardEffectLine(cardType: CardType): string {
  const { support } = CARD_CATALOG[cardType];
  const channels = (
    [
      ['general', 'General Support'],
      ['market', 'Market Support'],
      ['volume', 'Volume Support'],
      ['pons', 'Pons Support'],
    ] as const
  ).filter(([channel]) => support[channel] > 0);

  if (channels.length === 0) {
    // The Secret is a Genesis outcome rather than a stronger card (§8.1), so it
    // has no battle support to print and saying `+0` would suggest it failed to
    // load one.
    return 'No battle support';
  }
  if (channels.length > 1) {
    // Every multi-channel card in the pool contributes the same to each, so one
    // line reads better than three — and if that ever stops being true, the
    // amount below is read from the first channel and the others are named, so
    // it would be visibly wrong rather than quietly wrong.
    return `${channels.map(([, label]) => label.replace(' Support', '')).join(' · ')} +${amount(cardType, channels[0]?.[0] ?? 'general')}`;
  }
  const [channel, label] = channels[0] ?? (['general', 'General Support'] as const);
  return `${label} +${amount(cardType, channel)}`;
}

/** A support value in tenths, as the product writes it. */
function amount(cardType: CardType, channel: 'general' | 'market' | 'volume' | 'pons'): string {
  const tenths = CARD_CATALOG[cardType].support[channel];
  const units = tenths / SUPPORT_UNIT_SCALE;
  return tenths % SUPPORT_UNIT_SCALE === 0 ? String(units) : units.toFixed(1);
}
