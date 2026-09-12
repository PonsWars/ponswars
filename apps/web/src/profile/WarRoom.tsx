import type { CardType, Rarity } from '@ponswars/shared-types';
import { RARITY_COLOR } from '@ponswars/ui-tokens';
import type { JSX } from 'react';
import { GenesisCardFace } from '../art/GenesisCardFace.js';
import { GenesisTrophy } from '../art/GenesisTrophy.js';
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
 * Either published or said not to be. An unclaimed card and a card nobody has
 * looked up are different facts, and `card: null` could only ever say the first.
 */
export type Holdings =
  | { readonly status: 'UNPUBLISHED' }
  | {
      readonly status: 'PUBLISHED';
      readonly warBalance: string;
      readonly warHolder: boolean;
      readonly card: GenesisCardView | null;
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
    <>
      {/* Who you are and what you hold, side by side. §34 asks for a war room
          rather than a column of interchangeable metric cards, and a stack of
          full-width panels is the column it is warning about. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))',
          gap: 'var(--pw-space-4)',
          alignItems: 'start',
        }}
      >
        <Identity profile={profile} />
        <GenesisCardPanel holdings={profile.holdings} />
      </div>

      <Lifetime stats={profile.lifetime} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 'var(--pw-space-4)',
          alignItems: 'start',
        }}
      >
        {profile.mostBacked === null ? null : <MostBackedPanel stat={profile.mostBacked} />}
        {profile.biggestUpset === null ? null : <BiggestUpsetPanel upset={profile.biggestUpset} />}
      </div>

      <History rows={profile.history} />
    </>
  );
}

/** §34.1: wallet fragment, `$WAR` balance, holder status. */
function Identity({ profile }: { readonly profile: ProfileData }): JSX.Element {
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
      <div style={captionStyle}>COMMANDER PROFILE</div>
      <div className="pw-tabular" style={{ ...readoutStyle, fontSize: 22 }}>
        {profile.addressFragment}
      </div>
      {profile.holdings.status === 'PUBLISHED' ? (
        <div style={{ display: 'flex', gap: 'var(--pw-space-4)' }}>
          <Field caption="$WAR" value={profile.holdings.warBalance} />
          <Field
            caption="STATUS"
            value={profile.holdings.warHolder ? 'WAR HOLDER ✓' : 'NOT A HOLDER'}
            accent={profile.holdings.warHolder ? 'var(--pw-accent)' : 'var(--pw-text-3)'}
          />
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--pw-space-1)' }}>
          <Field caption="$WAR" value="NOT PUBLISHED" accent="var(--pw-text-3)" />
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--pw-text-3)' }}>
            Balances are read from the chain, and this server does not read it yet. Your record
            below is complete.
          </p>
        </div>
      )}
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
function GenesisCardPanel({ holdings }: { readonly holdings: Holdings }): JSX.Element {
  if (holdings.status === 'UNPUBLISHED') {
    return (
      <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
        <div style={captionStyle}>GENESIS CARD</div>
        <div style={{ ...readoutStyle, color: 'var(--pw-text-3)' }}>NOT PUBLISHED YET</div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--pw-text-3)' }}>
          Genesis claims are read from the chain. Whether this wallet holds a card is not something
          this page will guess.
        </p>
      </div>
    );
  }

  const { card } = holdings;
  if (card === null) {
    return (
      <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
        <div style={captionStyle}>GENESIS CARD</div>
        <div style={{ ...readoutStyle, color: 'var(--pw-text-3)' }}>NOT CLAIMED</div>
      </div>
    );
  }

  const finalUse = card.usesRemaining === 1;

  return (
    <div
      style={{
        ...panelStyle,
        display: 'grid',
        gap: 'var(--pw-space-3)',
        padding: 'var(--pw-space-5)',
        // Rarity as a border rather than a wash. Design tokens §3 keeps colour
        // to identity cues, and the rarity is written out beside it so the card
        // is readable without relying on colour at all (§36.7).
        borderColor: RARITY_COLOR[card.rarity],
      }}
    >
      <div style={captionStyle}>GENESIS CARD</div>
      {/* The face the reveal opened, drawn by the same component (§34.2). A
          centrepiece described in words while the reveal hands over an object
          is two products in one page.

          Its charge count, its rarity and its Genesis number are printed on the
          card, so they are not repeated underneath. What stays is the name in
          real text — the face is one image with one label, and §110 does not
          let the only statement of what a player holds live inside a picture —
          and the one state the card cannot show. */}
      {card.cardType === null ? null : (
        <div style={{ justifySelf: 'center', maxWidth: '100%' }}>
          <GenesisCardFace
            cardType={card.cardType}
            rarity={card.rarity}
            genesisId={card.genesisId}
            usesRemaining={card.usesRemaining}
            width={230}
          />
        </div>
      )}

      <div style={{ ...readoutStyle, fontSize: 22 }}>
        {card.name.toUpperCase()}
        <span style={{ color: RARITY_COLOR[card.rarity], fontSize: 14 }}> — {card.rarity}</span>
      </div>
      <div style={{ color: 'var(--pw-text-2)', fontSize: 13 }}>{card.effect}</div>

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
            ...panelStyle,
            borderColor: RARITY_COLOR.SECRET,
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            alignItems: 'center',
            gap: 'var(--pw-space-4)',
          }}
        >
          <GenesisTrophy size={124} />
          <div style={{ display: 'grid', gap: 'var(--pw-space-1)' }}>
            <div style={{ ...captionStyle, color: RARITY_COLOR.SECRET }}>SECRET STOCK DROP</div>
            <div className="pw-tabular" style={{ fontSize: 13, color: 'var(--pw-text-2)' }}>
              CLAIMED ✓
            </div>
            {/* §34.8 makes this outlive the claim it came from, and that is the
                whole of what makes it worth holding. Two lines saying it was
                claimed do not say it. */}
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
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-3)' }}>
      <div style={captionStyle}>LIFETIME</div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
          gap: 'var(--pw-space-3)',
        }}
      >
        <Field caption="BATTLES" value={String(stats.battles)} />
        <Field caption="WINS" value={String(stats.wins)} />
        <Field caption="LOSSES" value={String(stats.losses)} />
        <Field
          caption="WIN RATE"
          value={stats.winRateBps === null ? '—' : formatBps(stats.winRateBps)}
        />
        <Field caption="UPSETS" value={String(stats.upsets)} />
        <Field caption="MAJOR UPSETS" value={String(stats.majorUpsets)} />
        <Field caption="CARD-ASSISTED" value={String(stats.cardAssistedWins)} />
        <Field caption="LIFETIME WP" value={String(stats.lifetimeWarPoints)} />
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
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
      <div style={captionStyle}>MOST BACKED</div>
      <div style={{ ...readoutStyle, fontSize: 20 }}>{stat.ticker}</div>
      <div className="pw-tabular" style={{ fontSize: 13, color: 'var(--pw-text-2)' }}>
        {stat.battles} {stat.battles === 1 ? 'Battle' : 'Battles'} · {formatBps(stat.winRateBps)}{' '}
        Win Rate
      </div>
      <div style={{ ...captionStyle, color: 'var(--pw-text-3)' }}>
        HISTORICAL ONLY — NO EFFECT ON MATCHMAKING OR REWARDS
      </div>
    </div>
  );
}

