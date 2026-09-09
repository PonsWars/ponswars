import {
  ACTIVE_TICKERS,
  FACTIONS,
  UNIT_SLOTS,
  type ActiveTicker,
  type UnitSlot,
} from '@ponswars/shared-types';
import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { FactionEmblem } from '../art/FactionEmblem.js';
import { captionStyle, controlStyle, panelStyle, readoutStyle } from '../hud/styles.js';
import type { Route } from '../routing/route.js';

/**
 * The ten factions, and one of them up close (§39, §14).
 *
 * Everything here comes from the roster table in `@ponswars/shared-types`,
 * which is where §39 fixes the legion names, the five unit slots and the
 * identity line. Nothing on this page is written twice.
 *
 * The delivered faction mockups carry more than that — trait chips, a
 * playstyle, a strength and a weakness, a five-axis stat radar. Those are not
 * in the data model and are not derivable from it, and inventing a "Defensive
 * Control" playstyle or a firepower rating would be putting made-up product
 * facts on the page that describes each faction. What is real is here; the rest
 * belongs on the page after someone decides it.
 *
 * The corporate marks the mockups use are not reproduced (§7.10). Each faction
 * carries the original emblem drawn for it.
 */

/** What each unit slot is called on screen (§36.8). */
const SLOT_LABEL: Readonly<Record<UnitSlot, string>> = {
  infantry: 'INFANTRY',
  elite: 'ELITE',
  heavy: 'HEAVY',
  air: 'AIR',
  base: 'FORWARD BASE',
};

export function Factions({
  ticker,
  onNavigate,
}: {
  /** The faction being looked at, or `null` for the roster. */
  readonly ticker: ActiveTicker | null;
  readonly onNavigate: (next: Route) => void;
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 'var(--pw-space-5)' }}>
      <Roster selected={ticker} onNavigate={onNavigate} />
      {ticker === null ? <RosterPrompt /> : <FactionDetail ticker={ticker} />}
    </div>
  );
}

/** The ten, always visible, so moving between them never needs a back step. */
function Roster({
  selected,
  onNavigate,
}: {
  readonly selected: ActiveTicker | null;
  readonly onNavigate: (next: Route) => void;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 'var(--pw-space-2)', flexWrap: 'wrap' }}>
      {ACTIVE_TICKERS.map((ticker) => {
        const active = ticker === selected;
        return (
          <button
            key={ticker}
            type="button"
            onClick={() => {
              onNavigate({ kind: 'FACTIONS', ticker });
            }}
            aria-current={active ? 'page' : undefined}
            style={{
              ...controlStyle,
              display: 'grid',
              justifyItems: 'center',
              gap: 4,
              padding: 'var(--pw-space-2) var(--pw-space-3)',
              minWidth: 78,
              borderColor: active ? FACTION_ACCENT[ticker] : 'var(--pw-border-1)',
            }}
          >
            <FactionEmblem ticker={ticker} size={24} />
            <span style={{ ...captionStyle, fontSize: 9, color: 'var(--pw-text-1)' }}>
              {ticker}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RosterPrompt(): JSX.Element {
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
      <div style={{ ...readoutStyle, fontSize: 20 }}>TEN FACTIONS. ONE MARKET.</div>
      <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 13, lineHeight: 1.55 }}>
        Every round pairs them into five battles across five neutral sectors. No faction owns a
        sector, and the matchups are redrawn each round. Choose one above to read its dossier.
      </p>
    </div>
  );
}

function FactionDetail({ ticker }: { readonly ticker: ActiveTicker }): JSX.Element {
  const faction = FACTIONS[ticker];
  const accent = FACTION_ACCENT[ticker];

  return (
    <article style={{ display: 'grid', gap: 'var(--pw-space-4)' }}>
      <header
        style={{
          ...panelStyle,
          display: 'grid',
          gap: 'var(--pw-space-3)',
          borderLeft: `2px solid ${accent}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--pw-space-3)' }}>
          <FactionEmblem ticker={ticker} size={56} />
          <div>
            <div style={{ ...captionStyle, color: 'var(--pw-text-2)' }}>{ticker}</div>
            <h1 style={{ ...readoutStyle, margin: 0, fontSize: 28 }}>
              {faction.name.toUpperCase()}
            </h1>
          </div>
        </div>

        <p
          style={{
            margin: 0,
            color: 'var(--pw-text-2)',
            fontSize: 14,
            lineHeight: 1.6,
            maxWidth: 620,
          }}
        >
          {faction.identity}
        </p>
      </header>

      <section style={{ display: 'grid', gap: 'var(--pw-space-3)' }}>
        <div style={captionStyle}>ORDER OF BATTLE</div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))',
            gap: 'var(--pw-space-3)',
          }}
        >
          {UNIT_SLOTS.map((slot) => (
            <div key={slot} style={{ ...panelStyle, display: 'grid', gap: 4 }}>
              <div style={{ ...captionStyle, fontSize: 9, color: accent }}>{SLOT_LABEL[slot]}</div>
              <div style={{ ...readoutStyle, fontSize: 15 }}>{faction.units[slot]}</div>
            </div>
          ))}
        </div>
        {/* §38.5: the forward base is deployed into whichever sector the round
            assigns and retracted at reshuffle. Saying so here is what keeps a
            player from reading the roster as territory. */}
        <p style={{ ...captionStyle, margin: 0, color: 'var(--pw-text-3)', letterSpacing: 0 }}>
          The forward base is deployed into the sector this faction is assigned for the round and
          retracted when the round reshuffles. No faction holds ground between rounds.
        </p>
      </section>

      <section style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
        <div style={{ ...captionStyle, color: accent }}>ON THE PUSH</div>
        <div style={{ ...readoutStyle, fontSize: 15 }}>{faction.momentumSignature}</div>
        {/* §12 fixes the score at 45/25/20/10 for every faction. A momentum
            signature is how a push *reads*, and a page that presented it beside
            the units would invite a player to think one faction hits harder. */}
        <p style={{ margin: 0, color: 'var(--pw-text-3)', fontSize: 12, lineHeight: 1.5 }}>
          Presentation only. Every battle is scored on the same four components with the same
          weights, so no faction carries a hidden advantage into a round.
        </p>
      </section>
    </article>
  );
}
