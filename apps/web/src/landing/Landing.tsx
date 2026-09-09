import { ACTIVE_TICKERS, BATTLES_PER_ROUND, ROUND_DURATION } from '@ponswars/shared-types';
import { LAYER } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { FactionEmblem } from '../art/FactionEmblem.js';
import { CARD_ART } from '../art/manifest.js';
import { NavBar } from '../hud/NavBar.js';
import { formatCountdown, roundView } from '../hud/round-phase.js';
import { captionStyle, controlStyle, panelStyle, readoutStyle } from '../hud/styles.js';
import type { Route } from '../routing/route.js';
import { useSession, type ClientBattle } from '../state/session.js';

/**
 * The way in (§37.1, and the delivered landing mockup).
 *
 * A visitor who has never seen this needs to be told what it is before being
 * dropped into a war. The world is still the product — it is rendering behind
 * this the whole time and is never unmounted (§37.9), so entering is the
 * overlay lifting rather than a page load.
 *
 * Everything here is either locked or live. The round strip is the actual five
 * battles with their actual confidence labels and the actual countdown, because
 * a landing page showing an invented round would be the first thing a visitor
 * saw and the first thing that was untrue.
 *
 * Two things in the mockup are deliberately absent. `10,428 online` and
 * `100K+ TRADERS` are placeholders by §7.9 and nothing publishes a real figure,
 * so there is no honest version of them to render. And the faction banners in
 * the hero art carry corporate marks §7.10 rules out; the ten emblems here are
 * the original ones.
 */
export function Landing({
  onNavigate,
}: {
  readonly onNavigate: (next: Route) => void;
}): JSX.Element {
  const battles = useSession((state) => state.battles);
  const round = useSession((state) => state.round);
  const clockOffsetMs = useSession((state) => state.clockOffsetMs);

  const enter = (): void => {
    onNavigate({ kind: 'WORLD', battleId: null });
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: LAYER.hud + 1,
        overflowY: 'auto',
        // The world shows through. §2.1 keeps it the hero even here — the
        // gradient darkens enough to read against without hiding it.
        background:
          'linear-gradient(to bottom, rgba(5,8,11,0.94) 0%, rgba(5,8,11,0.82) 45%, rgba(5,8,11,0.96) 100%)',
      }}
    >
      <div
        style={{
          maxWidth: 1180,
          margin: '0 auto',
          padding: 'var(--pw-space-6) var(--pw-space-5)',
          display: 'grid',
          gap: 'var(--pw-space-6)',
        }}
      >
        <NavBar current={{ kind: 'LANDING' }} onNavigate={onNavigate} />
        <Hero onEnter={enter} onNavigate={onNavigate} />
        <RoundStrip battles={battles} round={round} clockOffsetMs={clockOffsetMs} />
        <Pillars onNavigate={onNavigate} />
        <Facts />
      </div>
    </div>
  );
}

