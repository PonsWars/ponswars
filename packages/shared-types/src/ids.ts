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

// ---------------------------------------------------------------------------
// Checked constructors
// ---------------------------------------------------------------------------

/**
 * Applying a brand is the moment to check the value, not a moment to skip it.
 *
 * Every identifier above is a branded string, and a brand only helps if it is
 * applied where the value is validated. `value as RoundId` scattered through
 * callers gives the same compile-time comfort with none of the safety, which is
 * exactly the erosion branding exists to prevent — the same reasoning that put
 * `utcTimestamp` and `milliseconds` in `time.ts`.
 *
 * Length limits deliberately live in `@ponswars/schemas` rather than here.
 * Those are wire concerns and belong with the wire contract; duplicating them
 * would create two numbers to keep in agreement.
 */
function checkIdentifier(value: string, label: string): string {
  if (value.length === 0) {
    throw new RangeError(`A ${label} cannot be empty`);
  }
  return value;
}

export function roundId(value: string): RoundId {
  return checkIdentifier(value, 'round id') as RoundId;
}

export function battleId(value: string): BattleId {
  return checkIdentifier(value, 'battle id') as BattleId;
}

export function sectorId(value: string): SectorId {
  return checkIdentifier(value, 'sector id') as SectorId;
}

export function genesisId(value: string): GenesisId {
  return checkIdentifier(value, 'genesis id') as GenesisId;
}

export function genesisRequestId(value: string): GenesisRequestId {
  return checkIdentifier(value, 'genesis request id') as GenesisRequestId;
}

export function cardInstanceId(value: string): CardInstanceId {
  return checkIdentifier(value, 'card instance id') as CardInstanceId;
}

export function distributionId(value: string): DistributionId {
  return checkIdentifier(value, 'distribution id') as DistributionId;
}

export function secretEntitlementId(value: string): SecretEntitlementId {
  return checkIdentifier(value, 'secret entitlement id') as SecretEntitlementId;
}

export function clientRequestId(value: string): ClientRequestId {
  return checkIdentifier(value, 'client request id') as ClientRequestId;
}

export function eventId(value: string): EventId {
  return checkIdentifier(value, 'event id') as EventId;
}

export function correlationId(value: string): CorrelationId {
  return checkIdentifier(value, 'correlation id') as CorrelationId;
}

/**
 * Brands an EVM address, lowercased.
 *
 * Normalisation is part of the construction rather than something callers are
 * asked to remember. `maySubscribe` in `@ponswars/realtime` compares channel
 * names built from a `WalletAddress` and documents that it relies on them being
 * lowercase; a mixed-case address branded by a cast would fail that comparison
 * silently, and the player would simply never receive their own events.
 *
 * @throws RangeError unless `value` is a 20-byte hex address.
 */
export function walletAddress(value: string): WalletAddress {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new RangeError(`Not an EVM address: ${value}`);
  }
  return value.toLowerCase() as WalletAddress;
}
