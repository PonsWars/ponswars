import type { CardDecision, CardType } from './cards.js';
import type { Rarity } from './genesis.js';
import type {
  BattleId,
  CardInstanceId,
  ClientRequestId,
  GenesisId,
  RoundId,
  WalletAddress,
} from './ids.js';
import type { ActiveTicker } from './roster.js';
import type { UtcTimestamp } from './time.js';

/**
 * Player identity, capabilities, picks and profile state.
 *
 * Masterplan §5 (spectator vs connected), §27.6 (pick decision),
 * §34 (profile), §47.5 (pick API), §49.8 (player_picks).
 */

/**
 * Who is watching.
 *
 * PonsWars stays fully watchable without a wallet (§5) — spectating is a
 * first-class mode, not a degraded one.
 */
export const VIEWER_KINDS = ['SPECTATOR', 'CONNECTED'] as const;

export type ViewerKind = (typeof VIEWER_KINDS)[number];

/** Capabilities gated by wallet connection (§5). */
export const PLAYER_CAPABILITIES = [
  'VIEW_WAR_MAP',
  'INSPECT_LIVE_MATCHUPS',
  'SWITCH_BETWEEN_BATTLES',
  'VIEW_WAR_MOMENTUM',
  'VIEW_PUBLIC_RESULTS',
  'MAKE_PICK',
  'DEPLOY_CARD',
  'EARN_WAR_POINTS',
  'CLAIM_REWARDS',
  'VIEW_OWN_PROFILE',
] as const;

export type PlayerCapability = (typeof PLAYER_CAPABILITIES)[number];

/**
 * What each viewer kind may do (§5).
 *
 * A spectator sees everything public and changes nothing. Every capability a
 * spectator has, a connected player also has — connecting only ever adds.
 */
export const CAPABILITIES_BY_VIEWER: Readonly<Record<ViewerKind, readonly PlayerCapability[]>> = {
  SPECTATOR: [
    'VIEW_WAR_MAP',
    'INSPECT_LIVE_MATCHUPS',
    'SWITCH_BETWEEN_BATTLES',
    'VIEW_WAR_MOMENTUM',
    'VIEW_PUBLIC_RESULTS',
  ],
  CONNECTED: [
    'VIEW_WAR_MAP',
    'INSPECT_LIVE_MATCHUPS',
    'SWITCH_BETWEEN_BATTLES',
    'VIEW_WAR_MOMENTUM',
    'VIEW_PUBLIC_RESULTS',
    'MAKE_PICK',
    'DEPLOY_CARD',
    'EARN_WAR_POINTS',
    'CLAIM_REWARDS',
    'VIEW_OWN_PROFILE',
  ],
} as const;

export function can(viewer: ViewerKind, capability: PlayerCapability): boolean {
  return CAPABILITIES_BY_VIEWER[viewer].includes(capability);
}

/**
 * A pick as submitted by a client (§47.5).
 *
 * `clientRequestId` is the idempotency key required by §66.6: the client
 * generates it once per intent and reuses it across retries, so a dropped
 * response cannot produce a second pick.
 *
 * The server records its own trusted receive and commit timestamps — nothing
 * here is taken as a claim about when the pick happened.
 */
export interface PickSubmission {
  readonly roundId: RoundId;
  readonly battleId: BattleId;
  readonly backedTicker: ActiveTicker;
  readonly cardDecision: CardDecision;
  readonly clientRequestId: ClientRequestId;
}

/**
 * A stored pick (§49.8).
 *
 * Unique on `(wallet, roundId)` at the database level, not only in application
 * code (Brief §13) — one pick per wallet per round is a constraint, not a
 * convention.
 */
export interface PlayerPick {
  readonly wallet: WalletAddress;
  readonly roundId: RoundId;
  readonly battleId: BattleId;
  readonly backedTicker: ActiveTicker;
  readonly cardDecision: CardDecision;
  /** Server-trusted receive time, not a client claim. */
  readonly committedAt: UtcTimestamp;
  /**
   * Bumped on each mutation during Pick Phase, so a late retry that arrives
   * out of order cannot overwrite a newer decision.
   */
  readonly revision: number;
}

/** The single card a wallet owns, if it has claimed Genesis (§7). */
export interface OwnedCard {
  readonly cardInstanceId: CardInstanceId;
  readonly genesisId: GenesisId;
  readonly wallet: WalletAddress;
  readonly type: CardType;
  readonly rarity: Rarity;
  readonly initialUses: number;
  readonly remainingUses: number;
  /** Cards are non-transferable in V1 (§6). Present so the rule travels with the data. */
  readonly transferable: false;
}

/**
 * Lifetime and current-window statistics (§34.4).
 *
 * Lifetime figures persist across distribution snapshots; only
 * `currentWindowWarPoints` resets (§16.2). Both are cached aggregates and must
 * be rebuildable from the WP ledger (§49.2).
 */
export interface PlayerStats {
  readonly wallet: WalletAddress;
  readonly lifetimeBattles: number;
  readonly lifetimeWins: number;
  readonly lifetimeUpsets: number;
  readonly lifetimeWarPoints: number;
  readonly currentWindowWarPoints: number;
}

/** Win rate as a fraction in `[0, 1]`, or `null` when no battles have resolved. */
export function winRate(stats: PlayerStats): number | null {
  if (stats.lifetimeBattles === 0) {
    return null;
  }
  return stats.lifetimeWins / stats.lifetimeBattles;
}
