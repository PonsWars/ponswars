import { isActiveTicker, type CardType, type Rarity } from '@ponswars/shared-types';
import { FACTION_ACCENT, RARITY_COLOR } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { FactionEmblem } from '../art/FactionEmblem.js';
import { GenesisCardFace } from '../art/GenesisCardFace.js';
import { GenesisTrophy } from '../art/GenesisTrophy.js';
import { FACTION_ART } from '../art/manifest.js';
import { captionStyle, humanize, panelStyle, readoutStyle } from '../hud/styles.js';

/**
 * The personal war room (§34).
 *
 * *"The player profile must feel like a personal war room, not a generic crypto
 * dashboard made from interchangeable metric cards."* So the Genesis Card is the
 * centrepiece and gets a panel of its own, and the lifetime numbers sit
 * underneath it as supporting detail rather than as a row of equal tiles.
 *
 * Every value here is server- or chain-derived. Nothing is computed locally: a
 * win rate the client works out from a page of history would disagree with the
 * one the indexer knows about the moment the history is paginated.
 */

export interface GenesisCardView {
  readonly genesisId: string;
  readonly name: string;
  readonly rarity: Rarity;
  /**
   * Which card it is, so the profile can show the same face the reveal opened.
   * `null` for a card with no art in the catalog, which renders as text.
   */
  readonly cardType: CardType | null;
  /** The support effect, in the product's words, e.g. `Market Support +2`. */
  readonly effect: string;
  readonly usesRemaining: number;
  /** Whether this wallet holds the Secret trophy (§34.8). */
  readonly secretTrophy: boolean;
}

export interface LifetimeStats {
  readonly battles: number;
  readonly wins: number;
  readonly losses: number;
  /**
   * Win rate in basis points, so the client never divides (§66.3). `null`
   * before any battle is decided — a new player has no rate, not a rate of zero.
   */
  readonly winRateBps: number | null;
  readonly upsets: number;
  readonly majorUpsets: number;
  readonly cardAssistedWins: number;
  readonly lifetimeWarPoints: number;
}

export interface BattleHistoryRow {
  readonly roundId: string;
  readonly matchup: string;
  readonly backed: string;
  /** The result in the product's vocabulary, e.g. `MAJOR UPSET`. */
  readonly outcome: string;
  readonly warPoints: number;
  readonly cardName: string | null;
}

export interface MostBacked {
  readonly ticker: string;
  readonly battles: number;
  readonly winRateBps: number;
}

export interface BiggestUpset {
  readonly headline: string;
  readonly classification: string;
  readonly roundId: string;
}

/**
 * What the wallet holds on chain: its `$WAR`, and its Genesis card (§34.1, §34.2).
 *
 * Each either read or said not to be, separately — the balance is read from
 * Robinhood Chain before Genesis claims are. An unclaimed card and a card nobody
 * has looked up are different facts, and `card: null` could only ever say the
 * first; a zero balance and an unread one are the same kind of pair.
 */
export interface Holdings {
  readonly war: WarHoldingView;
  readonly genesis:
    | { readonly status: 'UNPUBLISHED' }
    | { readonly status: 'PUBLISHED'; readonly card: GenesisCardView | null };
}

export type WarHoldingView =
  /** This server does not read the chain. */
  | { readonly status: 'UNPUBLISHED' }
  /** It does, and the read did not come back in time. */
  | { readonly status: 'UNAVAILABLE' }
  | {
      readonly status: 'READ';
      /** Already written down, e.g. `1,234,567.89`. */
      readonly balance: string;
      /** Any `$WAR` at all (§34.1 holder status). */
      readonly holder: boolean;
    };

export interface ProfileData {
  readonly addressFragment: string;
  readonly holdings: Holdings;
  readonly lifetime: LifetimeStats;
  readonly history: readonly BattleHistoryRow[];
  readonly mostBacked: MostBacked | null;
  readonly biggestUpset: BiggestUpset | null;
}

