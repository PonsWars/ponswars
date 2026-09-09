import type { JSX } from 'react';
import { useSession } from '../state/session.js';
import { formatCountdown, roundView } from './round-phase.js';
import { captionStyle, panelStyle, readoutStyle } from './styles.js';

/**
 * How to move, and when the world changes (§6.3, §3.1).
 *
 * §6.3 is blunt about the first half: *"Even though the world is spatial, never
 * force navigation mastery."* A player who does not know they can drag the world
 * sees a static picture, and nothing else on screen tells them otherwise — the
 * gestures were implemented long before anything said they existed.
 *
 * The second half is the round clock. §3.1 makes rounds contiguous, so "when
 * does this change" is always answerable, and a player deciding whether to pick
 * now or wait is asking exactly that.
 *
 * Only at the global view. §37.6 ties density to zoom, and a player inside a
 * battlefield has already found their way there.
 */
export function WorldGuide(): JSX.Element {
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)', minWidth: 176 }}>
      <div style={captionStyle}>GLOBAL VIEW</div>
      <ul
        style={{
          display: 'grid',
          gap: 4,
          margin: 0,
          padding: 0,
          listStyle: 'none',
          fontSize: 11,
          color: 'var(--pw-text-2)',
        }}
      >
        {/* The four gestures `WorldInput` actually implements. A hint for one
            that did not work would be worse than no hint at all. */}
        <li>Drag to explore</li>
        <li>Scroll to zoom</li>
        <li>Click a sector to view</li>
        <li>ESC to step outward</li>
      </ul>
    </div>
  );
}

/**
 * When the next round opens (§3.1).
 *
 * Contiguous rounds mean the next one opens where this one ends, so this is the
 * battle end projected through the clock offset — not a separate schedule the
 * client would have to be told about and could get wrong.
 *
 * `null` before a round has arrived, and `null` again whenever the primary
 * countdown is already counting to the same instant — during a live battle the
 * round ends and the next opens together (§3.1), and the same number twice on
 * one screen reads as two facts rather than one.
 */
export function NextRotation(): JSX.Element | null {
  const round = useSession((state) => state.round);
  const clockOffsetMs = useSession((state) => state.clockOffsetMs);

  if (round === null) {
    return null;
  }

  // Compared against the phase countdown's own target rather than against a
  // list of phases: §22 has seven states, and a hand-kept list of "the ones
  // where these coincide" is a list that goes stale.
  if (roundView(round.state, round.clock).countdownTarget === round.clock.battleEndAt) {
    return null;
  }

  // Through the offset, never `Date.now()` alone (§23.5): a device clock that is
  // minutes out must still show the same rotation as everyone else's.
  const remaining = round.clock.battleEndAt - (Date.now() + clockOffsetMs);

  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 2, justifyItems: 'end', minWidth: 132 }}>
      <div style={captionStyle}>NEXT ROTATION</div>
      <div style={{ ...readoutStyle, fontSize: 20 }}>{formatCountdown(Math.max(0, remaining))}</div>
    </div>
  );
}
