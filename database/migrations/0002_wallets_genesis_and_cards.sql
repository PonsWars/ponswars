-- 0002 — Wallet profiles, Genesis claims, cards and the card usage ledger.
--
-- Masterplan §6 (eligibility), §7 (pool and usage), §9 (RNG), §49.2–49.5.

BEGIN;

-- ---------------------------------------------------------------------------
-- wallet_profiles (§49.2)
-- ---------------------------------------------------------------------------
-- The wallet is the primary key of a player. There are no usernames and no
-- accounts to create — a spectator becomes a player by connecting (§5).
CREATE TABLE wallet_profiles (
  wallet                 evm_address PRIMARY KEY,
  first_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Cached aggregates. §49.2 requires these to be rebuildable from the
  -- authoritative ledgers, so they are a read optimisation and never a source
  -- of truth. A reconciliation job recomputes them from wp_ledger and
  -- battle_results.
  genesis_claimed        BOOLEAN     NOT NULL DEFAULT FALSE,
  lifetime_battles       INTEGER     NOT NULL DEFAULT 0 CHECK (lifetime_battles >= 0),
  lifetime_wins          INTEGER     NOT NULL DEFAULT 0 CHECK (lifetime_wins >= 0),
  lifetime_upsets        INTEGER     NOT NULL DEFAULT 0 CHECK (lifetime_upsets >= 0),
  lifetime_war_points    BIGINT      NOT NULL DEFAULT 0 CHECK (lifetime_war_points >= 0),

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT wallet_wins_within_battles CHECK (lifetime_wins <= lifetime_battles),
  CONSTRAINT wallet_upsets_within_wins CHECK (lifetime_upsets <= lifetime_wins)
);

COMMENT ON CONSTRAINT wallet_wins_within_battles ON wallet_profiles IS
  'A wallet cannot win more battles than it played. Catches a double-counted win at write time rather than in a support ticket.';

-- ---------------------------------------------------------------------------
-- genesis_requests (§47.4, §9)
-- ---------------------------------------------------------------------------
-- The request is permanent and precedes the outcome. Its id is part of the RNG
-- seed, which is what makes a result un-rerollable: a retry reuses the same
-- request and therefore the same card.
CREATE TABLE genesis_requests (
  request_id             TEXT PRIMARY KEY,
  wallet                 evm_address NOT NULL REFERENCES wallet_profiles (wallet),
  state                  genesis_request_state NOT NULL DEFAULT 'PENDING',

  -- Entropy commitment: the block the outcome will be derived from, chosen
  -- before its hash exists (§9).
  entropy_target_block   BIGINT,
  entropy_block_hash     TEXT,

  requested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT genesis_request_commit_has_hash
    CHECK (state <> 'COMMITTED' OR entropy_block_hash IS NOT NULL)
);

-- A wallet may hold at most one request that is still in flight. Two live
-- requests would be two chances at a card §6 grants once.
CREATE UNIQUE INDEX genesis_requests_one_open_per_wallet
  ON genesis_requests (wallet)
  WHERE state IN ('PENDING', 'COMMITTED');

-- ---------------------------------------------------------------------------
-- genesis_claims (§49.3)
-- ---------------------------------------------------------------------------
CREATE TABLE genesis_claims (
  genesis_id             TEXT PRIMARY KEY,

  -- Brief §13: one Genesis claim per wallet, enforced by the database rather
  -- than by an application check that a race can slip past.
  wallet                 evm_address NOT NULL UNIQUE REFERENCES wallet_profiles (wallet),
  request_id             TEXT NOT NULL UNIQUE REFERENCES genesis_requests (request_id),

  -- Everything needed to recompute the outcome (§9, §26).
  seed                   TEXT NOT NULL,
  slot                   INTEGER NOT NULL CHECK (slot >= 0 AND slot < 1000000),
  secret_available       BOOLEAN NOT NULL,
  rarity                 card_rarity NOT NULL,
  card                   card_type NOT NULL,
  initial_uses           SMALLINT NOT NULL CHECK (initial_uses > 0),

  -- Versions the derivation so a future change does not make historical claims
  -- unverifiable (§66.4).
  rng_version            TEXT NOT NULL,

  finalized_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- §8.3: a SECRET result is only reachable while the vault is funded. A row
  -- claiming otherwise means the coverage check was bypassed.
  CONSTRAINT genesis_secret_requires_coverage
    CHECK (rarity <> 'SECRET' OR secret_available)
);

