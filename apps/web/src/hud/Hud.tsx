import { LAYER, MIN_TOUCH_TARGET } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { currentHudBudget, currentZoom, nowUtc, useSession } from '../state/session.js';

/**
 * The HUD (§42).
 *
 * *"World is the hero. HUD only appears when needed. If a decision remains
 * clear with less UI, use less UI."*
 *
 * Every panel here is gated on `hudBudgetFor`, which encodes §37.6's rule that
 * information density follows zoom. A component cannot decide for itself that
 * it belongs at the global view — the budget decides, and a test covers it.
 *
 * No colour, radius, timing or z-index is written here. They come from the
 * token stylesheet, which design tokens §1 requires.
 */

const panelStyle: React.CSSProperties = {
  // §42.11: mostly transparent charcoal-tinted tactical glass, thin borders,
  // restrained depth blur. Explicitly not heavy glassmorphism.
  background: 'var(--pw-surface-2)',
  border: 'var(--pw-line-hair) solid var(--pw-border-1)',
  borderRadius: 'var(--pw-radius-panel)',
  backdropFilter: 'blur(6px)',
  padding: 'var(--pw-space-3) var(--pw-space-4)',
};

const controlStyle: React.CSSProperties = {
  ...panelStyle,
  minHeight: MIN_TOUCH_TARGET,
  minWidth: MIN_TOUCH_TARGET,
  color: 'var(--pw-text-1)',
  cursor: 'pointer',
  transition: 'background var(--pw-dur-fast) var(--pw-ease-ui)',
};

function RoundStatus(): JSX.Element {
  return (
    <div style={panelStyle}>
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
      {/*
        Tabular numerals so the countdown does not jitter as digits change
        (§36.12, design tokens §5). A player has one minute to decide (§3.1);
        a timer that shifts width under them is a small cruelty.
      */}
      <div className="pw-tabular" style={{ fontSize: 28, color: 'var(--pw-text-1)' }}>
        00:37
      </div>
    </div>
  );
}

function BattleSwitcher(): JSX.Element {
  const battles = useSession((state) => state.battles);
  const myBattleId = useSession((state) => state.myBattleId);
  const focusedBattleId = useSession((state) => state.camera.focusedBattleId);
  const focusSector = useSession((state) => state.focusSector);

  return (
    // §42.9: a compact tactical strip, not a large sidebar.
    <div style={{ display: 'flex', gap: 'var(--pw-space-2)', flexWrap: 'wrap' }}>
      {battles.map((battle, index) => (
        <button
          key={battle.battleId}
          type="button"
          onClick={() => {
            focusSector(index, nowUtc());
          }}
          style={{
            ...controlStyle,
            padding: 'var(--pw-space-2) var(--pw-space-3)',
            borderColor:
              battle.battleId === focusedBattleId ? 'var(--pw-accent)' : 'var(--pw-border-1)',
          }}
        >
          <span style={{ fontSize: 12, fontFamily: 'var(--pw-font-display)' }}>
            {battle.left} / {battle.right}
          </span>
          {battle.battleId === myBattleId ? (
            <span
              style={{
                marginLeft: 'var(--pw-space-2)',
                fontSize: 10,
                color: 'var(--pw-accent)',
              }}
            >
              YOUR WAR
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function MomentumReadout(): JSX.Element | null {
  const battles = useSession((state) => state.battles);
  const focusedBattleId = useSession((state) => state.camera.focusedBattleId);
  const battle = battles.find((candidate) => candidate.battleId === focusedBattleId);

  if (battle === undefined) {
    return null;
  }

  return (
    <div style={panelStyle}>
      <div style={{ fontSize: 10, color: 'var(--pw-text-3)', letterSpacing: '0.1em' }}>
        WAR MOMENTUM
      </div>
      {/*
        Qualitative only. §12.5 keeps the exact score hidden for the whole live
        battle, and three of the delivered mockups show one anyway - so there is
        deliberately nothing numeric to render here.
      */}
      <div style={{ fontFamily: 'var(--pw-font-display)', fontSize: 20 }}>{battle.momentum}</div>
    </div>
  );
}

function NavigationControls(): JSX.Element {
  const resetView = useSession((state) => state.resetView);
  const focusMyWar = useSession((state) => state.focusMyWar);
  const myBattleId = useSession((state) => state.myBattleId);

  return (
    // §42.8 and §83.1: visible controls alongside gesture navigation, so every
    // action reachable by dragging the world is also reachable by tapping.
    <div style={{ display: 'flex', gap: 'var(--pw-space-2)' }}>
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

export function Hud(): JSX.Element {
  const camera = useSession((state) => state.camera);
  const budget = currentHudBudget({ camera });
  const zoom = currentZoom({ camera });

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        // The numeric constant rather than the CSS variable: React writes an
        // inline z-index through the CSSOM, which rejects a var() reference
        // here and silently leaves the element at `auto`. Both come from the
        // same token source, so §18's layer ownership still holds.
        zIndex: LAYER.hud,
        // The HUD floats over the world and must not swallow drag. Only the
        // controls themselves take pointer events (§37.3).
        pointerEvents: 'none',
        padding: 'var(--pw-space-4)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        // §37.6 and §42.7: at the cinematic level most HUD fades to prioritise
        // the event. It fades rather than unmounting, so nothing reflows when
        // it returns.
        opacity: zoom === 4 ? 0 : 1,
        transition: 'opacity var(--pw-dur-panel) var(--pw-ease-ui)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--pw-space-4)' }}>
        <div style={{ pointerEvents: 'auto' }}>{budget.roundState ? <RoundStatus /> : null}</div>
        <div style={{ pointerEvents: 'auto' }}>
          {budget.warMomentum ? <MomentumReadout /> : null}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          gap: 'var(--pw-space-4)',
        }}
      >
        <div style={{ pointerEvents: 'auto' }}>
          {budget.battleSwitcher ? <BattleSwitcher /> : null}
        </div>
        <div style={{ pointerEvents: 'auto' }}>
          <NavigationControls />
        </div>
      </div>
    </div>
  );
}
