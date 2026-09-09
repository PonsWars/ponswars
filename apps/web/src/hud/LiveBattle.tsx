import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import type { ClientBattle } from '../state/session.js';
import { captionStyle, humanize, panelStyle, readoutStyle } from './styles.js';

/**
 * The live battle readout (§42.6).
 *
 * Matchup, momentum, backing state and deployed card. No score: §12.5 and §48.3
 * keep the exact score hidden for the whole live battle, and it is revealed on
 * the result screen rather than by flying closer.
 *
 * Three of the delivered mockups show a live numeric score, so the temptation is
 * real and documented. Nothing here has to resist it, because `ClientBattle`
 * carries no score field and `PublicBattleStateUpdate` has a type test pinning
 * its key set — the number this panel might have shown does not exist anywhere
 * a component could reach. `mayRenderExactScore()` in the runtime is the same
 * answer for anything that asks directly.
 */
export function LiveBattle({
  battle,
  showDeployedCard,
}: {
  readonly battle: ClientBattle;
  readonly showDeployedCard: boolean;
}): JSX.Element {
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)', minWidth: 190 }}>
      <div>
        <div style={captionStyle}>WAR</div>
        <div style={readoutStyle}>
          <span style={{ color: FACTION_ACCENT[battle.left] }}>{battle.left}</span>
          <span style={{ color: 'var(--pw-text-3)' }}> / </span>
          <span style={{ color: FACTION_ACCENT[battle.right] }}>{battle.right}</span>
        </div>
      </div>

      <div>
        <div style={captionStyle}>WAR MOMENTUM</div>
        {/* Qualitative only. There is no numeric alternative in scope. */}
        <div style={readoutStyle}>{humanize(battle.momentum)}</div>
      </div>

      <div>
        <div style={captionStyle}>FRONTLINE</div>
        <Frontline battle={battle} />
      </div>

      <div>
        <div style={captionStyle}>YOUR BACKING</div>
        <div style={{ fontSize: 13, color: 'var(--pw-text-2)' }}>
          {battle.backing === null ? (
            'SPECTATING'
          ) : (
            <span style={{ color: FACTION_ACCENT[battle.backing.ticker] }}>
              {battle.backing.ticker}
            </span>
          )}
        </div>
      </div>

      {showDeployedCard && battle.backing !== null ? (
        <div>
          <div style={captionStyle}>GENESIS CARD</div>
          <div style={{ fontSize: 13, color: 'var(--pw-text-2)' }}>
            {battle.backing.cardDeployed ? 'DEPLOYED' : 'HELD'}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where the frontline stands, as a bar.
 *
 * The same number the world already draws (§13.4) — a normalized position, not
 * a score — shown here because §36.15 puts *where the frontline is* among the
 * things a player must take in instantly, and reading it off a 3D marker means
 * finding the marker first.
 *
 * No figure on it, and none derivable from it by eye beyond what the world
 * shows. Three of the delivered mockups put `68% — 32%` on exactly this bar;
 * §12.5 and §24 hide the exact score for the whole live window, and a
 * percentage here would be that score with a different unit on it. There is
 * nothing to resist: `ClientBattle` carries a frontline and no score.
 */
function Frontline({ battle }: { readonly battle: ClientBattle }): JSX.Element {
  const held = Math.min(Math.max(battle.frontline, 0), 1);

  return (
    <div
      style={{
        position: 'relative',
        height: 8,
        borderRadius: 2,
        overflow: 'hidden',
        background: 'var(--pw-surface-2)',
        border: '1px solid var(--pw-border-1)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          // Each side's ground, meeting where the line stands. Two accents
          // rather than one filled bar: a single bar against an empty track
          // reads as a meter with a value, and this is a position between two
          // named sides.
          background: `linear-gradient(to right, ${FACTION_ACCENT[battle.left]} 0%, ${
            FACTION_ACCENT[battle.left]
          } ${String(held * 100)}%, ${FACTION_ACCENT[battle.right]} ${String(
            held * 100,
          )}%, ${FACTION_ACCENT[battle.right]} 100%)`,
          opacity: 0.5,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `${String(held * 100)}%`,
          width: 2,
          marginLeft: -1,
          background: 'var(--pw-text-1)',
        }}
      />
    </div>
  );
}
