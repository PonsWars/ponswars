import type { ActiveTicker, ConfidenceSnapshot } from '@ponswars/shared-types';
import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { FACTION_ART, FACTION_LEGION } from '../art/manifest.js';
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
      {/* The faction's own dossier art (§39), cropped to a band rather than
          shown whole: §2.1 keeps the world dominant, and a full portrait in a
          flanking panel would be the *"giant opaque sidebar"* it rules out.
          Decorative, so it carries an empty alt — the ticker and legion name
          below say everything the image says, which is what §36.7 requires of
          anything that must survive without colour or pictures. */}
      <div
        style={{
          height: 64,
          margin: 'calc(var(--pw-space-3) * -1) calc(var(--pw-space-4) * -1) var(--pw-space-2)',
          borderRadius: 'var(--pw-radius-panel) var(--pw-radius-panel) 0 0',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <img
          src={FACTION_ART[ticker]}
          alt=""
          loading="lazy"
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'center 40%',
            opacity: 0.55,
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(to bottom, transparent, var(--pw-surface-2))',
          }}
        />
      </div>

      <div style={{ ...captionStyle, color: 'var(--pw-text-2)' }}>{ticker}</div>
      <div style={{ ...captionStyle, fontSize: 9, color: accent }}>{FACTION_LEGION[ticker]}</div>
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
    </div>
  );
}

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
