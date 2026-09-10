import { FACTIONS, type ActiveTicker, type ConfidenceSnapshot } from '@ponswars/shared-types';
import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { FactionEmblem } from '../art/FactionEmblem.js';
import { UnitIcon } from '../art/UnitIcon.js';
import { captionStyle, humanize, panelStyle } from './styles.js';

/**
 * One side's pre-battle intel (§42.4).
 *
 * *"Use lightweight tactical glass panels that flank the world ... Do not cover
 * the battlefield with a large modal."* So this is a narrow column, and the
 * sector stays in the middle of the screen where the player is looking.
 *
 * Everything shown is qualitative. §10.2 gives the client a label and four
 * sub-signals and no percentage, and §27.5 is what the panel renders verbatim —
 * there is no number here to turn into a probability, because deriving one is
 * exactly what the qualitative vocabulary exists to prevent.
 */
export function BattleIntel({
  ticker,
  intel,
  align,
}: {
  readonly ticker: ActiveTicker;
  readonly intel: ConfidenceSnapshot;
  readonly align: 'left' | 'right';
}): JSX.Element {
  const accent = FACTION_ACCENT[ticker];

  return (
    <div
      style={{
        ...panelStyle,
        minWidth: 176,
        overflow: 'hidden',
        textAlign: align,
        // A hairline of faction colour, not a fill. Design tokens §3 keeps
        // faction accents to identity cues and local highlights, and §36.7
        // requires the faction to stay identifiable without colour at all —
        // which is why the ticker is written out beside it.
        [align === 'left' ? 'borderLeft' : 'borderRight']: `2px solid ${accent}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--pw-space-2)',
          flexDirection: align === 'right' ? 'row-reverse' : 'row',
        }}
      >
        <FactionEmblem ticker={ticker} size={28} />
        <div>
          <div style={{ ...captionStyle, color: 'var(--pw-text-2)' }}>{ticker}</div>
          {/* The legion name, from the roster §39 locks rather than from a
              second list beside it. §36.7 needs a faction identifiable without
              colour, and a name does what an accent cannot. */}
          <div style={{ ...captionStyle, fontSize: 9, color: accent }}>
            {FACTIONS[ticker].name.toUpperCase()}
          </div>
        </div>
      </div>
      <div
        style={{
          fontFamily: 'var(--pw-font-display)',
          fontSize: 15,
          color: 'var(--pw-text-1)',
          marginBottom: 'var(--pw-space-2)',
        }}
      >
        {humanize(intel.label)}
      </div>

      <Signal caption="PRICE TREND" value={intel.priceTrend} align={align} />
      <Signal caption="VOLUME" value={intel.volumePulse} align={align} />
      <Signal caption="PONS ACTIVITY" value={intel.ponsActivity} align={align} />
      <Signal caption="STABILITY" value={intel.momentumStability} align={align} />

      {/* Who is actually standing on that half of the island (§39, §36.8).
          The delivered sector screen carries an army preview beside the intel,
          and it is the part that makes a side a faction rather than a colour —
          the names come from the roster §39 locks, so this panel and the
          faction dossier cannot describe different armies.

          Deliberately not the momentum signature: §12 scores every battle on
          the same four weights, and a signature listed beside a unit roster
          reads as a stat line. It belongs on the dossier that explains it. */}
      <div
        style={{
          marginTop: 'var(--pw-space-2)',
          paddingTop: 'var(--pw-space-2)',
          borderTop: '1px solid var(--pw-border-1)',
        }}
      >
        <div style={{ ...captionStyle, fontSize: 9, marginBottom: 2 }}>ORDER OF BATTLE</div>
        {PREVIEW_SLOTS.map(([slot, caption]) => (
          <div
            key={slot}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--pw-space-2)',
              flexDirection: align === 'right' ? 'row-reverse' : 'row',
            }}
          >
            <UnitIcon slot={slot} color={accent} size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <Signal caption={caption} value={FACTIONS[ticker].units[slot]} align={align} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The three slots the preview shows.
 *
 * Not all five. §42.1 would rather show less UI than more, these panels flank a
 * world that has to stay the thing being looked at, and the forward base is
 * already standing in the sector below — naming it in a list beside the world
 * that is drawing it is the second copy §65.1 warns about.
 */
const PREVIEW_SLOTS: readonly (readonly ['infantry' | 'elite' | 'heavy', string])[] = [
  ['infantry', 'INFANTRY'],
  ['elite', 'ELITE'],
  ['heavy', 'HEAVY'],
];

function Signal({
  caption,
  value,
  align,
}: {
  readonly caption: string;
  readonly value: string;
  readonly align: 'left' | 'right';
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        flexDirection: align === 'left' ? 'row' : 'row-reverse',
        gap: 'var(--pw-space-3)',
        fontSize: 11,
        lineHeight: 1.7,
      }}
    >
      <span style={{ color: 'var(--pw-text-3)' }}>{caption}</span>
      <span style={{ color: 'var(--pw-text-2)' }}>{humanize(value)}</span>
    </div>
  );
}
