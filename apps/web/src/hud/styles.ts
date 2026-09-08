import { MIN_TOUCH_TARGET } from '@ponswars/ui-tokens';
import type { CSSProperties } from 'react';

/**
 * Shared HUD surfaces.
 *
 * One definition each, so a panel cannot drift into its own idea of what a
 * tactical glass panel looks like. No colour, radius, timing or z-index is
 * written as a literal — they come from the token stylesheet, which design
 * tokens §1 requires.
 */

/**
 * §42.11: mostly transparent charcoal-tinted tactical glass, thin borders,
 * restrained depth blur. Explicitly not heavy glassmorphism.
 */
export const panelStyle: CSSProperties = {
  background: 'var(--pw-surface-2)',
  border: 'var(--pw-line-hair) solid var(--pw-border-1)',
  borderRadius: 'var(--pw-radius-panel)',
  backdropFilter: 'blur(6px)',
  padding: 'var(--pw-space-3) var(--pw-space-4)',
};

/**
 * A control.
 *
 * `MIN_TOUCH_TARGET` on both axes is not decoration: §83.1 requires every
 * gesture to have a reachable tappable equivalent, and a 30-pixel button is not
 * one on a phone.
 */
export const controlStyle: CSSProperties = {
  ...panelStyle,
  minHeight: MIN_TOUCH_TARGET,
  minWidth: MIN_TOUCH_TARGET,
  color: 'var(--pw-text-1)',
  cursor: 'pointer',
  transition: 'background var(--pw-dur-fast) var(--pw-ease-ui)',
};

/** A small caps label above a value. */
export const captionStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.12em',
  color: 'var(--pw-text-3)',
  fontFamily: 'var(--pw-font-display)',
};

/** A headline value inside a panel. */
export const readoutStyle: CSSProperties = {
  fontFamily: 'var(--pw-font-display)',
  fontSize: 18,
  color: 'var(--pw-text-1)',
};

/**
 * Turns a `SCREAMING_SNAKE` enum member into display copy.
 *
 * The enums in `@ponswars/shared-types` are the canonical vocabulary — §12.5
 * and §10.2 fix exactly which words a client may show — so the UI renders those
 * words rather than inventing synonyms for them. This only replaces the
 * underscores.
 */
export function humanize(value: string): string {
  return value.replaceAll('_', ' ');
}
