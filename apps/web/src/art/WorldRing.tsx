import { ACTIVE_TICKERS, BATTLES_PER_ROUND } from '@ponswars/shared-types';
import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import type { JSX } from 'react';

/**
 * The world, as a plan (§38.2, §38.3).
 *
 * One Market Core with five neutral sectors around it and a route out to each —
 * the same arrangement the scene builds in three dimensions, drawn flat. It is
 * on the landing page because a visitor who has not entered yet needs to know
 * what shape the place is, and a paragraph saying *five sectors around a centre*
 * is a worse answer than five sectors around a centre.
 *
 * The count comes from `BATTLES_PER_ROUND` rather than from a five typed here.
 * §4.3 fixes it, the world layout derives its positions from it, and a diagram
 * of the world that disagreed with the world would be the one drawing nobody
 * would think to check.
 */
export function WorldRing({ size = 168 }: { readonly size?: number }): JSX.Element {
  const centre = 60;
  const radius = 40;

  const sectors = Array.from({ length: BATTLES_PER_ROUND }, (_, index) => {
    // The same heading the layout uses, so the plan and the place agree about
    // which way round they sit.
    const heading = (index / BATTLES_PER_ROUND) * Math.PI * 2 + Math.PI / 10 - Math.PI / 2;
    return {
      index,
      x: centre + Math.cos(heading) * radius,
      y: centre + Math.sin(heading) * radius,
    };
  });

  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      role="img"
      aria-label={`${String(BATTLES_PER_ROUND)} war sectors around the Market Core`}
      style={{ display: 'block', flex: 'none', maxWidth: '100%' }}
    >
      <circle
        cx={centre}
        cy={centre}
        r={radius + 14}
        fill="none"
        stroke="#1d3441"
        strokeWidth="1"
      />
      <circle
        cx={centre}
        cy={centre}
        r={radius}
        fill="none"
        stroke="#25404e"
        strokeWidth="1"
        strokeDasharray="2 4"
      />

      {sectors.map((sector) => (
        <line
          key={`route-${String(sector.index)}`}
          x1={centre}
          y1={centre}
          x2={sector.x}
          y2={sector.y}
          stroke="#24404f"
          strokeWidth="1"
        />
      ))}

      {/* The core: the one structure §38.2 keeps across every round. */}
      <path
        d="M60 48 L69 60 L60 72 L51 60 Z"
        fill="none"
        stroke="var(--pw-accent)"
        strokeWidth="1.6"
      />
      <circle cx={centre} cy={centre} r="3" fill="var(--pw-accent)" />

      {/* Five sectors, each carrying two of the ten. The pairing is redrawn
          every round (§4.4), so these are coloured by position in the roster
          rather than by a matchup — a plan of the ring, not a plan of a round. */}
      {sectors.map((sector) => {
        const left = ACTIVE_TICKERS[sector.index * 2];
        const right = ACTIVE_TICKERS[sector.index * 2 + 1];
        return (
          <g key={`sector-${String(sector.index)}`}>
            <circle cx={sector.x} cy={sector.y} r="9" fill="#0d1a23" stroke="#2c4a5a" />
            <path
              d={`M${String(sector.x - 6)} ${String(sector.y)} a6 6 0 0 1 12 0 Z`}
              fill={left === undefined ? '#2c4a5a' : FACTION_ACCENT[left]}
              opacity="0.9"
            />
            <path
              d={`M${String(sector.x - 6)} ${String(sector.y)} a6 6 0 0 0 12 0 Z`}
              fill={right === undefined ? '#2c4a5a' : FACTION_ACCENT[right]}
              opacity="0.9"
            />
          </g>
        );
      })}
    </svg>
  );
}
