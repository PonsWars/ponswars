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
import { FactionStandard } from '../art/FactionStandard.js';
import { UnitIcon } from '../art/UnitIcon.js';
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
      {ticker === null ? <RosterGrid onNavigate={onNavigate} /> : <FactionDetail ticker={ticker} />}
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

/**
 * All ten, before one is chosen.
 *
 * The row of buttons above is how you move between factions once you are
 * reading one; on its own it left the page as a toolbar over an empty screen,
 * which told a visitor that the roster is a menu rather than the cast. Every
 * card carries the faction's own words — the legion name and the identity line
 * §39 fixes — so the page answers *who are these ten* without anyone clicking.
 */
function RosterGrid({ onNavigate }: { readonly onNavigate: (next: Route) => void }): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 'var(--pw-space-3)' }}>
      <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
        <div style={{ ...readoutStyle, fontSize: 20 }}>TEN FACTIONS. ONE MARKET.</div>
        <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 13, lineHeight: 1.55 }}>
          Every round pairs them into five battles across five neutral sectors. No faction owns a
          sector, and the matchups are redrawn each round.
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 'var(--pw-space-3)',
        }}
      >
        {ACTIVE_TICKERS.map((ticker) => {
          const faction = FACTIONS[ticker];
          const accent = FACTION_ACCENT[ticker];
          return (
            <button
              key={ticker}
              type="button"
              onClick={() => {
                onNavigate({ kind: 'FACTIONS', ticker });
              }}
              style={{
                ...panelStyle,
                display: 'grid',
                gap: 'var(--pw-space-2)',
                alignContent: 'start',
                textAlign: 'left',
                cursor: 'pointer',
                // The one line of faction colour on the card. §36.5 keeps it an
                // accent, and ten cards each washed in their own colour is a
                // paint chart rather than a roster.
                borderLeft: `2px solid ${accent}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--pw-space-3)' }}>
                <FactionEmblem ticker={ticker} size={34} />
                <div style={{ display: 'grid', gap: 2 }}>
                  <div style={{ ...readoutStyle, fontSize: 15 }}>{ticker}</div>
                  <div style={{ ...captionStyle, fontSize: 9, color: 'var(--pw-text-2)' }}>
                    {faction.name.toUpperCase()}
                  </div>
                </div>
              </div>
              <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 12.5, lineHeight: 1.5 }}>
                {faction.identity}
              </p>
              <div style={{ ...captionStyle, fontSize: 9, color: accent }}>
                {faction.momentumSignature}
              </div>
            </button>
          );
        })}
      </div>
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
          gridTemplateColumns: 'auto 1fr',
          alignItems: 'center',
          gap: 'var(--pw-space-5)',
          borderLeft: `2px solid ${accent}`,
        }}
      >
        {/* The army's own flag, at the size a flag is read at. Every delivered
            battlefield frame hangs one of these either side of a sector; a
            dossier headed by a 56-pixel mark is a directory entry. */}
        <FactionStandard ticker={ticker} height={220} />

        <div style={{ display: 'grid', gap: 'var(--pw-space-3)', minWidth: 0 }}>
          <div>
            <div style={{ ...captionStyle, color: 'var(--pw-text-2)' }}>{ticker}</div>
            <h1 style={{ ...readoutStyle, margin: 0, fontSize: 28 }}>
              {faction.name.toUpperCase()}
            </h1>
          </div>

          <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 14, lineHeight: 1.6 }}>
            {faction.identity}
          </p>
        </div>
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
            <div
              key={slot}
              style={{
                ...panelStyle,
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                alignItems: 'center',
                gap: 'var(--pw-space-3)',
              }}
            >
              {/* The class, drawn once and tinted by whoever fields it (§36.8).
                  A dossier that names five units and shows none of them is a
                  table of strings. */}
              <UnitIcon slot={slot} color={accent} size={30} />
              <div style={{ display: 'grid', gap: 2 }}>
                <div style={{ ...captionStyle, fontSize: 9, color: accent }}>
                  {SLOT_LABEL[slot]}
                </div>
                <div style={{ ...readoutStyle, fontSize: 15 }}>{faction.units[slot]}</div>
              </div>
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
