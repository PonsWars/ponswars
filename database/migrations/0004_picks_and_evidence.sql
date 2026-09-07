-- 0004 — Player picks, battle input evidence and finalized results.
--
-- Masterplan §12 (score engine), §25 (crash recovery), §26 (audit evidence),
-- §49.8–49.9, §71.

BEGIN;

-- ---------------------------------------------------------------------------
-- player_picks (§49.8)
-- ---------------------------------------------------------------------------
CREATE TABLE player_picks (
  wallet                 evm_address NOT NULL REFERENCES wallet_profiles (wallet),
  round_id               TEXT NOT NULL REFERENCES rounds (round_id),
  battle_id              TEXT NOT NULL REFERENCES battles (battle_id),

  backed_ticker          TEXT NOT NULL,
  card_decision          card_decision NOT NULL DEFAULT 'SAVE',

  -- Bumped on every mutation during Pick Phase, so a retry that arrives out of
  -- order cannot overwrite a newer decision (§3.1).
  revision               INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),

  -- The client's idempotency key (§66.6). A dropped response cannot produce a
  -- second pick, because the retry carries the same key.
  client_request_id      TEXT NOT NULL,

  -- Server-trusted timestamps (§47.5). The client is not asked when it picked.
  received_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Frozen at lock. Until then the row above is still mutable.
  locked_at              TIMESTAMPTZ,
  locked_battle_id       TEXT REFERENCES battles (battle_id),
  locked_ticker          TEXT,
  locked_card_decision   card_decision,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Brief §13 and §49.8: one pick per wallet per round, as a constraint rather
  -- than a convention. A race between two tabs cannot produce two picks.
  PRIMARY KEY (wallet, round_id),

  CONSTRAINT picks_lock_is_complete
    CHECK (
      locked_at IS NULL
      OR (locked_battle_id IS NOT NULL AND locked_ticker IS NOT NULL
          AND locked_card_decision IS NOT NULL)
    )
);

COMMENT ON CONSTRAINT picks_lock_is_complete ON player_picks IS
  'A locked pick records every field it was locked with. A half-written lock would leave the engine guessing what the player actually chose.';

CREATE UNIQUE INDEX picks_idempotency
  ON player_picks (wallet, round_id, client_request_id);
CREATE INDEX picks_by_battle_idx ON player_picks (battle_id);
CREATE INDEX picks_locked_by_battle_idx ON player_picks (locked_battle_id)
  WHERE locked_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- battle_input_snapshots (§26)