export function WarRoom({ profile }: { readonly profile: ProfileData }): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 'var(--pw-space-4)' }}>
      <CommandBanner profile={profile} />

      {/* The room itself: the card in the middle, what the commander has done
          on one side and what they have fought on the other. §34 asks for a
          war room rather than a column of interchangeable metric cards, and a
          stack of full-width panels is the column it is warning about. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))',
          gap: 'var(--pw-space-4)',
          alignItems: 'stretch',
        }}
      >
        <div style={{ display: 'grid', gap: 'var(--pw-space-4)', alignContent: 'start' }}>
          <Lifetime stats={profile.lifetime} />
          {profile.mostBacked === null ? null : <MostBackedPanel stat={profile.mostBacked} />}
        </div>
        <GenesisCardPanel genesis={profile.holdings.genesis} />
        <div
          style={{ display: 'grid', gap: 'var(--pw-space-4)', alignContent: 'start', minWidth: 0 }}
        >
          {profile.biggestUpset === null ? null : (
            <BiggestUpsetPanel upset={profile.biggestUpset} />
          )}
          <History rows={profile.history} />
        </div>
      </div>
    </div>
  );
}

/**
 * §34.1: who this is — wallet fragment, `$WAR` balance, holder status — across
 * the top of the room, over an army.
 *
 * The army is the one the commander has backed most, when there is one: a
 * picture of their own war rather than of somebody's. §34.6 keeps that
 * descriptive, and so is this — it is a backdrop, and nothing is claimed by it.
 */
function CommandBanner({ profile }: { readonly profile: ProfileData }): JSX.Element {
  const ticker = profile.mostBacked?.ticker;
  const art =
    ticker !== undefined && isActiveTicker(ticker) ? FACTION_ART[ticker] : FACTION_ART.SPY;

  return (
    <header
      style={{
        position: 'relative',
        overflow: 'hidden',
        minHeight: 190,
        display: 'flex',
        alignItems: 'flex-end',
        borderRadius: 'var(--pw-radius-panel)',
        border: 'var(--pw-line-hair) solid var(--pw-border-1)',
        background: 'var(--pw-surface-2)',
      }}
    >
      <img
        src={art}
        alt=""
        decoding="async"
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: '70%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: 'center 35%',
          maskImage: 'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.5) 30%, #000 70%)',
          WebkitMaskImage: 'linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.5) 30%, #000 70%)',
        }}
      />
      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          gap: 'var(--pw-space-6)',
          padding: 'var(--pw-space-5)',
          width: '100%',
        }}
      >
        <div style={{ display: 'grid', gap: 'var(--pw-space-1)' }}>
          <div style={captionStyle}>COMMANDER</div>
          <div
            className="pw-tabular"
            style={{ ...readoutStyle, fontSize: 'clamp(26px, 3.4vw, 36px)', fontWeight: 700 }}
          >
            {profile.addressFragment}
          </div>
        </div>
        <WarBalance war={profile.holdings.war} />
      </div>
    </header>
  );
}

/** §34.1: the `$WAR` balance and holder status, or why neither is shown. */
function WarBalance({ war }: { readonly war: WarHoldingView }): JSX.Element {
  if (war.status === 'READ') {
    return (
      <div style={{ display: 'flex', gap: 'var(--pw-space-5)', paddingBottom: 4 }}>
        <Field caption="$WAR BALANCE" value={war.balance} size={20} />
        <Field
          caption="STATUS"
          value={war.holder ? 'WAR HOLDER ✓' : 'NOT A HOLDER'}
          accent={war.holder ? 'var(--pw-accent)' : 'var(--pw-text-3)'}
          size={20}
        />
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 'var(--pw-space-1)', maxWidth: 360 }}>
      <Field
        caption="$WAR"
        value={war.status === 'UNAVAILABLE' ? 'NOT READ' : 'NOT PUBLISHED'}
        accent="var(--pw-text-3)"
      />
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--pw-text-3)' }}>
        {war.status === 'UNAVAILABLE'
          ? 'Robinhood Chain did not answer in time. Your balance is unchanged; open this page again to read it.'
          : 'Balances are read from Robinhood Chain, and this server does not read it. Your record below is complete.'}
      </p>
    </div>
  );
}

