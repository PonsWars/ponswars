import type { JSX } from 'react';

/**
 * The PonsWars mark.
 *
 * Drawn in the same language as the ten faction emblems — a blade device held
 * inside a diamond, vertically symmetric, one flat colour — because it is the
 * mark those ten belong to. A house mark in a different idiom from its own
 * heraldry reads as a partner logo rather than as the thing they are part of.
 *
 * The device is the arrowhead that appears stamped on the Genesis cards: two
 * blades meeting at a point over a bar. Everything else in the pack that is
 * original speaks that shape, so it is the one to build on.
 */
export function PonsWarsMark({
  size = 26,
  color = 'var(--pw-accent)',
}: {
  readonly size?: number;
  readonly color?: string;
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
      <path
        d="M32 2 L60 32 L32 62 L4 32 Z"
        fill="none"
        stroke={color}
        strokeWidth={2.5}
        opacity={0.55}
      />
      {/* The arrowhead: a central spike between two swept blades. */}
      <path d="M32 12 L38 30 L32 26 L26 30 Z" fill={color} />
      <path d="M18 24 L26 36 L18 44 L14 33 Z" fill={color} />
      <path d="M46 24 L50 33 L46 44 L38 36 Z" fill={color} />
      <path d="M22 46 L42 46 L42 51 L22 51 Z" fill={color} />
    </svg>
  );
}

/**
 * The wordmark beside it.
 *
 * Text rather than a drawn logotype: it stays selectable, it scales with the
 * type ramp, and a screen reader announces the product name instead of skipping
 * a picture of it.
 */
export function PonsWarsWordmark({ size = 15 }: { readonly size?: number }): JSX.Element {
  return (
    <span
      style={{
        fontFamily: 'var(--pw-font-display)',
        fontSize: size,
        letterSpacing: '0.02em',
        color: 'var(--pw-text-1)',
      }}
    >
      Pons<span style={{ color: 'var(--pw-accent)' }}>Wars</span>
    </span>
  );
}
