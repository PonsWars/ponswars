import { BATTLES_PER_ROUND, FACTIONS, type ActiveTicker } from '@ponswars/shared-types';
import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { FactionEmblem } from '../art/FactionEmblem.js';
import { useSession, type ClientBattle } from '../state/session.js';
import { roundView } from './round-phase.js';
import { captionStyle, humanize, panelStyle } from './styles.js';

/**
 * The matchup, across the top of a sector or battlefield view (§42.6, §36.15).
 *
 * Both sides named with their emblem and legion, the battle's number, and one
 * line of state under them: the phase before the battle, and the momentum —
 * with the side it favours — once it is live. It is the first thing every
 * delivered battle frame puts in front of the player, and until now the
 * matchup lived only in a label hovering over the world and in two side panels.
 *
 * Nothing numeric beyond the battle's own index. No score and no percentage:
 * three mockups put `68%` here, and §12.5 keeps the score hidden for the whole
 * live battle — `ClientBattle` carries no score to show.
 */
export function MatchupBanner({ battle }: { readonly battle: ClientBattle }): JSX.Element {
  const round = useSession((state) => state.round);
  const live = round?.state === 'BATTLE_LIVE';

  const status = live
    ? momentumLine(battle)
    : {
        text: round === null ? 'SYNCING' : roundView(round.state, round.clock).label,
        colour: null,
      };

  return (
    <div
      style={{
        ...panelStyle,
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        gap: 'var(--pw-space-4)',
        padding: 'var(--pw-space-3) var(--pw-space-5)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Each side's colour as a hairline along the bottom edge, meeting in the
          middle: identity at the edge of the panel, not a fill (§36.5). */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 2,
          background: `linear-gradient(to right, ${FACTION_ACCENT[battle.left]} 0%, transparent 46%, transparent 54%, ${FACTION_ACCENT[battle.right]} 100%)`,
          opacity: 0.8,
        }}
      />

      <Side ticker={battle.left} align="left" />

      <div style={{ display: 'grid', justifyItems: 'center', gap: 4 }}>
        <div style={{ ...captionStyle, fontSize: 9 }}>
          BATTLE {String(battle.sectorIndex + 1).padStart(2, '0')} /{' '}
          {String(BATTLES_PER_ROUND).padStart(2, '0')}
        </div>
        <div
          style={{
            fontFamily: 'var(--pw-font-display)',
            fontSize: 15,
            letterSpacing: '0.2em',
            color: 'var(--pw-text-3)',
          }}
        >
          VS
        </div>
        <div
          style={{
            ...captionStyle,
            fontSize: 10,
            padding: '3px 10px',
            borderRadius: 999,
            border: `1px solid ${status.colour ?? 'var(--pw-border-1)'}`,
            color: status.colour ?? 'var(--pw-text-2)',
            whiteSpace: 'nowrap',
          }}
        >
          {status.text}
        </div>
      </div>

      <Side ticker={battle.right} align="right" />
    </div>
  );
}

function Side({
  ticker,
  align,
}: {
  readonly ticker: ActiveTicker;
  readonly align: 'left' | 'right';
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--pw-space-3)',
        flexDirection: align === 'right' ? 'row-reverse' : 'row',
        textAlign: align,
        minWidth: 0,
      }}
    >
      <FactionEmblem ticker={ticker} size={34} />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--pw-font-display)',
            fontSize: 22,
            letterSpacing: '0.04em',
            lineHeight: 1.1,
            color: FACTION_ACCENT[ticker],
          }}
        >
          {ticker}
        </div>
        <div style={{ ...captionStyle, fontSize: 9, whiteSpace: 'nowrap' }}>
          {FACTIONS[ticker].name.toUpperCase()}
        </div>
      </div>
    </div>
  );
}

/**
 * The live state in words: the momentum, and which side it belongs to.
 *
 * `CONTESTED` belongs to nobody. Every other state is carried by the side the
 * frontline favours — the same authoritative number the world draws — so the
 * line can never name a side the battlefield does not show winning.
 */
function momentumLine(battle: ClientBattle): {
  readonly text: string;
  readonly colour: string | null;
} {
  if (battle.momentum === 'CONTESTED' || battle.frontline === 0.5) {
    return { text: 'CONTESTED', colour: null };
  }
  const leader = battle.frontline > 0.5 ? battle.left : battle.right;
  return { text: `${leader} ${humanize(battle.momentum)}`, colour: FACTION_ACCENT[leader] };
}