-- ---------------------------------------------------------------------------
-- The lock-time snapshot a replay starts from. Hashes rather than raw feeds:
-- §49.13 allows high-frequency ticks to be compacted once durable replay
-- evidence exists, and these hashes are that evidence.
CREATE TABLE battle_input_snapshots (
  battle_id              TEXT PRIMARY KEY REFERENCES battles (battle_id),

  lock_timestamp         TIMESTAMPTZ NOT NULL,
  price_sample_hash      TEXT NOT NULL,
  volume_snapshot_hash   TEXT NOT NULL,
  pons_snapshot_hash     TEXT NOT NULL,
  card_aggregation_hash  TEXT NOT NULL,

  -- Card support is a fixed snapshot taken at lock (§23.1), stored in tenths
  -- so the whole support pipeline stays in integer arithmetic (§66.4).
  left_card_support_tenths   BIGINT NOT NULL DEFAULT 0 CHECK (left_card_support_tenths >= 0),
  right_card_support_tenths  BIGINT NOT NULL DEFAULT 0 CHECK (right_card_support_tenths >= 0),

  left_feed_health       feed_health NOT NULL,
  right_feed_health      feed_health NOT NULL,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- battle_tick_evidence (§25, §26)
-- ---------------------------------------------------------------------------
-- Per-tick checkpoints. §25 requires the engine to recover from a restart, and
-- §26 requires enough evidence to reproduce a battle. Both are the same rows.
CREATE TABLE battle_tick_evidence (
  battle_id              TEXT NOT NULL REFERENCES battles (battle_id),
  tick_sequence          INTEGER NOT NULL CHECK (tick_sequence >= 0),

  observed_at            TIMESTAMPTZ NOT NULL,
  left_score_scaled      BIGINT NOT NULL,
  right_score_scaled     BIGINT NOT NULL,
  frontline_scaled       INTEGER NOT NULL CHECK (frontline_scaled BETWEEN 0 AND 1000000),
  left_feed_health       feed_health NOT NULL,
  right_feed_health      feed_health NOT NULL,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (battle_id, tick_sequence)
);

COMMENT ON TABLE battle_tick_evidence IS
  'Authoritative per-second state. Never served to clients during a live battle: sections 24 and 48.3 keep the exact score hidden until finalization.';

-- ---------------------------------------------------------------------------
-- battle_results (§49.9)
-- ---------------------------------------------------------------------------
-- Immutable after finalization. A trigger enforces it, because "we agreed not
-- to update this table" is not a guarantee.
CREATE TABLE battle_results (
  battle_id              TEXT PRIMARY KEY REFERENCES battles (battle_id),
  round_id               TEXT NOT NULL REFERENCES rounds (round_id),

  left_ticker            TEXT NOT NULL,
  right_ticker           TEXT NOT NULL,
  winner_ticker          TEXT NOT NULL,

  -- Scaled points, 1e6 per point, matching @ponswars/battle-math. Integer, so
  -- a stored result and a replayed one compare exactly (§66.4).
  left_price_scaled          BIGINT NOT NULL CHECK (left_price_scaled >= 0),
  left_volume_scaled         BIGINT NOT NULL CHECK (left_volume_scaled >= 0),
  left_pons_scaled           BIGINT NOT NULL CHECK (left_pons_scaled >= 0),
  left_card_scaled           BIGINT NOT NULL CHECK (left_card_scaled >= 0),
  right_price_scaled         BIGINT NOT NULL CHECK (right_price_scaled >= 0),
  right_volume_scaled        BIGINT NOT NULL CHECK (right_volume_scaled >= 0),
  right_pons_scaled          BIGINT NOT NULL CHECK (right_pons_scaled >= 0),
  right_card_scaled          BIGINT NOT NULL CHECK (right_card_scaled >= 0),

  victory                victory_label NOT NULL,
  tiebreak               tiebreak_step,

  scoring_engine_version TEXT NOT NULL,
  evidence_hash          TEXT NOT NULL,
  finalized_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT results_winner_is_a_participant
    CHECK (winner_ticker IN (left_ticker, right_ticker)),

  -- §12: the four components sum to exactly 100 points. At 1e6 scale that is
  -- 100000000. A result that does not add up never reaches the table.
  CONSTRAINT results_total_is_one_hundred_points
    CHECK (
      left_price_scaled + left_volume_scaled + left_pons_scaled + left_card_scaled
      + right_price_scaled + right_volume_scaled + right_pons_scaled + right_card_scaled
      = 100000000
    ),

  -- §12: no component may steal weight from another.
  CONSTRAINT results_price_component_is_45
    CHECK (left_price_scaled + right_price_scaled = 45000000),
  CONSTRAINT results_volume_component_is_25
    CHECK (left_volume_scaled + right_volume_scaled = 25000000),
  CONSTRAINT results_pons_component_is_20
    CHECK (left_pons_scaled + right_pons_scaled = 20000000),
  CONSTRAINT results_card_component_is_10
    CHECK (left_card_scaled + right_card_scaled = 10000000)
);

COMMENT ON CONSTRAINT results_total_is_one_hundred_points ON battle_results IS
  'Section 12 fixes the battle at 100 points across 45/25/20/10. These five checks make a miscomputed score unstorable rather than merely wrong.';

CREATE INDEX battle_results_by_round_idx ON battle_results (round_id);
CREATE INDEX battle_results_by_winner_idx ON battle_results (winner_ticker, finalized_at DESC);

-- §49.9: immutable after finalization, except explicit incident metadata —
-- of which this table has none, so no update is legitimate.
CREATE OR REPLACE FUNCTION battle_results_are_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'battle_results is immutable after finalization (masterplan 49.9); battle % cannot be modified',
    OLD.battle_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER battle_results_no_update
  BEFORE UPDATE OR DELETE ON battle_results
  FOR EACH ROW EXECUTE FUNCTION battle_results_are_immutable();

COMMIT;
