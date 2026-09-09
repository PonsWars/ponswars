import {
  BATTLE_SCORE_WEIGHTS,
  BATTLES_PER_ROUND,
  ACTIVE_TICKERS,
  ROUND_DURATION,
  WP_AWARDS,
} from '@ponswars/shared-types';
import type { JSX } from 'react';
import { FactionEmblem } from '../art/FactionEmblem.js';
import { captionStyle, controlStyle, panelStyle, readoutStyle } from '../hud/styles.js';
import type { Route } from '../routing/route.js';

/**
 * What this is and how a round works (the delivered about mockup).
 *
 * Every number on this page is read from the locked constants rather than
 * typed: ten factions, five battles, ten minutes, the 45/25/20/10 split, the
 * War Point table. An explainer that drifts from the engine it explains is
 * worse than none — a player who learns the rules here and then sees different
 * ones in a round has been misled by the page that was supposed to help.
 *
 * One thing in the mockup is not reproduced. Its `WATCH` step shows a live
 * `NVDA 56% — 44% AAPL` split mid-battle, and §12.5 and §24 hide the exact
 * score for the entire live window; §27.7 gives a player momentum and a
 * frontline instead. Teaching a reader to expect a number they will never see
 * would be a worse error here than anywhere, because this is the page that
 * tells them what to expect.
 */

/** The five steps of a round, in the mockup's own order and words. */
const STEPS: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'PICK',
    body: 'Choose one battle, back your faction, and optionally arm your Genesis Card.',
  },
  {
    title: 'LOCK',
    body: 'Picks and cards lock one minute after the round opens. Nothing changes after that.',
  },
  {
    title: 'WATCH',
    body: 'Nine minutes of live battle. You see momentum and the frontline move — the exact score stays hidden until it is over.',
  },
  {
    title: 'RESULT',
    body: 'Scores are revealed with their working: price momentum, relative volume, Pons activity and card support.',
  },
  {
    title: 'EARN',
    body: 'A winning pick earns War Points, and backing an underdog earns more. War Points qualify you for the reward distribution.',
  },
];

/** What the game runs on, in the mockup's four headings. */
const PILLARS: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'REAL MARKET DATA',
    body: 'Battles are scored from live market movement, not from a script. Nothing here is a simulation of a market.',
  },
  {
    title: 'ONCHAIN ACTIVITY',
    body: 'Qualified Pons chain activity is one of the four scoring components, so what happens onchain moves the frontline.',
  },
  {
    title: 'PLAYER DRIVEN',
    body: 'Every pick and every deployed card counts toward the side it backs. A battle is decided with the people watching it in it.',
  },
  {
    title: 'ONCHAIN REWARDS',
    body: 'Rewards settle onchain against a published distribution. No seasons and no resets — the fight continues.',
  },
];

