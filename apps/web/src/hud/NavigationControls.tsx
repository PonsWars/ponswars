import type { JSX } from 'react';
import { nowUtc, useSession } from '../state/session.js';
import { isQualityChoice, QUALITY_CHOICES, qualityLabel } from './quality.js';
import { captionStyle, controlStyle } from './styles.js';

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
 *
 * The graphics tier sits with them because §82.2 gives the player the
 * override, and a setting with no surface is not an override. It shows what
 * the world is actually drawing at, so a device that dropped a tier to hold
 * the frame budget says so rather than quietly looking worse.
 */
export function NavigationControls(): JSX.Element {
  const resetView = useSession((state) => state.resetView);
  const focusMyWar = useSession((state) => state.focusMyWar);
  const zoomNotches = useSession((state) => state.zoomNotches);
  const myBattleId = useSession((state) => state.myBattleId);
  const quality = useSession((state) => state.quality);
  const setQuality = useSession((state) => state.setQuality);

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
      {/* A native select: §83.2 asks for a keyboard path to everything, and
          the platform's own control has one, on every device, for free. */}
      <label style={{ ...controlStyle, display: 'grid', alignContent: 'center', gap: 2 }}>
        <span style={captionStyle}>GRAPHICS</span>
        <select
          value={quality}
          onChange={(event) => {
            if (isQualityChoice(event.target.value)) {
              setQuality(event.target.value);
            }
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--pw-text-1)',
            font: 'inherit',
            letterSpacing: 'inherit',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {QUALITY_CHOICES.map((tier) => (
            <option key={tier} value={tier} style={{ color: '#0b1218' }}>
              {qualityLabel(tier)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
