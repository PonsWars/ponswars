import type { JSX } from 'react';
import { nowUtc, useSession } from '../state/session.js';
import { controlStyle } from './styles.js';

/**
 * Visible navigation controls (§42.8, §37.7).
 *
 * *"Provide visible controls in addition to gesture/mouse navigation: zoom +/−,
 * FOCUS MY WAR, RESET VIEW."* Every one of these has a gesture equivalent, and
 * §83.1 is why both exist: a player who cannot drag — a trackpad they dislike, a
 * motor impairment, a phone in one hand — must still reach every part of the
 * world.
 *
 * RESET VIEW is never disabled. It is the control someone reaches for when they
 * are lost, and §37.7's promise that free navigation never strands anyone only
 * holds if the way out is always live.
 */
export function NavigationControls(): JSX.Element {
  const resetView = useSession((state) => state.resetView);
  const focusMyWar = useSession((state) => state.focusMyWar);
  const zoomNotches = useSession((state) => state.zoomNotches);
  const myBattleId = useSession((state) => state.myBattleId);

  return (
    <div style={{ display: 'flex', gap: 'var(--pw-space-2)', alignItems: 'stretch' }}>
      <button
        type="button"
        style={{ ...controlStyle, fontSize: 18 }}
        aria-label="Zoom in"
        onClick={() => {
          zoomNotches(-1);
        }}
      >
        +
      </button>
      <button
        type="button"
        style={{ ...controlStyle, fontSize: 18 }}
        aria-label="Zoom out"
        onClick={() => {
          zoomNotches(1);
        }}
      >
        −
      </button>
      <button
        type="button"
        style={controlStyle}
        onClick={() => {
          focusMyWar(nowUtc());
        }}
        disabled={myBattleId === null}
      >
        FOCUS MY WAR
      </button>
      <button
        type="button"
        style={controlStyle}
        onClick={() => {
          resetView(nowUtc());
        }}
      >
        RESET VIEW
      </button>
    </div>
  );
}
