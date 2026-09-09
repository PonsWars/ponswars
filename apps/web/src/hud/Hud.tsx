import { LAYER } from '@ponswars/ui-tokens';
import type { JSX, ReactNode } from 'react';
import type { Route } from '../routing/route.js';
import { currentHudBudget, currentZoom, useSession, type ClientBattle } from '../state/session.js';
import { BattleIntel } from './BattleIntel.js';
import { BattleSwitcher } from './BattleSwitcher.js';
import { ConnectionBanner } from './ConnectionBanner.js';
import { LiveBattle } from './LiveBattle.js';
import { NavigationControls } from './NavigationControls.js';
import { PickControls } from './PickControls.js';
import { Countdown, RoundStatus } from './RoundStatus.js';
import { panelStyle } from './styles.js';
import { useNarrowViewport } from './useNarrowViewport.js';
import { NavBar } from './NavBar.js';
import { NextRotation, WorldGuide } from './WorldGuide.js';
import { WalletSummary } from './WalletSummary.js';

/**
 * The HUD shell (§42).
 *
 * *"World is the hero. HUD only appears when needed. If a decision remains
 * clear with less UI, use less UI."*
 *
 * Every panel is gated on `hudBudgetFor`, which encodes §37.6's rule that
 * information density follows zoom. A component cannot decide for itself that it
 * belongs at the global view — the budget decides, and the runtime has a test
 * covering what each level allows.
 *
 * Two arrangements of the same panels. Wide viewports flank the world with intel
 * columns as §42.4 describes; narrow ones collect the same content into a bottom
 * sheet, because §37.4 asks for *"dedicated bottom sheets rather than shrunken
 * desktop panels"* — the panels are not scaled down, they are re-placed.
 */
export function Hud({ onNavigate }: { readonly onNavigate: (next: Route) => void }): JSX.Element {
  const camera = useSession((state) => state.camera);
  const battles = useSession((state) => state.battles);
  const narrow = useNarrowViewport();

  const budget = currentHudBudget({ camera });
  const zoom = currentZoom({ camera });
  const focused = battles.find((battle) => battle.battleId === camera.focusedBattleId);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        // The numeric constant rather than the CSS variable: React writes an
        // inline z-index through the CSSOM, which rejects a var() reference here
        // and silently leaves the element at `auto`. Both come from the same
        // token source, so §18's layer ownership still holds.
        zIndex: LAYER.hud,
        // The HUD floats over the world and must not swallow drag. Only the
        // controls themselves take pointer events (§37.3).
        pointerEvents: 'none',
        padding: 'var(--pw-space-4)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: 'var(--pw-space-4)',
        // §37.6 and §42.7: at the cinematic level most HUD fades to prioritise
        // the event. It fades rather than unmounting, so nothing reflows when it
        // returns — and it stops taking input while invisible.
        opacity: zoom === 4 ? 0 : 1,
        visibility: zoom === 4 ? 'hidden' : 'visible',
        transition: 'opacity var(--pw-dur-panel) var(--pw-ease-ui), visibility var(--pw-dur-panel)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--pw-space-3)' }}>
        <Live>
          {budget.roundState ? <RoundStatus /> : null}
          {budget.countdown ? <Countdown /> : null}
        </Live>
        <Live>
          {/* One bar, the same one every other surface uses (§80.4). Only at
              the global view: §37.6 ties density to zoom, and a player inside a
              battlefield is mid-decision. */}
          {budget.walletSummary ? (
            <NavBar current={{ kind: 'WORLD', battleId: null }} onNavigate={onNavigate}>
              <WalletSummary />
            </NavBar>
          ) : null}
          {budget.warMomentum && focused !== undefined ? (
            <LiveBattle battle={focused} showDeployedCard={budget.deployedCard} />
          ) : null}
        </Live>
      </div>

      <ConnectionBanner />

      {narrow ? null : <FlankingIntel budget={budget} battle={focused} />}

      {/* Orientation and schedule, at the global view only (§6.3, §37.6). Both
          sit above the bottom row so they read as world context rather than as
          controls — a player scanning for a button should not find these. */}
      {budget.walletSummary && !narrow ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            gap: 'var(--pw-space-3)',
          }}
        >
          <Live>
            <WorldGuide />
          </Live>
          <Live>
            <NextRotation />
          </Live>
        </div>
      ) : null}

      <div
        style={{
          display: 'flex',
          flexDirection: narrow ? 'column' : 'row',
          justifyContent: 'space-between',
          alignItems: narrow ? 'stretch' : 'flex-end',
          gap: 'var(--pw-space-3)',
        }}
      >
        {narrow ? <BottomSheet budget={budget} battle={focused} /> : null}
        <Live>{budget.battleSwitcher ? <BattleSwitcher /> : null}</Live>
        <Live>
          <NavigationControls />
        </Live>
      </div>
    </div>
  );
}

/**
 * Restores pointer events for one group.
 *
 * The shell ignores input so the world can be dragged through it; anything the
 * player is meant to touch has to opt back in (§37.3).
 */
function Live({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div
      style={{
        pointerEvents: 'auto',
        display: 'flex',
        gap: 'var(--pw-space-3)',
        alignItems: 'flex-start',
      }}
    >
      {children}
    </div>
  );
}

interface IntelProps {
  readonly budget: ReturnType<typeof currentHudBudget>;
  readonly battle: ClientBattle | undefined;
}

/**
 * The wide arrangement (§42.4): a column of intel on each side, sector between.
 */
function FlankingIntel({ budget, battle }: IntelProps): JSX.Element | null {
  if (!budget.battleConfidence || battle === undefined) {
    return null;
  }

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 'var(--pw-space-4)',
      }}
    >
      <Live>
        <BattleIntel ticker={battle.left} intel={battle.leftIntel} align="left" />
      </Live>
      <Live>
        {budget.pickControls ? <PickControls battle={battle} /> : null}
        <BattleIntel ticker={battle.right} intel={battle.rightIntel} align="right" />
      </Live>
    </div>
  );
}

/**
 * The narrow arrangement (§37.4): one sheet along the bottom edge.
 *
 * The same panels, re-placed rather than shrunk. It scrolls horizontally instead
 * of wrapping, so the sheet keeps a fixed height and never grows upward to eat
 * the world it is describing.
 */
function BottomSheet({ budget, battle }: IntelProps): JSX.Element | null {
  if (!budget.battleConfidence || battle === undefined) {
    return null;
  }

  return (
    <div
      style={{
        ...panelStyle,
        pointerEvents: 'auto',
        display: 'flex',
        gap: 'var(--pw-space-3)',
        overflowX: 'auto',
        // The sheet owns horizontal scrolling; the world keeps every other
        // gesture (§37.4).
        touchAction: 'pan-x',
        // Reaches the bottom edge on a notched phone without the last control
        // landing under the home indicator.
        paddingBottom: 'max(var(--pw-space-3), env(safe-area-inset-bottom))',
      }}
    >
      <BattleIntel ticker={battle.left} intel={battle.leftIntel} align="left" />
      {budget.pickControls ? <PickControls battle={battle} /> : null}
      <BattleIntel ticker={battle.right} intel={battle.rightIntel} align="right" />
    </div>
  );
}
