import type { JSX } from 'react';
import { nowUtc, useSession } from '../state/session.js';
import { controlStyle, humanize } from './styles.js';

/**
 * The five-battle switcher (§42.9).
 *
 * *"Use a compact tactical strip rather than a large sidebar."* Selecting an
 * item flies the camera there (§37.8) instead of loading a page — after lock,
 * switching between the five live battles is movement inside one world.
 *
 * The strip scrolls rather than wraps. Wrapping turns five entries into two or
 * three rows on a phone, and a strip that grows taller as the viewport narrows
 * is the sidebar §42.9 rejects, arriving sideways.
 */
export function BattleSwitcher(): JSX.Element {
  const battles = useSession((state) => state.battles);
  const myBattleId = useSession((state) => state.myBattleId);
  const focusedBattleId = useSession((state) => state.camera.focusedBattleId);
  const focusSector = useSession((state) => state.focusSector);

  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--pw-space-2)',
        flexWrap: 'nowrap',
        overflowX: 'auto',
        maxWidth: '100%',
        // The strip owns horizontal scrolling; the world keeps every other
        // gesture (§37.3, §37.4).
        touchAction: 'pan-x',
      }}
    >
      {battles.map((battle, index) => (
        <button
          key={battle.battleId}
          type="button"
          aria-pressed={battle.battleId === focusedBattleId}
          onClick={() => {
            focusSector(index, nowUtc());
          }}
          style={{
            ...controlStyle,
            padding: 'var(--pw-space-2) var(--pw-space-3)',
            textAlign: 'left',
            // Entries keep their natural width instead of being squeezed by the
            // flex container as the strip fills up.
            flex: '0 0 auto',
            whiteSpace: 'nowrap',
            borderColor:
              battle.battleId === focusedBattleId ? 'var(--pw-accent)' : 'var(--pw-border-1)',
          }}
        >
          <span style={{ fontSize: 12, fontFamily: 'var(--pw-font-display)' }}>
            {battle.left} / {battle.right}
          </span>
          <span
            style={{
              display: 'block',
              fontSize: 10,
              letterSpacing: '0.1em',
              // §37.7 requires a clear selected-war indicator, and §37.8 keeps
              // YOUR WAR marked while the player spectates the other four.
              color: battle.battleId === myBattleId ? 'var(--pw-accent)' : 'var(--pw-text-3)',
            }}
          >
            {battle.battleId === myBattleId ? 'YOUR WAR' : humanize(battle.momentum)}
          </span>
        </button>
      ))}
    </div>
  );
}