COMMENT ON CONSTRAINT genesis_secret_requires_coverage ON genesis_claims IS
  'Section 8.3: Secret is unreachable while the vault is uncovered. A row with SECRET and secret_available = false means the reserve-before-reveal ordering was violated.';

CREATE INDEX genesis_claims_rarity_idx ON genesis_claims (rarity);

-- ---------------------------------------------------------------------------
-- cards (§49.4)
-- ---------------------------------------------------------------------------
CREATE TABLE cards (
  card_instance_id       TEXT PRIMARY KEY,

  -- One card per wallet, forever (§6). The uniqueness on genesis_claims.wallet
  -- already implies it; stating it here means neither table alone can be wrong.
  wallet                 evm_address NOT NULL UNIQUE REFERENCES wallet_profiles (wallet),
  genesis_id             TEXT NOT NULL UNIQUE REFERENCES genesis_claims (genesis_id),

  rarity                 card_rarity NOT NULL,
  card                   card_type NOT NULL,
  initial_uses           SMALLINT NOT NULL CHECK (initial_uses > 0),
  remaining_uses         SMALLINT NOT NULL CHECK (remaining_uses >= 0),
  depleted_at            TIMESTAMPTZ,

  -- §6: Genesis Cards are non-transferable and are not tradable NFTs in V1.
  -- A column that can only be FALSE is not redundant here: it makes the rule
  -- visible to anyone reading the schema and impossible to set by accident.
  transferable           BOOLEAN NOT NULL DEFAULT FALSE CHECK (transferable = FALSE),

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cards_remaining_within_initial CHECK (remaining_uses <= initial_uses),
  CONSTRAINT cards_depleted_when_exhausted
    CHECK ((remaining_uses = 0) = (depleted_at IS NOT NULL))
);

COMMENT ON CONSTRAINT cards_depleted_when_exhausted ON cards IS
  'depleted_at is set exactly when the last charge is spent. Keeps the flag and the counter from disagreeing about whether a card is spent.';

-- ---------------------------------------------------------------------------
-- card_usage_ledger (§49.5)
-- ---------------------------------------------------------------------------
-- Append-only. A charge is never decremented silently: every change to
-- remaining_uses has a row here explaining it.
CREATE TABLE card_usage_ledger (
  entry_id               BIGSERIAL PRIMARY KEY,
  card_instance_id       TEXT NOT NULL REFERENCES cards (card_instance_id),
  wallet                 evm_address NOT NULL REFERENCES wallet_profiles (wallet),
  round_id               TEXT NOT NULL,
  battle_id              TEXT NOT NULL,
  event                  card_usage_event NOT NULL,

  -- +1 for a refund, -1 for a deploy. A correction states its own delta and
  -- must carry a reason.
  delta                  SMALLINT NOT NULL CHECK (delta <> 0),
  reason                 TEXT,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT card_usage_correction_needs_reason
    CHECK (event <> 'CORRECTION' OR reason IS NOT NULL),
  CONSTRAINT card_usage_deploy_spends_one
    CHECK (event <> 'DEPLOY' OR delta = -1),
  CONSTRAINT card_usage_refund_restores_one
    CHECK (event <> 'VOID_REFUND' OR delta = 1)
);

-- Brief §13: one card deployment per wallet per round. Without this a retried
-- lock could spend two charges for one battle.
CREATE UNIQUE INDEX card_usage_one_deploy_per_wallet_round
  ON card_usage_ledger (wallet, round_id)
  WHERE event = 'DEPLOY';

-- §4.4: a refund is idempotent. A retried VOID must not hand back a second
-- charge.
CREATE UNIQUE INDEX card_usage_one_refund_per_wallet_battle
  ON card_usage_ledger (wallet, battle_id)
  WHERE event = 'VOID_REFUND';

CREATE INDEX card_usage_by_card_idx ON card_usage_ledger (card_instance_id, created_at);

COMMIT;
