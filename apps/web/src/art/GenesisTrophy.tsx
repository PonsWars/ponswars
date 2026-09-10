import { RARITY_COLOR } from '@ponswars/ui-tokens';
import type { JSX } from 'react';

/**
 * The Secret trophy (§8.4, §34.8).
 *
 * §34.8 makes this *"a permanent, non-transferable artifact tied to the
 * original Genesis wallet record"* — it outlives the claim it came from and it
 * is the only thing in the product a player keeps forever. The war room stated
 * it in two lines of text, which is the right amount of space for a checkbox
 * and the wrong amount for the rarest thing anyone here can hold.
 *
 * A cut column on a plinth, holding the house mark. Deliberately not a cup: a
 * trophy for winning is a different claim from a record of having been there,
 * and §8.1 makes the Secret a Genesis outcome rather than a prize for play.
 */
export function GenesisTrophy({ size = 130 }: { readonly size?: number }): JSX.Element {
  const accent = RARITY_COLOR.SECRET;

  return (
    <svg
      viewBox="0 0 100 148"
      width={Math.round(size * (100 / 148))}
      height={size}
      role="img"
      aria-label="Secret Genesis trophy"
      style={{ display: 'block', flex: 'none' }}
    >
      {/* The plinth. */}
      <path d="M20 126 L80 126 L88 140 L12 140 Z" fill="#0f1a23" stroke="#33424e" />
      <path d="M30 116 L70 116 L70 126 L30 126 Z" fill="#0c151d" stroke="#33424e" />

      {/* The column, cut so the light has somewhere to sit. */}
      <path
        d="M50 8 L72 40 L66 114 L34 114 L28 40 Z"
        fill="#0b141c"
        stroke={accent}
        strokeWidth="1.6"
      />
      <path d="M50 8 L50 114" stroke={accent} strokeWidth="0.8" opacity="0.35" />
      <path d="M28 40 L72 40" stroke={accent} strokeWidth="0.8" opacity="0.35" />
      <path d="M50 8 L28 40 L34 114 L50 114 Z" fill={accent} opacity="0.07" />

      {/* The house mark, held in the stone. */}
      <g transform="translate(29 46) scale(0.66)" fill={accent}>
        <path d="M32 12 L38 30 L32 26 L26 30 Z" />
        <path d="M18 24 L26 36 L18 44 L14 33 Z" />
        <path d="M46 24 L50 33 L46 44 L38 36 Z" />
        <path d="M22 46 L42 46 L42 51 L22 51 Z" />
      </g>

      <g stroke={accent} strokeWidth="1.2" opacity="0.45">
        <path d="M50 2 L50 -4" />
        <path d="M14 60 L6 60" />
        <path d="M86 60 L94 60" />
      </g>
    </svg>
  );
}
