import type { Brand } from './brand.js';

/** Identifier for one 10-minute global round (§3). */
export type RoundId = Brand<string, 'RoundId'>;

/** Identifier for one of the five battles inside a round (§4.3). */
export type BattleId = Brand<string, 'BattleId'>;

/**
 * Identifier for one of the five neutral War Sectors (§38.3).
 *
 * Sectors are neutral and reused every round. A sector never belongs to a
 * faction — permanent territory is the deprecated conquest system (§38.3).
 */
export type SectorId = Brand<string, 'SectorId'>;

/**
 * A checksummed EVM address, lowercased for storage.
 *
 * The wallet is the primary key of a player. There are no usernames and no
 * accounts to create.
 */
export type WalletAddress = Brand<string, 'WalletAddress'>;

/** Identifier of a finalized Genesis outcome (§9). One per wallet, forever. */
export type GenesisId = Brand<string, 'GenesisId'>;

/**
 * Identifier of a Genesis *request*, distinct from its outcome.
 *
 * The request ID is part of the RNG seed and is permanent: it is what makes a
 * result replayable and un-rerollable (§9). A request that fails to finalize is
 * recovered, never reissued.
 */
export type GenesisRequestId = Brand<string, 'GenesisRequestId'>;

/** Identifier of the single card instance a Genesis claim produced (§7). */
export type CardInstanceId = Brand<string, 'CardInstanceId'>;

/** Identifier of one 24-hour Rewards Distribution window (§16.2). */
export type DistributionId = Brand<string, 'DistributionId'>;

/** Identifier of a reserved Secret Stock Drop entitlement (§8.4). */
export type SecretEntitlementId = Brand<string, 'SecretEntitlementId'>;

/**
 * Client-supplied idempotency key for a retryable mutation (§66.6).
 *
 * The client generates it once per logical intent and reuses it across
 * retries, so a dropped response cannot produce a second pick, a second card
 * deployment or a duplicate War Point award.
 */
export type ClientRequestId = Brand<string, 'ClientRequestId'>;

/** Server-assigned identifier of a realtime event, unique per stream (§48.5). */
export type EventId = Brand<string, 'EventId'>;

/**
 * Correlation identifier threaded through logs and audit records (§66.7).
 */
export type CorrelationId = Brand<string, 'CorrelationId'>;