/** §34.7: one personal highlight, without adding campaign complexity. */
function BiggestUpsetPanel({ upset }: { readonly upset: BiggestUpset }): JSX.Element {
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
      <div style={captionStyle}>BIGGEST UPSET</div>
      <div style={{ ...readoutStyle, fontSize: 20 }}>{upset.headline}</div>
      <div className="pw-tabular" style={{ fontSize: 12, color: 'var(--pw-text-2)' }}>
        {upset.classification} · ROUND {upset.roundId}
      </div>
    </div>
  );
}

/** §34.5: history rows that preserve what actually happened. */
function History({ rows }: { readonly rows: readonly BattleHistoryRow[] }): JSX.Element {
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
      <div style={captionStyle}>BATTLE HISTORY</div>
      {rows.length === 0 ? (
        <div style={{ color: 'var(--pw-text-3)', fontSize: 13 }}>NO BATTLES YET</div>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--pw-space-2)' }}>
          {rows.map((row) => (
            <div
              key={row.roundId}
              className="pw-tabular"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--pw-space-2)',
                fontSize: 12,
                color: 'var(--pw-text-2)',
                borderTop: 'var(--pw-line-hair) solid var(--pw-border-1)',
                paddingTop: 'var(--pw-space-2)',
              }}
            >
              <span>ROUND {row.roundId}</span>
              <span>· {row.matchup}</span>
              <span>· BACKED {row.backed}</span>
              <span style={{ color: 'var(--pw-text-1)' }}>· {humanize(row.outcome)}</span>
              <span>· +{row.warPoints} WP</span>
              {/* §34.5 keeps whether a card was used *and* which one — "saved"
                  is a real outcome the player chose, not an absence. */}
              <span>· {row.cardName === null ? 'CARD SAVED' : `CARD ${row.cardName}`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({
  caption,
  value,
  accent,
}: {
  readonly caption: string;
  readonly value: string;
  readonly accent?: string;
}): JSX.Element {
  return (
    <div>
      <div style={captionStyle}>{caption}</div>
      <div className="pw-tabular" style={{ fontSize: 15, color: accent ?? 'var(--pw-text-1)' }}>
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
