-- 0005 — War Point ledger, distribution windows, allocations and claims.
--
-- Masterplan §11 (War Points), §16 (distribution), §17 (Merkle claims),
-- §49.10–49.11, §71.

BEGIN;

-- ---------------------------------------------------------------------------
-- wp_ledger (§49.10)
-- ---------------------------------------------------------------------------
-- Append-only. War Points are written only during successful finalization
-- (§22), and a wallet's totals are the sum of these rows — never a counter
-- someone incremented.
CREATE TABLE wp_ledger (
  entry_id               BIGSERIAL PRIMARY KEY,
  wallet                 evm_address NOT NULL REFERENCES wallet_profiles (wallet),
  round_id               TEXT NOT NULL REFERENCES rounds (round_id),
  battle_id              TEXT NOT NULL REFERENCES battles (battle_id),

  reason                 wp_award_reason NOT NULL,
  points                 SMALLINT NOT NULL CHECK (points > 0),

  -- Which 24-hour window this award counts toward (§16.2). Lifetime totals
  -- ignore it; window totals group by it.
  distribution_id        TEXT,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Brief §13 and §49.10: one award per reason per wallet per battle. This is
-- what makes finalization exactly-once in practice — a retried finalization
-- hits this constraint instead of crediting a second time (§25).
CREATE UNIQUE INDEX wp_ledger_idempotency
  ON wp_ledger (wallet, battle_id, reason);

COMMENT ON INDEX wp_ledger_idempotency IS
  'Section 25 requires finalization to be exactly-once. A retry that reaches this index conflicts rather than crediting War Points twice; the handler treats the conflict as success.';

CREATE INDEX wp_ledger_window_idx ON wp_ledger (distribution_id, wallet)
  WHERE distribution_id IS NOT NULL;
CREATE INDEX wp_ledger_by_wallet_idx ON wp_ledger (wallet, created_at DESC);

-- ---------------------------------------------------------------------------
-- distribution_windows (§49.11)
-- ---------------------------------------------------------------------------
CREATE TABLE distribution_windows (
  distribution_id        TEXT PRIMARY KEY,
  state                  distribution_state NOT NULL DEFAULT 'OPEN',

  window_start           TIMESTAMPTZ NOT NULL,
  window_end             TIMESTAMPTZ NOT NULL,

  -- Read at snapshot (§16.3). 80% becomes distributable, 20% is buffer.
  pool_snapshot          token_amount,
  distributable          token_amount,

  total_qualified_weight NUMERIC(78, 0),
  qualified_wallets      INTEGER CHECK (qualified_wallets >= 0),

  -- Versions the allocation so a historical distribution stays reproducible
  -- after the algorithm changes (§66.4).
  algorithm_version      TEXT,

  merkle_root            TEXT,
  publication_tx         TEXT,
  published_at           TIMESTAMPTZ,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- §16.2: the window is exactly 24 hours.
  CONSTRAINT distribution_window_is_24_hours
    CHECK (window_end = window_start + INTERVAL '24 hours'),

  -- §16.3: distributable is exactly 80% of the snapshot, floored. Stated as
  -- arithmetic rather than trusted from the caller.
  CONSTRAINT distribution_is_eighty_percent
    CHECK (
      pool_snapshot IS NULL
      OR distributable = FLOOR(pool_snapshot * 8000 / 10000)
    ),

  -- §17: a published distribution has a root and a transaction. A root without
  -- a transaction is a claim nobody can make.
  CONSTRAINT distribution_published_is_complete
    CHECK (
      state <> 'PUBLISHED' AND state <> 'CLOSED'
      OR (merkle_root IS NOT NULL AND publication_tx IS NOT NULL
          AND published_at IS NOT NULL)
    )
);

COMMENT ON CONSTRAINT distribution_is_eighty_percent ON distribution_windows IS
  'Section 16.3 fixes the split at 80/20. Computing it in the check means an engine that miscalculates cannot record the wrong distributable amount.';

CREATE UNIQUE INDEX distribution_windows_start_unique ON distribution_windows (window_start);
CREATE UNIQUE INDEX distribution_windows_root_unique ON distribution_windows (merkle_root)
  WHERE merkle_root IS NOT NULL;

-- ---------------------------------------------------------------------------
-- reward_allocations (§49.11)
-- ---------------------------------------------------------------------------
CREATE TABLE reward_allocations (
  distribution_id        TEXT NOT NULL REFERENCES distribution_windows (distribution_id),
  wallet                 evm_address NOT NULL REFERENCES wallet_profiles (wallet),

  window_war_points      INTEGER NOT NULL CHECK (window_war_points >= 50),
  weight                 NUMERIC(78, 0) NOT NULL CHECK (weight > 0),

  amount                 token_amount NOT NULL,
  carried_forward        token_amount NOT NULL DEFAULT 0,
  capped                 BOOLEAN NOT NULL DEFAULT FALSE,
  state                  reward_allocation_state NOT NULL DEFAULT 'CALCULATED',

  merkle_leaf            TEXT,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One allocation per wallet per distribution.
  PRIMARY KEY (distribution_id, wallet),

  -- §16.7: an amount is either claimable or carried forward, never split
  -- between the two. Both non-zero would mean the wallet was counted twice.
  CONSTRAINT allocation_is_claimable_or_carried
    CHECK (NOT (amount > 0 AND carried_forward > 0))
);

COMMENT ON COLUMN reward_allocations.window_war_points IS
  'Section 16.4 sets the qualification floor at 50 window War Points. The CHECK means an unqualified wallet cannot be allocated at all, rather than being allocated zero.';

CREATE INDEX reward_allocations_by_wallet_idx ON reward_allocations (wallet, created_at DESC);
CREATE INDEX reward_allocations_claimable_idx ON reward_allocations (distribution_id)
  WHERE state = 'PUBLISHED';

-- ---------------------------------------------------------------------------
-- reward_claims (§16.8, §17)
-- ---------------------------------------------------------------------------
-- Claiming is user-driven and happens on chain. These rows record what the
-- indexer observed, not what the backend authorised.
CREATE TABLE reward_claims (
  distribution_id        TEXT NOT NULL,
  wallet                 evm_address NOT NULL,

  amount                 token_amount NOT NULL CHECK (amount > 0),
  claim_tx               TEXT NOT NULL,
  block_number           BIGINT NOT NULL CHECK (block_number > 0),
  claimed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Brief §13: one claim per entitlement per distribution. The contract
  -- enforces this on chain; recording it here means a reorg that replays the
  -- event cannot double-count in our own accounting.
  PRIMARY KEY (distribution_id, wallet),

  FOREIGN KEY (distribution_id, wallet)
    REFERENCES reward_allocations (distribution_id, wallet)
);

CREATE UNIQUE INDEX reward_claims_tx_unique ON reward_claims (claim_tx);

-- ---------------------------------------------------------------------------
-- reward_carry_forward (§16.7)
-- ---------------------------------------------------------------------------
-- Amounts below the minimum claim threshold roll into the next window rather
-- than being forfeited. Tracked per wallet so a player can see it accumulate.
CREATE TABLE reward_carry_forward (
  wallet                 evm_address PRIMARY KEY REFERENCES wallet_profiles (wallet),
  amount                 token_amount NOT NULL DEFAULT 0,
  last_distribution_id   TEXT REFERENCES distribution_windows (distribution_id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
