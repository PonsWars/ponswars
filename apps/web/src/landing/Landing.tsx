import { ACTIVE_TICKERS, BATTLES_PER_ROUND, ROUND_DURATION } from '@ponswars/shared-types';
import { LAYER } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { FactionEmblem } from '../art/FactionEmblem.js';
import { FactionStandard } from '../art/FactionStandard.js';
import { GenesisCardFace } from '../art/GenesisCardFace.js';
import { WorldRing } from '../art/WorldRing.js';
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
      }}
    >
      {/*
        The hero darkens from the left, not from the top.

        The right half of the delivered mockup is the world, and the world is
        already rendering behind this — §37.9 never unmounts it. A veil at 0.94
        across the whole width covered it with a flat black rectangle and then
        described it in words. Fading the veil out toward the right turns the
        same overlay into the mockup's layout: copy on the left, the actual
        place on the right, and entering it is the overlay lifting rather than
        a page load (§2.1).
      */}
      <div
        style={{
          background:
            'linear-gradient(100deg, rgba(5,8,11,0.97) 0%, rgba(5,8,11,0.94) 34%, rgba(5,8,11,0.62) 56%, rgba(5,8,11,0.12) 78%, rgba(5,8,11,0.04) 100%)',
        }}
      >
        <div
          style={{
            maxWidth: 1180,
            margin: '0 auto',
            padding: 'var(--pw-space-6) var(--pw-space-5) var(--pw-space-7)',
            display: 'grid',
            gap: 'var(--pw-space-6)',
          }}
        >
          <NavBar current={{ kind: 'LANDING' }} onNavigate={onNavigate} />
          <Hero onEnter={enter} onNavigate={onNavigate} />
        </div>
      </div>

      {/* Below the fold the veil closes again: this is reading, and reading
          over a moving world is the one thing §2.1 does not ask for. */}
      <div
        style={{
          background:
            'linear-gradient(to bottom, rgba(5,8,11,0.86) 0%, rgba(5,8,11,0.97) 12%, rgba(5,8,11,0.99) 100%)',
        }}
      >
        <div
          style={{
            maxWidth: 1180,
            margin: '0 auto',
            padding: 'var(--pw-space-5)',
            display: 'grid',
            gap: 'var(--pw-space-6)',
          }}
        >
          <RoundStrip battles={battles} round={round} clockOffsetMs={clockOffsetMs} />
          <Pillars onNavigate={onNavigate} />
          <Facts />
        </div>
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
    <header
      style={{
        display: 'grid',
        gap: 'var(--pw-space-4)',
        paddingTop: 'var(--pw-space-5)',
        // Tall enough that the world has room to be seen beside the copy.
        minHeight: '56vh',
        alignContent: 'start',
      }}
    >
      {/* Held to a column on the left. Copy running the full width would put
          text over the part of the frame the world occupies, which is the half
          of the mockup that is not words. */}
      <div style={{ maxWidth: 560, display: 'grid', gap: 'var(--pw-space-4)' }}>
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

        {/* What the game is, in four lines. The mockup carries these under the
          buttons, and each one is a claim the engine can stand behind: the
          fourth says onchain rewards rather than the mockup's trading figure,
          which §7.9 marks as a placeholder. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(124px, 1fr))',
            gap: 'var(--pw-space-3)',
            marginTop: 'var(--pw-space-2)',
          }}
        >
          {HERO_POINTS.map((point) => (
            <div key={point.title} style={{ display: 'grid', gap: 4, alignContent: 'start' }}>
              <HeroIcon device={point.device} />
              <div style={{ ...readoutStyle, fontSize: 11 }}>{point.title}</div>
              <div style={{ ...captionStyle, fontSize: 9, color: 'var(--pw-text-3)' }}>
                {point.body}
              </div>
            </div>
          ))}
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
      </div>

      {/* Sitting over the world itself, at the far side of the frame — the one
          piece of the hero that belongs to the picture rather than to the copy,
          and a second way in for a visitor who has already read enough. */}
      <button
        type="button"
        onClick={onEnter}
        style={{
          ...panelStyle,
          justifySelf: 'end',
          marginTop: 'var(--pw-space-5)',
          display: 'grid',
          gap: 2,
          textAlign: 'left',
          cursor: 'pointer',
          pointerEvents: 'auto',
        }}
      >
        <span style={{ ...readoutStyle, fontSize: 13 }}>GLOBAL BATTLEFIELD →</span>
        <span style={{ ...captionStyle, fontSize: 9 }}>
          {ACTIVE_TICKERS.length} FACTIONS. ONE MARKET.
        </span>
      </button>
    </header>
  );
}

