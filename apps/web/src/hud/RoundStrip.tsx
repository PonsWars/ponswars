import type { JSX } from 'react';
import { FactionEmblem } from '../art/FactionEmblem.js';
import { formatCountdown, roundView } from './round-phase.js';
import { captionStyle, panelStyle, readoutStyle } from './styles.js';
import { useSession, type ClientBattle } from '../state/session.js';

/**
 * The round as it stands, as a strip of the five battles (§3.1, §5).
 *
 * Written for the landing page and used by the war room as well: a page that
 * cannot show a visitor their own record can still show them the war they
 * could be in, which is better than the empty half-screen it had.
 *
 * Nothing here is anyone's own — the matchups and their pre-battle labels are
 * public (§5) — so it says the same thing to a connected wallet and to nobody.
 */

export function RoundStrip({
  battles,
  round,
  clockOffsetMs,
}: {
  readonly battles: readonly ClientBattle[];
  readonly round: ReturnType<typeof useSession.getState>['round'];
  readonly clockOffsetMs: number;
}): JSX.Element | null {
  if (round === null || battles.length === 0) {
    return null;
  }

  const view = roundView(round.state, round.clock);
  const remaining =
    view.countdownTarget === null ? null : view.countdownTarget - (Date.now() + clockOffsetMs);

  return (
    <section style={{ display: 'grid', gap: 'var(--pw-space-3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={captionStyle}>{view.label}</div>
        {remaining === null ? null : (
          <div className="pw-tabular" style={{ ...captionStyle, color: 'var(--pw-text-2)' }}>
            {view.countdownCaption} {formatCountdown(Math.max(0, remaining))}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          // 170 rather than 190: the war room's overlay is narrower than the
          // landing page's column, and at 190 the fifth battle wrapped onto a
          // row of its own — five battles read as a round, four and one do not.
          gridTemplateColumns: `repeat(auto-fit, minmax(170px, 1fr))`,
          gap: 'var(--pw-space-3)',
        }}
      >
        {battles.map((battle, index) => (
          <div
            key={battle.battleId}
            style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}
          >
            <div style={{ ...captionStyle, fontSize: 9 }}>BATTLE {index + 1}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--pw-space-2)' }}>
              <FactionEmblem ticker={battle.left} size={18} />
              <span style={{ ...readoutStyle, fontSize: 13 }}>{battle.left}</span>
              <span style={{ ...captionStyle, fontSize: 10 }}>vs</span>
              <span style={{ ...readoutStyle, fontSize: 13 }}>{battle.right}</span>
              <FactionEmblem ticker={battle.right} size={18} />
            </div>
            <div style={{ ...captionStyle, fontSize: 9, color: 'var(--pw-text-3)' }}>
              {battle.leftIntel.label.replaceAll('_', ' ')} ·{' '}
              {battle.rightIntel.label.replaceAll('_', ' ')}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The same strip, reading the round from the session itself.
 *
 * For surfaces that have no reason to carry the round through their props —
 * the war room is about one wallet, and the round is about everybody.
 */
export function LiveRoundStrip(): JSX.Element | null {
  const battles = useSession((state) => state.battles);
  const round = useSession((state) => state.round);
  const clockOffsetMs = useSession((state) => state.clockOffsetMs);

  return <RoundStrip battles={battles} round={round} clockOffsetMs={clockOffsetMs} />;
}