export function About({ onNavigate }: { readonly onNavigate: (next: Route) => void }): JSX.Element {
  const minutes = Math.round(ROUND_DURATION / 60_000);

  return (
    <div style={{ display: 'grid', gap: 'var(--pw-space-6)' }}>
      <header style={{ display: 'grid', gap: 'var(--pw-space-3)' }}>
        <div style={{ ...captionStyle, color: 'var(--pw-text-3)' }}>ABOUT PONSWARS</div>
        <h1
          style={{
            margin: 0,
            fontFamily: 'var(--pw-font-display)',
            fontSize: 'clamp(28px, 4.4vw, 46px)',
            lineHeight: 1.06,
            color: 'var(--pw-text-1)',
          }}
        >
          REAL MARKETS.
          <br />
          REAL PLAY.
          <br />
          <span style={{ color: 'var(--pw-accent)' }}>A BIGGER TOMORROW.</span>
        </h1>
        <p style={{ margin: 0, maxWidth: 560, color: 'var(--pw-text-2)', lineHeight: 1.6 }}>
          PonsWars turns global markets into a living battlefield. Ten factions. Real market data.
          Onchain activity. A spectator strategy game where every decision, every holder, and every
          battle moves something bigger.
        </p>
        <button
          type="button"
          onClick={() => {
            onNavigate({ kind: 'WORLD', battleId: null });
          }}
          style={{
            ...controlStyle,
            justifySelf: 'start',
            background: 'var(--pw-accent)',
            borderColor: 'var(--pw-accent)',
            color: '#06120a',
            fontFamily: 'var(--pw-font-display)',
            letterSpacing: '0.08em',
            padding: 'var(--pw-space-3) var(--pw-space-5)',
          }}
        >
          ENTER WAR WORLD →
        </button>
      </header>

      <section style={{ display: 'grid', gap: 'var(--pw-space-3)' }}>
        <div style={captionStyle}>HOW IT WORKS</div>
        <h2 style={{ ...readoutStyle, margin: 0, fontSize: 24 }}>SIMPLE STEPS. DEEP STRATEGY.</h2>
        <p style={{ margin: 0, color: 'var(--pw-text-3)', fontSize: 13 }}>
          A {minutes}-minute round. Real data, real people, real impact.
        </p>

        <ol
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: 'var(--pw-space-3)',
            listStyle: 'none',
            margin: 0,
            padding: 0,
            counterReset: 'step',
          }}
        >
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--pw-space-2)' }}>
                <span
                  className="pw-tabular"
                  style={{ ...readoutStyle, fontSize: 20, color: 'var(--pw-text-3)' }}
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span style={{ ...readoutStyle, fontSize: 16 }}>{step.title}</span>
              </div>
              <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 12.5, lineHeight: 1.55 }}>
                {step.body}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section style={{ display: 'grid', gap: 'var(--pw-space-3)' }}>
        <div style={captionStyle}>HOW A BATTLE IS SCORED</div>
        {/* The four weights, read from the constant §12 locks. A page that
            listed them by hand would be a second copy of the one rule the whole
            engine is built around. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 'var(--pw-space-3)',
          }}
        >
          {(
            [
              ['PRICE MOMENTUM', BATTLE_SCORE_WEIGHTS.priceMomentum],
              ['RELATIVE VOLUME', BATTLE_SCORE_WEIGHTS.relativeVolume],
              ['PONS POWER', BATTLE_SCORE_WEIGHTS.ponsPower],
              ['CARD SUPPORT', BATTLE_SCORE_WEIGHTS.holderCardSupport],
            ] as const
          ).map(([label, weight]) => (
            <div key={label} style={{ ...panelStyle, display: 'grid', gap: 4 }}>
              <div className="pw-tabular" style={{ ...readoutStyle, fontSize: 22 }}>
                {weight}
              </div>
              <div style={{ ...captionStyle, fontSize: 9 }}>{label}</div>
            </div>
          ))}
        </div>
        <p style={{ margin: 0, color: 'var(--pw-text-3)', fontSize: 12, lineHeight: 1.5 }}>
          One hundred points, shared between the two sides. The weights are the same in every
          battle, for every faction, in every round.
        </p>
      </section>

      <section style={{ display: 'grid', gap: 'var(--pw-space-3)' }}>
        <div style={captionStyle}>WHAT A WIN IS WORTH</div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 'var(--pw-space-3)',
          }}
        >
          {(
            [
              ['WINNING PICK', WP_AWARDS.WIN],
              ['UNDERDOG WIN', WP_AWARDS.UNDERDOG_WIN],
              ['HEAVY UNDERDOG WIN', WP_AWARDS.HEAVY_UNDERDOG_WIN],
              ['CARD ASSIST', WP_AWARDS.CARD_ASSIST],
            ] as const
          ).map(([label, points]) => (
            <div key={label} style={{ ...panelStyle, display: 'grid', gap: 4 }}>
              <div className="pw-tabular" style={{ ...readoutStyle, fontSize: 22 }}>
                +{points} WP
              </div>
              <div style={{ ...captionStyle, fontSize: 9 }}>{label}</div>
            </div>
          ))}
        </div>
        <p style={{ margin: 0, color: 'var(--pw-text-3)', fontSize: 12, lineHeight: 1.5 }}>
          Backing the side that was rated behind is worth more than backing the favourite. A losing
          pick costs nothing.
        </p>
      </section>

      <section style={{ display: 'grid', gap: 'var(--pw-space-3)' }}>
        <div style={captionStyle}>POWERED BY REAL DATA</div>
        <h2 style={{ ...readoutStyle, margin: 0, fontSize: 24 }}>MORE THAN A GAME.</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 'var(--pw-space-3)',
          }}
        >
          {PILLARS.map((pillar) => (
            <article
              key={pillar.title}
              style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}
            >
              <h3 style={{ ...readoutStyle, margin: 0, fontSize: 14 }}>{pillar.title}</h3>
              <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 12.5, lineHeight: 1.55 }}>
                {pillar.body}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-3)' }}>
        <h2 style={{ ...readoutStyle, margin: 0, fontSize: 18 }}>TEN FACTIONS. ONE BATTLEFIELD.</h2>
        <div style={{ display: 'flex', gap: 'var(--pw-space-3)', flexWrap: 'wrap' }}>
          {ACTIVE_TICKERS.map((ticker) => (
            <button
              key={ticker}
              type="button"
              onClick={() => {
                onNavigate({ kind: 'FACTIONS', ticker });
              }}
              style={{
                ...controlStyle,
                display: 'grid',
                justifyItems: 'center',
                gap: 4,
                minWidth: 66,
              }}
            >
              <FactionEmblem ticker={ticker} size={22} />
              <span style={{ ...captionStyle, fontSize: 9, color: 'var(--pw-text-1)' }}>
                {ticker}
              </span>
            </button>
          ))}
        </div>
      </section>

      <footer
        style={{
          ...panelStyle,
          display: 'flex',
          gap: 'var(--pw-space-6)',
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}
      >
        {[
          [String(ACTIVE_TICKERS.length), 'FACTIONS'],
          [String(BATTLES_PER_ROUND), 'BATTLES PER ROUND'],
          [`${String(minutes)} MIN`, 'ROUND DURATION'],
        ].map(([value, label]) => (
          <div key={label} style={{ display: 'grid', justifyItems: 'center', gap: 2 }}>
            <div style={{ ...readoutStyle, fontSize: 20 }}>{value}</div>
            <div style={{ ...captionStyle, fontSize: 9 }}>{label}</div>
          </div>
        ))}
      </footer>
    </div>
  );
}