/**
 * §34.2: the Genesis Card as the visual centrepiece.
 *
 * *"A depleted card remains permanently visible as a Genesis artifact."* So a
 * card at zero uses is still rendered in full — it is marked depleted, not
 * hidden, because §7 makes Genesis a one-time non-transferable record rather
 * than a consumable that disappears when spent.
 */
function GenesisCardPanel({ genesis }: { readonly genesis: Holdings['genesis'] }): JSX.Element {
  if (genesis.status === 'UNPUBLISHED') {
    return (
      <div
        style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)', alignContent: 'start' }}
      >
        <div style={captionStyle}>GENESIS CARD</div>
        <div style={{ ...readoutStyle, color: 'var(--pw-text-3)' }}>NOT PUBLISHED YET</div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--pw-text-3)' }}>
          Genesis claims are read from the chain. Whether this wallet holds a card is not something
          this page will guess.
        </p>
      </div>
    );
  }

  const { card } = genesis;
  if (card === null) {
    return (
      <div
        style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)', alignContent: 'start' }}
      >
        <div style={captionStyle}>GENESIS CARD</div>
        <div style={{ ...readoutStyle, color: 'var(--pw-text-3)' }}>NOT CLAIMED</div>
      </div>
    );
  }

  const tint = RARITY_COLOR[card.rarity];
  const finalUse = card.usesRemaining === 1;

  return (
    <div
      style={{
        ...panelStyle,
        display: 'grid',
        gap: 'var(--pw-space-3)',
        justifyItems: 'center',
        alignContent: 'start',
        padding: 'var(--pw-space-5)',
        // The card lit from below in its rarity's light: the centrepiece on its
        // plinth, which is what every delivered war-room frame puts in the
        // middle of the room. The rarity is written out too (§36.7).
        background: `radial-gradient(ellipse 60% 45% at 50% 62%, ${tint}30, transparent 72%), var(--pw-surface-2)`,
      }}
    >
      <div style={{ ...captionStyle, justifySelf: 'stretch', textAlign: 'center' }}>
        YOUR GENESIS CARD
      </div>
      {/* The face the reveal opened, drawn by the same component (§34.2). Its
          charge count, rarity and Genesis number are printed on it, so they
          are not repeated; the name stays in real text below, because the face
          is one image with one label and §110 does not let the only statement
          of what a player holds live inside a picture. */}
      {card.cardType === null ? null : (
        <div style={{ maxWidth: '100%', filter: `drop-shadow(0 0 26px ${tint}55)` }}>
          <GenesisCardFace
            cardType={card.cardType}
            rarity={card.rarity}
            genesisId={card.genesisId}
            usesRemaining={card.usesRemaining}
            width={250}
          />
        </div>
      )}
      <div
        aria-hidden="true"
        style={{
          width: 240,
          height: 26,
          marginTop: -18,
          borderRadius: '50%',
          border: `1px solid ${tint}55`,
          boxShadow: `0 0 24px ${tint}33`,
        }}
      />

      <div style={{ textAlign: 'center', display: 'grid', gap: 2 }}>
        <div style={{ ...readoutStyle, fontSize: 22 }}>{card.name.toUpperCase()}</div>
        <div style={{ ...captionStyle, color: tint }}>
          {card.rarity} · {card.effect.toUpperCase()}
        </div>
      </div>

      {finalUse ? (
        // The one thing the card itself does not say. §40.9 wants the count
        // unambiguous, and `01 / 03` is unambiguous about the number without
        // saying what it means.
        <div style={{ ...captionStyle, color: 'var(--pw-warning)' }}>FINAL USE</div>
      ) : null}

      {card.secretTrophy ? (
        // §34.8: a permanent, non-transferable artifact tied to the original
        // Genesis wallet record. It outlives the claim it came from.
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            alignItems: 'center',
            gap: 'var(--pw-space-3)',
            justifySelf: 'stretch',
            paddingTop: 'var(--pw-space-3)',
            borderTop: 'var(--pw-line-hair) solid var(--pw-border-1)',
          }}
        >
          <GenesisTrophy size={84} />
          <div style={{ display: 'grid', gap: 'var(--pw-space-1)' }}>
            <div style={{ ...captionStyle, color: RARITY_COLOR.SECRET }}>
              SECRET STOCK DROP · CLAIMED ✓
            </div>
            {/* §34.8 makes this outlive the claim it came from, and that is
                the whole of what makes it worth holding. */}
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--pw-text-3)' }}>
              A permanent, non-transferable record tied to this wallet&apos;s Genesis claim. It
              stays after the card is spent.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** §34.4: lifetime statistics, kept separate from the current window. */
