import { FACTIONS, type ActiveTicker } from '@ponswars/shared-types';
import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { FACTION_DEVICE } from './FactionEmblem.js';

/**
 * A faction's standard (§36.7, §39, and every delivered battlefield frame).
 *
 * The mockups hang these either side of a sector: a long banner off a crossbar,
 * carrying the emblem and the legion's name. It is the one piece of faction art
 * in the pack that is unmistakably a *fiction* — a flag belonging to an army
 * rather than a logo belonging to a company — which is why it is the piece
 * worth having when §7.10 rules the dossier art out.
 *
 * Drawn from the same device the emblem uses, so a faction has one mark at two
 * scales rather than two marks. A 26-pixel emblem in a sector label and a
 * 200-pixel standard on a dossier are the same shape, and a player who learns
 * one has learned the other.
 */
export function FactionStandard({
  ticker,
  height = 210,
}: {
  readonly ticker: ActiveTicker;
  readonly height?: number;
}): JSX.Element {
  const accent = FACTION_ACCENT[ticker];
  const faction = FACTIONS[ticker];
  const width = Math.round(height * 0.58);

  return (
    <svg
      viewBox="0 0 120 210"
      width={width}
      height={height}
      role="img"
      aria-label={`${ticker} standard`}
      style={{ display: 'block', flex: 'none' }}
    >
      {/* The crossbar it hangs from, and the two ties. A banner drawn without
          one reads as a rectangle with a picture in it. */}
      <path d="M6 8 L114 8 L114 14 L6 14 Z" fill={accent} opacity="0.75" />
      <path d="M2 4 L10 4 L10 18 L2 18 Z" fill={accent} opacity="0.5" />
      <path d="M110 4 L118 4 L118 18 L110 18 Z" fill={accent} opacity="0.5" />

      {/* The cloth: a long field cut to a swallow tail. */}
      <path
        d="M18 14 L102 14 L102 178 L60 196 L18 178 Z"
        fill="#0c1720"
        stroke={accent}
        strokeWidth="1.5"
      />
      <path d="M18 14 L102 14 L102 20 L18 20 Z" fill={accent} opacity="0.35" />

      {/* The device, in the upper field where a standard carries it. */}
      <g transform="translate(28 34) scale(1)" fill={accent} fillRule="evenodd">
        {FACTION_DEVICE[ticker].map((path) => (
          <path key={path} d={path} />
        ))}
      </g>

      <path d="M30 108 L90 108" stroke={accent} strokeWidth="1" opacity="0.4" />

      <text
        x="60"
        y="128"
        textAnchor="middle"
        fill={accent}
        style={{ fontFamily: 'var(--pw-font-display)', fontSize: 15, letterSpacing: '0.14em' }}
      >
        {ticker}
      </text>

      {/* The legion name, one word to a line so it fits the cloth. SVG text
          does not wrap, so the wrapping is done here rather than hoped for. */}
      {faction.name
        .toUpperCase()
        .split(' ')
        .slice(0, 3)
        .map((word, index) => (
          <text
            key={word}
            x="60"
            y={148 + index * 13}
            textAnchor="middle"
            fill="#a9bcc8"
            style={{ fontFamily: 'var(--pw-font-display)', fontSize: 9, letterSpacing: '0.16em' }}
          >
            {word}
          </text>
        ))}
    </svg>
  );
}
