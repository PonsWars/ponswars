import type { FinalizedBattleResult } from '@ponswars/shared-types';
import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { captionStyle, humanize, panelStyle, readoutStyle } from '../hud/styles.js';
import {
  formatScore,
  resultView,
  type PlayerResultView,
  type ResultView,
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

      <HeadToHead view={view} />
      <Breakdown view={view} />

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

/**
 * The two totals, facing each other (§12.2).
 *
 * One line rather than two panels. A battle result is a comparison, and two
 * cards each holding their own number make the reader do the comparing — the
 * delivered result screen puts both totals either side of a `VS` for exactly
 * that reason, and it is the first thing anyone looks for.
 */
function HeadToHead({ view }: { readonly view: ResultView }): JSX.Element {
  return (
    <div
      style={{
        ...panelStyle,
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        gap: 'var(--pw-space-4)',
      }}
    >
      <Total side={view.left} align="start" />
      <div style={{ ...captionStyle, color: 'var(--pw-text-3)' }}>VS</div>
      <Total side={view.right} align="end" />
    </div>
  );
}

function Total({
  side,
  align,
}: {
  readonly side: SideResultView;
  readonly align: 'start' | 'end';
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 2, justifyItems: align, textAlign: align }}>
      <div style={{ ...captionStyle, color: FACTION_ACCENT[side.ticker] }}>{side.ticker}</div>
      <div
        className="pw-tabular"
        style={{
          ...readoutStyle,
          fontSize: 'clamp(30px, 6vw, 48px)',
          lineHeight: 1,
          // The loser's total is stated as plainly as the winner's — §26 makes
          // this a record, not an award ceremony — but the winner carries its
          // own colour, because the headline above already said who won and a
          // reader should not have to check twice.
          color: side.won ? FACTION_ACCENT[side.ticker] : 'var(--pw-text-2)',
        }}
      >
        {side.totalLabel}
      </div>
      <div style={{ ...captionStyle, fontSize: 9, color: 'var(--pw-text-3)' }}>
        {side.won ? 'WINNER' : ''}
      </div>
    </div>
  );
}

/** The four components §12 scores, each as a split between the two sides. */
function Breakdown({ view }: { readonly view: ResultView }): JSX.Element {
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
      <div style={captionStyle}>SCORE BREAKDOWN</div>
      {COMPONENTS.map(([key, caption]) => (
        <ComponentRow
          key={key}
          caption={caption}
          left={view.left.breakdown[key]}
          right={view.right.breakdown[key]}
          leftAccent={FACTION_ACCENT[view.left.ticker]}
          rightAccent={FACTION_ACCENT[view.right.ticker]}
        />
      ))}
      {/* §26: a result is reproducible from published evidence, and the reader
          is owed the arithmetic rather than only the verdict. */}
      <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--pw-text-3)' }}>
        Each component is shared between the two sides in the weight §12 fixes for it. The four
        together are the hundred points above.
      </p>
    </div>
  );
}

/** The four components, in the order §12 weights them. */
const COMPONENTS: readonly (readonly [keyof SideResultView['breakdown'], string])[] = [
  ['priceMomentum', 'PRICE MOMENTUM'],
  ['relativeVolume', 'RELATIVE VOLUME'],
  ['ponsPower', 'PONS POWER'],
  ['holderCardSupport', 'CARD SUPPORT'],
];

/**
 * One component, as two bars meeting at its name.
 *
 * Bars rather than a pair of figures in two columns: the numbers are the record
 * and the bars are what makes four of them readable at a glance. They grow out
 * from the middle in each side's own colour, so which side took a component is
 * the shape of the row rather than a comparison the reader performs.
 */
function ComponentRow({
  caption,
  left,
  right,
  leftAccent,
  rightAccent,
}: {
  readonly caption: string;
  readonly left: number;
  readonly right: number;
  readonly leftAccent: string;
  readonly rightAccent: string;
}): JSX.Element {
  // A component both sides scored nothing in is a legitimate result — a
  // suspended feed contributes zero to each — and dividing by the total would
  // put a NaN width on both bars.
  const total = left + right;
  const leftShare = total <= 0 ? 0.5 : left / total;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(48px, auto) 1fr minmax(96px, auto) 1fr minmax(48px, auto)',
        alignItems: 'center',
        gap: 'var(--pw-space-2)',
        fontSize: 11,
      }}
    >
      <span className="pw-tabular" style={{ color: 'var(--pw-text-2)', textAlign: 'right' }}>
        {formatScore(left)}
      </span>
      <Bar share={leftShare} accent={leftAccent} from="right" />
      <span style={{ ...captionStyle, fontSize: 9, textAlign: 'center' }}>{caption}</span>
      <Bar share={1 - leftShare} accent={rightAccent} from="left" />
      <span className="pw-tabular" style={{ color: 'var(--pw-text-2)' }}>
        {formatScore(right)}
      </span>
    </div>
  );
}

function Bar({
  share,
  accent,
  from,
}: {
  readonly share: number;
  readonly accent: string;
  readonly from: 'left' | 'right';
}): JSX.Element {
  return (
    <div
      style={{
        position: 'relative',
        height: 6,
        borderRadius: 2,
        background: 'var(--pw-surface-2)',
        border: '1px solid var(--pw-border-1)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          [from]: 0,
          width: `${String(Math.min(Math.max(share, 0), 1) * 100)}%`,
          background: accent,
          opacity: 0.75,
        }}
      />
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
