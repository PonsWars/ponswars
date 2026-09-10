import type { JSX } from 'react';

/**
 * The vault a distribution is paid out of (§35, §8.1).
 *
 * The delivered rewards hub is built around one object: a faceted vault holding
 * the reward, lit from inside, with the pool's own light coming through it. The
 * page had no image at all — a column of figures about money, which is exactly
 * the shape of the thing §35 is trying not to be.
 *
 * Drawn rather than exported, and abstract rather than a pile of coins. What
 * §35 rewards is participation measured against a published formula, and a
 * heap of gold would promise a different product from the one the numbers
 * beside it describe.
 *
 * `charged` is whether the pool is funded. An empty vault is drawn dark: §35.9
 * makes a dormant vault a state to state plainly rather than one to dress up.
 */
export function RewardVault({
  size = 168,
  charged = true,
}: {
  readonly size?: number;
  readonly charged?: boolean;
}): JSX.Element {
  const light = charged ? 'var(--pw-accent)' : '#3d4b55';

  return (
    <svg
      viewBox="0 0 140 140"
      width={size}
      height={size}
      role="img"
      aria-label={charged ? 'The rewards vault, funded' : 'The rewards vault, dormant'}
      style={{ display: 'block', flex: 'none', maxWidth: '100%' }}
    >
      {/* The plinth it stands on. */}
      <path d="M34 122 L106 122 L114 132 L26 132 Z" fill="#101c25" stroke="#283b47" />
      <path d="M46 112 L94 112 L94 122 L46 122 Z" fill="#0d1720" stroke="#283b47" />

      {/* The cut stone: an octahedron read as two facets over two more, so it
          holds a highlight without a gradient. */}
      <path d="M70 16 L108 58 L70 100 L32 58 Z" fill="#0b1620" stroke={light} strokeWidth="1.6" />
      <path d="M70 16 L70 100 L32 58 Z" fill={light} opacity={charged ? 0.14 : 0.06} />
      <path
        d="M70 16 L88 58 L70 100 L52 58 Z"
        fill="none"
        stroke={light}
        strokeWidth="1"
        opacity="0.55"
      />
      <path d="M32 58 L108 58" stroke={light} strokeWidth="1" opacity="0.4" />

      {/* What is held inside it. A ring rather than a coin: §35 pays a share of
          a pool, and a share is a proportion of something round. */}
      <circle cx="70" cy="58" r="13" fill="none" stroke={light} strokeWidth="2.4" />
      <circle cx="70" cy="58" r="4" fill={light} opacity={charged ? 1 : 0.4} />

      {/* Light leaving the vault, only when there is any to leave. */}
      {charged ? (
        <g stroke="var(--pw-accent)" strokeWidth="1.4" opacity="0.5">
          <path d="M70 8 L70 0" />
          <path d="M116 58 L126 58" />
          <path d="M24 58 L14 58" />
          <path d="M70 108 L70 116" />
        </g>
      ) : null}
    </svg>
  );
}