function Lifetime({ stats }: { readonly stats: LifetimeStats }): JSX.Element {
  const tiles: readonly (readonly [string, string])[] = [
    ['BATTLES', String(stats.battles)],
    ['WIN RATE', stats.winRateBps === null ? '—' : formatBps(stats.winRateBps)],
    ['WINS', String(stats.wins)],
    ['LOSSES', String(stats.losses)],
    ['UPSETS', String(stats.upsets)],
    ['MAJOR UPSETS', String(stats.majorUpsets)],
    ['CARD-ASSISTED', String(stats.cardAssistedWins)],
    ['LIFETIME WP', String(stats.lifetimeWarPoints)],
  ];

  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-3)' }}>
      <div style={captionStyle}>COMMANDER STATS · LIFETIME</div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 'var(--pw-space-2)',
        }}
      >
        {tiles.map(([caption, value]) => (
          <div
            key={caption}
            style={{
              padding: 'var(--pw-space-2) var(--pw-space-3)',
              borderRadius: 'var(--pw-radius-sm)',
              border: 'var(--pw-line-hair) solid var(--pw-border-1)',
              background: 'var(--pw-surface-1)',
            }}
          >
            <Field caption={caption} value={value} size={20} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * §34.6: a descriptive statistic, and nothing more.
 *
 * *"PonsWars does not reintroduce permanent faction allegiance."* The caption
 * says so on screen, because a "most backed" line without it is exactly how a
 * player starts believing they have a faction.
 */
function MostBackedPanel({ stat }: { readonly stat: MostBacked }): JSX.Element {
  const known = isActiveTicker(stat.ticker) ? stat.ticker : null;
  return (
    <div
      style={{
        ...panelStyle,
        display: 'grid',
        gridTemplateColumns: known === null ? '1fr' : 'auto 1fr',
        alignItems: 'center',
        gap: 'var(--pw-space-3)',
      }}
    >
      {known === null ? null : <FactionEmblem ticker={known} size={40} />}
      <div style={{ display: 'grid', gap: 2 }}>
        <div style={captionStyle}>MOST BACKED</div>
        <div
          style={{
            ...readoutStyle,
            fontSize: 22,
            color: known === null ? 'var(--pw-text-1)' : FACTION_ACCENT[known],
          }}
        >
          {stat.ticker}
        </div>
        <div className="pw-tabular" style={{ fontSize: 12, color: 'var(--pw-text-2)' }}>
          {stat.battles} {stat.battles === 1 ? 'Battle' : 'Battles'} · {formatBps(stat.winRateBps)}{' '}
          Win Rate
        </div>
        <div style={{ ...captionStyle, fontSize: 9 }}>
          HISTORICAL ONLY — NO EFFECT ON MATCHMAKING OR REWARDS
        </div>
      </div>
    </div>
  );
}

/** §34.7: one personal highlight, without adding campaign complexity. */
function BiggestUpsetPanel({ upset }: { readonly upset: BiggestUpset }): JSX.Element {
  return (
    <div
      style={{
        ...panelStyle,
        display: 'grid',
        gap: 'var(--pw-space-1)',
        borderLeft: '2px solid var(--pw-rarity-legendary)',
      }}
    >
      <div style={captionStyle}>BIGGEST UPSET</div>
      <div style={{ ...readoutStyle, fontSize: 22 }}>{upset.headline.toUpperCase()}</div>
      <div className="pw-tabular" style={{ fontSize: 12, color: 'var(--pw-rarity-legendary)' }}>
        {upset.classification} · ROUND {upset.roundId}
      </div>
    </div>
  );
}

/** §34.5: history rows that preserve what actually happened. */
function History({ rows }: { readonly rows: readonly BattleHistoryRow[] }): JSX.Element {
  const columns = '40px minmax(0, 1fr) auto 30px';
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)', minWidth: 0 }}>
      <div style={captionStyle}>RECENT BATTLE HISTORY</div>
      {rows.length === 0 ? (
        <div style={{ color: 'var(--pw-text-3)', fontSize: 13 }}>NO BATTLES YET</div>
      ) : (
        <div role="table" aria-label="Recent battle history" style={{ display: 'grid' }}>
          <div
            role="row"
            style={{
              display: 'grid',
              gridTemplateColumns: columns,
              gap: 'var(--pw-space-3)',
              paddingBottom: 'var(--pw-space-2)',
            }}
          >
            {['ROUND', 'BATTLE', 'RESULT', 'WP'].map((heading) => (
              <span key={heading} role="columnheader" style={{ ...captionStyle, fontSize: 9 }}>
                {heading}
              </span>
            ))}
          </div>
          {rows.map((row) => (
            <div
              key={row.roundId}
              role="row"
              className="pw-tabular"
              style={{
                display: 'grid',
                gridTemplateColumns: columns,
                gap: 'var(--pw-space-3)',
                alignItems: 'baseline',
                fontSize: 12,
                color: 'var(--pw-text-2)',
                borderTop: 'var(--pw-line-hair) solid var(--pw-border-1)',
                padding: 'var(--pw-space-2) 0',
              }}
            >
              <span role="cell">{row.roundId}</span>
              <span role="cell" style={{ minWidth: 0, color: 'var(--pw-text-1)' }}>
                {row.matchup}
                <span
                  style={{
                    display: 'block',
                    fontSize: 10,
                    color: 'var(--pw-text-3)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  <span
                    style={{
                      color: isActiveTicker(row.backed) ? FACTION_ACCENT[row.backed] : undefined,
                    }}
                  >
                    BACKED {row.backed}
                  </span>
                  {/* §34.5 keeps whether a card was used *and* which one —
                      "saved" is a real outcome the player chose, not an absence. */}
                  {' · '}
                  {row.cardName === null ? 'CARD SAVED' : `CARD ${row.cardName.toUpperCase()}`}
                </span>
              </span>
              <span
                role="cell"
                style={{
                  color: outcomeColour(row.outcome),
                  whiteSpace: 'nowrap',
                  textAlign: 'right',
                }}
              >
                {humanize(row.outcome)}
              </span>
              <span role="cell" style={{ color: 'var(--pw-text-1)', textAlign: 'right' }}>
                +{row.warPoints}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A result's colour: a loss or a void is quiet, a win is not, an upset is gold. */
function outcomeColour(outcome: string): string {
  switch (outcome) {
    case 'LOSS':
    case 'VOID':
      return 'var(--pw-text-3)';
    case 'UPSET_VICTORY':
    case 'MAJOR_UPSET':
      return 'var(--pw-rarity-legendary)';
    default:
      return 'var(--pw-accent)';
  }
}

function Field({
  caption,
  value,
  accent,
  size = 15,
}: {
  readonly caption: string;
  readonly value: string;
  readonly accent?: string;
  readonly size?: number;
}): JSX.Element {
  return (
    <div>
      <div style={captionStyle}>{caption}</div>
      <div className="pw-tabular" style={{ fontSize: size, color: accent ?? 'var(--pw-text-1)' }}>
        {value}
      </div>
    </div>
  );
}

/**
 * Formats a basis-point rate as a percentage with one decimal.
 *
 * The server sends basis points so the client never divides a win count by a
 * battle count — two numbers that disagree the moment history is paginated
 * (§66.3 keeps ratios out of float arithmetic on the client).
 */
export function formatBps(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new RangeError(
      `A rate in basis points must be a non-negative integer, got ${String(bps)}`,
    );
  }
  const tenths = Math.round(bps / 10);
  return `${String(Math.floor(tenths / 10))}.${String(tenths % 10)}%`;
}