function Hero({
  onEnter,
  onNavigate,
}: {
  readonly onEnter: () => void;
  readonly onNavigate: (next: Route) => void;
}): JSX.Element {
  return (
    <header style={{ display: 'grid', gap: 'var(--pw-space-4)', paddingTop: 'var(--pw-space-5)' }}>
      <div style={{ ...captionStyle, color: 'var(--pw-text-3)' }}>
        SAME MARKETS. A MORE INTERESTING UNIVERSE.
      </div>

      <h1
        style={{
          margin: 0,
          fontFamily: 'var(--pw-font-display)',
          fontSize: 'clamp(34px, 6vw, 66px)',
          lineHeight: 1.04,
          letterSpacing: '-0.01em',
          color: 'var(--pw-text-1)',
        }}
      >
        REAL MARKETS.
        <br />
        <span style={{ color: 'var(--pw-accent)' }}>HIGHER STAKES.</span>
      </h1>

      <p style={{ margin: 0, maxWidth: 460, color: 'var(--pw-text-2)', lineHeight: 1.55 }}>
        PonsWars turns global markets into a living battlefield. Back your conviction, deploy your
        strategy, and be part of something bigger.
      </p>

      <div style={{ display: 'flex', gap: 'var(--pw-space-3)', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={onEnter}
          style={{
            ...controlStyle,
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
        <button
          type="button"
          onClick={() => {
            onNavigate({ kind: 'ABOUT' });
          }}
          style={{
            ...controlStyle,
            fontFamily: 'var(--pw-font-display)',
            letterSpacing: '0.08em',
            padding: 'var(--pw-space-3) var(--pw-space-5)',
          }}
        >
          HOW IT WORKS
        </button>
      </div>

      {/* The ten factions, as their emblems. The mockup floats these over the
          hero art as banners; without that art they earn their own row, which
          also makes the roster the first concrete thing a visitor sees. */}
      <div
        style={{
          display: 'flex',
          gap: 'var(--pw-space-3)',
          flexWrap: 'wrap',
          marginTop: 'var(--pw-space-3)',
        }}
      >
        {ACTIVE_TICKERS.map((ticker) => (
          <div key={ticker} style={{ display: 'grid', justifyItems: 'center', gap: 4 }}>
            <FactionEmblem ticker={ticker} size={26} />
            <span style={{ ...captionStyle, fontSize: 9 }}>{ticker}</span>
          </div>
        ))}
      </div>
    </header>
  );
}

/**
 * The round as it stands right now.
 *
 * §12.5 hides the live score, so this shows what a spectator may see: who is
 * fighting, how they were rated before the bell, and how long is left. `null`
 * before a round arrives, rather than a row of dashes pretending to be one.
 */
function RoundStrip({
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
          gridTemplateColumns: `repeat(auto-fit, minmax(190px, 1fr))`,
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

/** The three things the mockup puts below the fold, in its own words. */
function Pillars({ onNavigate }: { readonly onNavigate: (next: Route) => void }): JSX.Element {
  const card = CARD_ART.GOLDEN_ARMY;

  return (
    <section
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 'var(--pw-space-4)',
      }}
    >
      <article style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
        <h2 style={{ ...readoutStyle, margin: 0, fontSize: 18 }}>
          TEN FACTIONS. INFINITE STORIES.
        </h2>
        <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 13, lineHeight: 1.5 }}>
          From AI to retail. From legacy to disruption. Every faction has a vision — which one are
          you with?
        </p>
      </article>

      <article style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
        {card === undefined ? null : (
          <img
            src={card}
            alt=""
            width={120}
            style={{ width: 120, height: 'auto', justifySelf: 'center' }}
          />
        )}
        <h2 style={{ ...readoutStyle, margin: 0, fontSize: 18 }}>MORE THAN JUST A CARD.</h2>
        <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 13, lineHeight: 1.5 }}>
          Genesis Cards give you real impact on the battlefield. Rare. Powerful. Yours to command.
        </p>
        <button
          type="button"
          onClick={() => {
            onNavigate({ kind: 'GENESIS' });
          }}
          style={{ ...controlStyle, fontSize: 11, justifySelf: 'start' }}
        >
          VIEW CARD SYSTEM →
        </button>
      </article>

      <article style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
        <h2 style={{ ...readoutStyle, margin: 0, fontSize: 18 }}>REAL MARKETS. REAL IMPACT.</h2>
        <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 13, lineHeight: 1.5 }}>
          Powered by live market data, onchain activity, and a global community. This is more than a
          game — it is a new frontier for market play.
        </p>
        <button
          type="button"
          onClick={() => {
            onNavigate({ kind: 'ABOUT' });
          }}
          style={{ ...controlStyle, fontSize: 11, justifySelf: 'start' }}
        >
          LEARN MORE →
        </button>
      </article>
    </section>
  );
}

/**
 * The numbers, and only the ones that are locked.
 *
 * Ten factions (§4.1), five battles a round (§4.3), ten minutes (§3.1). The
 * mockup's fourth figure is a trader count, which §7.9 marks as a placeholder
 * and nothing publishes — so this row is three facts rather than four, one of
 * them invented.
 */
function Facts(): JSX.Element {
  const minutes = Math.round(ROUND_DURATION / 60_000);

  return (
    <footer
      style={{
        ...panelStyle,
        display: 'flex',
        gap: 'var(--pw-space-6)',
        flexWrap: 'wrap',
        justifyContent: 'center',
        marginBottom: 'var(--pw-space-5)',
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
  );
}
