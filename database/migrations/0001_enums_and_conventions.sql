-- 0001 — Enumerated types and the conventions every later migration follows.
--
-- Masterplan §49 (database model), §66 (engineering standards), §71
-- (constraints, indexes, transaction rules).
--
-- Three conventions hold across the whole schema:
--
--   1. Money is NUMERIC(78, 0) — integer base units, never a float. Standard
--      §66.3 forbids floating point for token amounts, and 78 digits covers the
--      full uint256 range a contract can hold. DOUBLE PRECISION would silently
--      round a reward; NUMERIC with scale 0 cannot.
--
--   2. Time is TIMESTAMPTZ, stored UTC (§66.5). Server time is authoritative
--      (§23.5), so no column ever records a client-supplied instant without
--      naming it as such.
--
--   3. Ledgers are append-only with a unique idempotency key. Exactly-once
--      effects are database constraints, not application discipline
--      (Kickoff Brief §13).
--
-- Enum values mirror the unions in @ponswars/shared-types exactly. Section 65.1
-- allows one canonical definition per concept; these types are the storage
-- projection of that definition, and a value added on one side without the
-- other will fail a write rather than pass silently.

BEGIN;

-- Round lifecycle (§22).
CREATE TYPE round_state AS ENUM (
  'PREPARING',
  'PICK_OPEN',
  'LOCKING',
  'BATTLE_LIVE',
  'FINALIZING',
  'FINALIZED',
  'VOID'
);

-- Per-battle lifecycle (§49.7).
CREATE TYPE battle_state AS ENUM ('SCHEDULED', 'LIVE', 'FINALIZED', 'VOID');

-- Genesis rarity (§7.1).
CREATE TYPE card_rarity AS ENUM (
  'COMMON',
  'UNCOMMON',
  'RARE',
  'EPIC',
  'LEGENDARY',
  'SECRET'
);

-- The fourteen cards in the V1 pool (§7.2).
CREATE TYPE card_type AS ENUM (
  'REINFORCEMENT',
  'MARKET_SIGNAL',
  'SUPPLY_DROP',
  'HEAVY_REINFORCEMENT',
  'VOLUME_BOOSTER',
  'MARKET_AMPLIFIER',
  'BULL_RUN',
  'LIQUIDITY_WAVE',
  'PONS_SURGE',
  'WAR_MACHINE',
  'TRIPLE_ENGINE',
  'GOLDEN_ARMY',
  'MARKET_DOMINANCE',
  'SECRET_STOCK_DROP'
);

-- Pick Phase card decision (§27.6). USE only arms; the charge is consumed at
-- lock (§3.2).
CREATE TYPE card_decision AS ENUM ('USE', 'SAVE');

-- Append-only card ledger events (§49.5).
CREATE TYPE card_usage_event AS ENUM ('DEPLOY', 'VOID_REFUND', 'CORRECTION');

-- Pre-battle screening labels (§10.2). Never a probability.
CREATE TYPE confidence_label AS ENUM (
  'HEAVY_UNDERDOG',
  'UNDERDOG',
  'EVEN',
  'FAVORED',
  'STRONG_FAVORITE',
  'DOMINANT'
);

-- Result treatments (§13.6).
CREATE TYPE victory_label AS ENUM (
  'NARROW_VICTORY',
  'VICTORY',
  'DECISIVE_VICTORY',
  'UPSET_VICTORY',
  'MAJOR_UPSET',
  'COMEBACK_VICTORY'
);

-- Tiebreak steps (§12.7). No admin step exists, by design.
CREATE TYPE tiebreak_step AS ENUM (
  'priceMomentum',
  'relativeVolume',
  'ponsPower',
  'chainDerived'
);

-- War Point award reasons (§11). Doubles as the ledger idempotency dimension.
CREATE TYPE wp_award_reason AS ENUM (
  'WIN',
  'UNDERDOG_WIN',
  'HEAVY_UNDERDOG_WIN',
  'CARD_ASSIST'
);

-- Distribution window lifecycle (§16.2, §17).
CREATE TYPE distribution_state AS ENUM (
  'OPEN',
  'SNAPSHOT',
  'CALCULATED',
  'PUBLISHED',
  'CLOSED'
);

-- Per-wallet allocation outcome (§16.7, §16.8).
CREATE TYPE reward_allocation_state AS ENUM (
  'CALCULATED',
  'PUBLISHED',
  'CLAIMED',
  'CARRIED_FORWARD'
);

-- Secret entitlement lifecycle (§8.5).
CREATE TYPE secret_entitlement_state AS ENUM ('RESERVED', 'CLAIMED');

-- Genesis request lifecycle (§47.4). COMMITTED never returns to a retryable
-- state — that would be the reroll §9 forbids.
CREATE TYPE genesis_request_state AS ENUM (
  'PENDING',
  'COMMITTED',
  'FINALIZED',
  'FAILED'
);

-- Feed health (§23.6). Thresholds are configuration; the states are not.
CREATE TYPE feed_health AS ENUM ('HEALTHY', 'DEGRADED', 'STALE', 'UNAVAILABLE');

-- Public reason categories on a BATTLE_VOID event (§48.3).
CREATE TYPE void_reason_category AS ENUM ('DATA_INTEGRITY', 'MARKET_HALT');

-- A lowercase, 0x-prefixed 20-byte address. Used everywhere a wallet appears,
-- so a mixed-case address cannot become a second identity for one player.
CREATE DOMAIN evm_address AS TEXT
  CHECK (VALUE ~ '^0x[0-9a-f]{40}$');

-- Integer token base units. The full uint256 range, exact.
CREATE DOMAIN token_amount AS NUMERIC(78, 0)
  CHECK (VALUE >= 0);

COMMIT;
