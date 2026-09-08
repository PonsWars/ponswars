import type { JSX } from 'react';
import { captionStyle, panelStyle } from './styles.js';

/**
 * Round identity and phase (§42.2).
 *
 * Separate from the countdown because §42.7 gates them separately: the round
 * label belongs to the global view, the countdown follows the player all the way
 * down to the battlefield.
 */
export function RoundStatus(): JSX.Element {
  return (
    <div style={panelStyle}>
      <div style={captionStyle}>PONSWARS</div>
      <div
        style={{
          fontFamily: 'var(--pw-font-display)',
          letterSpacing: '0.08em',
          color: 'var(--pw-text-2)',
          fontSize: 12,
        }}
      >
        PICK PHASE
      </div>
    </div>
  );
}

/**
 * The countdown to lock (§3.2, §42.2).
 *
 * Tabular numerals so it does not jitter as digits change (§36.12, design
 * tokens §5). A player has one minute to decide (§3.1); a timer that shifts
 * width under them is a small cruelty.
 *
 * The value is a projection from server time through the observed clock offset
 * (§23.5), which is why it arrives as a prop rather than being counted here off
 * `Date.now()`. Until the round feed is wired, the caller supplies a fixed
 * value rather than a locally-ticking one that would look authoritative and be
 * wrong.
 */
export function Countdown({ label }: { readonly label: string }): JSX.Element {
  return (
    <div style={panelStyle}>
      <div style={captionStyle}>LOCKS IN</div>
      <div className="pw-tabular" style={{ fontSize: 28, color: 'var(--pw-text-1)' }}>
        {label}
      </div>
    </div>
  );
}
