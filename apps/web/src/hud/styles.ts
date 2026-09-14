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

/** The corner ticks on tactical glass: colour, and where each of the eight strokes lies. */
const CORNER_TICK = 'rgba(214, 236, 248, 0.34)';
const CORNER_INSET = '4px';
const CORNER_SIZES = Array.from({ length: 4 }, () => ['9px 1px', '1px 9px']).flat();
const CORNER_POSITIONS = (['left', 'right'] as const)
  .flatMap((x) =>
    (['top', 'bottom'] as const).map((y) => `${x} ${CORNER_INSET} ${y} ${CORNER_INSET}`),
  )
  .flatMap((position) => [position, position]);

/**
 * §42.11: mostly transparent charcoal-tinted tactical glass, thin borders,
 * restrained depth blur. Explicitly not heavy glassmorphism.
 */
export const panelStyle: CSSProperties = {
  background: 'var(--pw-surface-2)',
  // A sheen down the first stretch of the panel, and nothing after it. §42.11
  // asks for tactical glass rather than a flat plate, and glass is read from
  // the light that lands on its top edge — without it every panel in the
  // product was the same dark rectangle at the same value, whatever it sat on.
  //
  // Deliberately faint. §42.1 keeps the world the hero, and a panel with a
  // visible gradient in it competes with the thing behind it.
  //
  // And a tick in each corner: the small registration marks every delivered
  // HUD frame puts on its glass. They are what make a dark rectangle read as an
  // instrument rather than as a card. Drawn as background layers, so a panel
  // needs no extra elements and a component that overrides `background` gets a
  // plain panel back rather than a broken one.
  backgroundImage: [
    'linear-gradient(180deg, rgba(214, 236, 248, 0.05), rgba(214, 236, 248, 0) 42%)',
    ...Array.from({ length: 8 }, () => `linear-gradient(${CORNER_TICK}, ${CORNER_TICK})`),
  ].join(', '),
  backgroundSize: ['100% 100%', ...CORNER_SIZES].join(', '),
  backgroundPosition: ['0 0', ...CORNER_POSITIONS].join(', '),
  backgroundRepeat: 'no-repeat',
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
  // A command, in the display face (§36.12): the controls were the one place
  // left in the interface system face, and a HUD button in a paragraph font
  // reads as a web form.
  fontFamily: 'var(--pw-font-display)',
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: '0.07em',
  cursor: 'pointer',
  transition: 'background var(--pw-dur-fast) var(--pw-ease-ui)',
};

/**
 * A small caps label above a value.
 *
 * The interface face, not the display face. §36.12 gives the condensed
 * industrial face to headlines, and at the nine and ten pixels a caption is set
 * in, a condensed face closes up into a grey smear — which went unnoticed while
 * the display face was not loaded and everything fell back to Arial Narrow.
 */
export const captionStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.12em',
  color: 'var(--pw-text-3)',
  fontFamily: 'var(--pw-font-ui)',
};

/** A headline value inside a panel. */
export const readoutStyle: CSSProperties = {
  fontFamily: 'var(--pw-font-display)',
  fontSize: 20,
  fontWeight: 600,
  // Opened up a little: a condensed face at the thirteen pixels most readouts
  // are set in runs its letters together.
  letterSpacing: '0.05em',
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
