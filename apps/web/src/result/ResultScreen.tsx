import type { FinalizedBattleResult } from '@ponswars/shared-types';
import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { captionStyle, humanize, panelStyle, readoutStyle } from '../hud/styles.js';
import {
  formatScore,
  resultView,
  type PlayerResultView,
  type SideResultView,
} from './result-view.js';

/**
 * The battle result (§25, §27.8).
 *
 * The one screen in the product that shows a score. It appears after
 * `ROUND_FINALIZED` and takes a `FinalizedBattleResult` — a type that only
 * exists once the engine has finalized — so there is no way to reach this from
 * a battle still running.
 *
 * The component breakdown is shown in full. §26 makes a result reproducible from
 * published evidence, and a winner announced without the four components that
 * produced it is a verdict rather than a record.
 */
export function ResultScreen({
  result,
  player,
}: {
  readonly result: FinalizedBattleResult;
  readonly player: PlayerResultView | null;
}): JSX.Element {
  const view = resultView(result);

  return (
    <>
      <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-3)' }}>
        <div style={captionStyle}>RESULT</div>
        <div style={{ ...readoutStyle, fontSize: 28, color: FACTION_ACCENT[view.winner] }}>
          {view.winner} WINS
        </div>
        <div style={{ ...captionStyle, color: 'var(--pw-text-2)' }}>
          {humanize(view.victoryLabel)}
        </div>
        {view.tiebreakStep === null ? null : (
          // §12.7: the totals tied and a named step decided it. Hiding that
          // would make the result look closer to arbitrary than it is.
          <div style={{ ...captionStyle, color: 'var(--pw-warning)' }}>
            DECIDED BY TIEBREAK — {humanize(view.tiebreakStep)}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 'var(--pw-space-3)',
        }}
      >
        <SidePanel side={view.left} />
        <SidePanel side={view.right} />
      </div>

      {player === null ? null : <PlayerPanel player={player} />}

      <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
        <div style={captionStyle}>PROVENANCE</div>
        {/* §26 and §66.4: a result is reproducible from a published evidence
            bundle, and the scoring version says which rules produced it. Showing
            both is what lets a player argue with a result rather than only
            believe it. */}
        <div className="pw-tabular" style={{ fontSize: 11, color: 'var(--pw-text-3)' }}>
          ENGINE {view.scoringEngineVersion}
        </div>
        <div
          className="pw-tabular"
          style={{ fontSize: 11, color: 'var(--pw-text-3)', wordBreak: 'break-all' }}
        >
          EVIDENCE {view.evidenceHash}
        </div>
      </div>
    </>
  );
}

/** One side's total and the four components behind it (§12.2). */
function SidePanel({ side }: { readonly side: SideResultView }): JSX.Element {
  return (
    <div
      style={{
        ...panelStyle,
        display: 'grid',
        gap: 'var(--pw-space-2)',
        borderColor: side.won ? FACTION_ACCENT[side.ticker] : 'var(--pw-border-1)',
      }}
    >
      <div style={{ ...captionStyle, color: FACTION_ACCENT[side.ticker] }}>{side.ticker}</div>
      <div className="pw-tabular" style={{ ...readoutStyle, fontSize: 32 }}>
        {side.totalLabel}
      </div>
      <Component caption="PRICE MOMENTUM" tenths={side.breakdown.priceMomentum} />
      <Component caption="RELATIVE VOLUME" tenths={side.breakdown.relativeVolume} />
      <Component caption="PONS POWER" tenths={side.breakdown.ponsPower} />
      <Component caption="CARD SUPPORT" tenths={side.breakdown.holderCardSupport} />
    </div>
  );
}

function Component({
  caption,
  tenths,
}: {
  readonly caption: string;
  readonly tenths: number;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 'var(--pw-space-3)',
        fontSize: 11,
        lineHeight: 1.8,
      }}
    >
      <span style={{ color: 'var(--pw-text-3)' }}>{caption}</span>
      <span className="pw-tabular" style={{ color: 'var(--pw-text-2)' }}>
        {formatScore(tenths)}
      </span>
    </div>
  );
}

/** What this result meant for the player (§27.8, §11). */
function PlayerPanel({ player }: { readonly player: PlayerResultView }): JSX.Element {
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
      <div style={captionStyle}>YOUR WAR</div>
      <div style={{ ...readoutStyle, fontSize: 18 }}>
        YOU BACKED <span style={{ color: FACTION_ACCENT[player.backed] }}>{player.backed}</span>
      </div>
      <div
        style={{
          ...captionStyle,
          color: player.won ? 'var(--pw-accent)' : 'var(--pw-text-3)',
        }}
      >
        {player.won ? 'WON' : 'LOST'}
      </div>
      <div className="pw-tabular" style={{ ...readoutStyle, fontSize: 22 }}>
        +{player.warPoints} WP
      </div>
      <div style={{ display: 'flex', gap: 'var(--pw-space-3)' }}>
        {player.upset ? (
          <span style={{ ...captionStyle, color: 'var(--pw-accent)' }}>UPSET</span>
        ) : null}
        {player.cardAssist ? (
          <span style={{ ...captionStyle, color: 'var(--pw-text-2)' }}>CARD ASSIST</span>
        ) : null}
      </div>
    </div>
  );
}
