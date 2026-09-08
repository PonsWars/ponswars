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
