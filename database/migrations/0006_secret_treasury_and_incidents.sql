-- 0006 — Secret entitlements, treasury accounting and system incidents.
--
-- Masterplan §8 (Secret vault), §18 (SecretStockVault), §49.12,
-- §107 (treasury reconciliation), §53 (incident response).

BEGIN;

-- ---------------------------------------------------------------------------
-- secret_entitlements (§49.12)
-- ---------------------------------------------------------------------------
-- §8.4 fixes the ordering: acquire the lock, re-check coverage, create the
-- entitlement, reserve the reward, commit the Genesis result, and only then
-- reveal. This row is created at step three, so its existence is what proves a
-- reveal was allowed to happen.
CREATE TABLE secret_entitlements (
  entitlement_id         TEXT PRIMARY KEY,
  genesis_id             TEXT NOT NULL UNIQUE REFERENCES genesis_claims (genesis_id),

  -- Brief §13: one Secret entitlement per Genesis result. A wallet holds at
  -- most one Genesis, so this is also one per wallet.
  wallet                 evm_address NOT NULL UNIQUE REFERENCES wallet_profiles (wallet),

  -- §8.1 fixes the reward. Stored per row rather than assumed, so a historical
  -- entitlement stays readable if the amount is ever revised for V2.
  amount                 token_amount NOT NULL CHECK (amount > 0),

  state                  secret_entitlement_state NOT NULL DEFAULT 'RESERVED',

  reservation_tx         TEXT,
  reserved_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_tx               TEXT,
  claimed_at             TIMESTAMPTZ,

  -- Hash of the signed authorization payload, where the contract requires one
  -- (§8.4, §20). The signature itself is never stored.
  authorization_hash     TEXT,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT secret_claimed_is_complete
    CHECK (state <> 'CLAIMED' OR (claim_tx IS NOT NULL AND claimed_at IS NOT NULL))
);

COMMENT ON TABLE secret_entitlements IS
  'Section 8.5: reserved funds cannot be withdrawn by admin and cannot be reassigned to another winner. After a claim the trophy stays permanently in the profile - the row is never deleted, only transitioned.';

CREATE UNIQUE INDEX secret_entitlements_claim_tx_unique ON secret_entitlements (claim_tx)
  WHERE claim_tx IS NOT NULL;
CREATE INDEX secret_entitlements_unclaimed_idx ON secret_entitlements (state)
  WHERE state = 'RESERVED';

-- ---------------------------------------------------------------------------
-- treasury_ledger (§107)
-- ---------------------------------------------------------------------------
-- Every movement of value into or out of the two pools. §30 makes funding
-- manual, so this is the record that reconciles what an operator did against
-- what the system expected.
CREATE TABLE treasury_ledger (
  entry_id               BIGSERIAL PRIMARY KEY,

  -- Which pool moved. The Secret Vault is independent of the Rewards
  -- Distributor (§18) and the two are never netted against each other.
  pool                   TEXT NOT NULL CHECK (pool IN ('REWARDS_DISTRIBUTION', 'SECRET_VAULT')),
  direction              TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),

  amount                 token_amount NOT NULL CHECK (amount > 0),
  token_address          evm_address NOT NULL,

  tx_hash                TEXT NOT NULL,
  block_number           BIGINT NOT NULL CHECK (block_number > 0),
  observed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Free text describing why, for the operator's own reconciliation.
  note                   TEXT,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per transfer. A reorg that replays an event must not double-count.
CREATE UNIQUE INDEX treasury_ledger_tx_unique ON treasury_ledger (tx_hash, pool, direction);
CREATE INDEX treasury_ledger_by_pool_idx ON treasury_ledger (pool, observed_at DESC);

-- ---------------------------------------------------------------------------
-- system_incidents (§53)
-- ---------------------------------------------------------------------------
-- Feed failures, voided rounds, degraded providers, reconciliation mismatches.
-- Written by the services themselves so an incident review reads the same
-- record the engine acted on.
CREATE TABLE system_incidents (
  incident_id            BIGSERIAL PRIMARY KEY,

  severity               TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  category               TEXT NOT NULL,
  summary                TEXT NOT NULL,

  round_id               TEXT REFERENCES rounds (round_id),
  battle_id              TEXT REFERENCES battles (battle_id),
  distribution_id        TEXT REFERENCES distribution_windows (distribution_id),

  -- Structured context. Never credentials, signatures or raw wallet payloads
  -- (§87, §89).
  detail                 JSONB NOT NULL DEFAULT '{}'::JSONB,

  detected_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX system_incidents_open_idx ON system_incidents (severity, detected_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX system_incidents_by_round_idx ON system_incidents (round_id)
  WHERE round_id IS NOT NULL;

COMMIT;