/** The four claims under the hero buttons, in the mockup's own order. */
const HERO_POINTS: readonly {
  readonly title: string;
  readonly body: string;
  readonly device: string;
}[] = [
  {
    title: 'REAL MARKET DATA',
    body: 'Live. Onchain. Transparent.',
    // A rising trace: the one thing every battle is scored from.
    device: 'M10 40 L20 30 L26 34 L38 16 M32 16 L38 16 L38 22',
  },
  {
    title: 'SPECTATOR STRATEGY',
    body: 'Pick. Support. Watch.',
    device: 'M24 14 A14 14 0 0 1 24 42 A14 14 0 0 1 24 14 M24 22 A6 6 0 0 1 24 34 A6 6 0 0 1 24 22',
  },
  {
    title: 'GENESIS CARDS',
    body: 'Rare. Powerful. Yours.',
    device: 'M14 12 L30 12 L34 16 L34 40 L18 40 L14 36 Z M20 18 L28 18 M20 24 L28 24',
  },
  {
    title: 'ONCHAIN REWARDS',
    body: 'Settled, not promised.',
    device:
      'M24 10 L36 17 L36 31 L24 38 L12 31 L12 17 Z M24 20 L30 23.5 L30 30 L24 33 L18 30 L18 23.5 Z',
  },
];

/**
 * One hero icon.
 *
 * Line work in the same idiom as the faction emblems and the house mark — one
 * stroke weight, one colour, drawn on the same 48-unit field — so the row reads
 * as part of this identity rather than as a borrowed icon set.
 */
function HeroIcon({ device }: { readonly device: string }): JSX.Element {
  return (
    <svg width={22} height={22} viewBox="0 0 48 48" aria-hidden focusable="false">
      <path
        d={device}
        fill="none"
        stroke="var(--pw-accent)"
        strokeWidth={2.4}
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
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
  return (
    <section
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 'var(--pw-space-4)',
      }}
    >
      <article
        style={{
          ...panelStyle,
          display: 'grid',
          gap: 'var(--pw-space-2)',
          // Otherwise the shortest card spreads its two lines over the height
          // of the tallest one, and the row reads as three broken cards.
          alignContent: 'start',
        }}
      >
        {/* The ten, as their standards. The panel claims ten factions; showing
            four of them and a paragraph is the claim without the evidence. */}
        <div
          style={{
            display: 'flex',
            gap: 'var(--pw-space-2)',
            flexWrap: 'wrap',
            justifyContent: 'center',
          }}
        >
          {ACTIVE_TICKERS.map((ticker) => (
            <FactionStandard key={ticker} ticker={ticker} height={86} />
          ))}
        </div>
        <h2 style={{ ...readoutStyle, margin: 0, fontSize: 18 }}>
          TEN FACTIONS. INFINITE STORIES.
        </h2>
        <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 13, lineHeight: 1.5 }}>
          From AI to retail. From legacy to disruption. Every faction has a vision — which one are
          you with?
        </p>
        <button
          type="button"
          onClick={() => {
            onNavigate({ kind: 'FACTIONS', ticker: null });
          }}
          style={{ ...controlStyle, fontSize: 11, justifySelf: 'start' }}
        >
          EXPLORE FACTIONS →
        </button>
      </article>

      <article
        style={{
          ...panelStyle,
          display: 'grid',
          gap: 'var(--pw-space-2)',
          // Otherwise the shortest card spreads its two lines over the height
          // of the tallest one, and the row reads as three broken cards.
          alignContent: 'start',
        }}
      >
        {/* An actual card, drawn by the component the reveal uses. It used to
            be the raw art file, which is the illustration cut out of the master
            — a picture of a battle, where the point of the panel is the object
            you are given. */}
        <div style={{ justifySelf: 'center' }}>
          <GenesisCardFace cardType="GOLDEN_ARMY" rarity="LEGENDARY" width={132} />
        </div>
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

      <article
        style={{
          ...panelStyle,
          display: 'grid',
          gap: 'var(--pw-space-2)',
          // Otherwise the shortest card spreads its two lines over the height
          // of the tallest one, and the row reads as three broken cards.
          alignContent: 'start',
        }}
      >
        {/* The shape of the place, drawn from the same constants the world is
            built from (§38.2, §38.3). */}
        <div style={{ justifySelf: 'center' }}>
          <WorldRing size={150} />
        </div>
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
