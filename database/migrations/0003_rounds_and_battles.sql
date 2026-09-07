-- 0003 — Rounds, matchups and battles.
--
-- Masterplan §3 (timing), §4.3 (matchmaking), §22 (state machine), §49.6–49.7.

BEGIN;

-- ---------------------------------------------------------------------------
-- rounds (§49.6)
-- ---------------------------------------------------------------------------
CREATE TABLE rounds (
  round_id               TEXT PRIMARY KEY,
  state                  round_state NOT NULL DEFAULT 'PREPARING',

  -- The canonical clock (§23.5). Server time is authoritative; a client
  -- projects its countdown from these and never the reverse.
  pick_open_at           TIMESTAMPTZ NOT NULL,
  lock_at                TIMESTAMPTZ NOT NULL,
  battle_end_at          TIMESTAMPTZ NOT NULL,

  -- Matchmaking evidence (§4.3, §26). Anyone holding these can recompute the
  -- five pairings and confirm they were not chosen to favour anyone.
  matchmaking_seed       TEXT NOT NULL,
  matchmaking_version    TEXT NOT NULL,

  -- Populated only on the failure branch (§22).
  void_reason            void_reason_category,
  incident_note          TEXT,

  finalized_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- §3: lock is exactly one minute after pick open, and the battle ends exactly
  -- ten minutes after it. Encoding the locked timing here means a scheduler bug
  -- fails the insert instead of running a mistimed round in production.
  CONSTRAINT rounds_pick_phase_is_one_minute
    CHECK (lock_at = pick_open_at + INTERVAL '1 minute'),
  CONSTRAINT rounds_lasts_ten_minutes
    CHECK (battle_end_at = pick_open_at + INTERVAL '10 minutes'),
  CONSTRAINT rounds_void_has_reason
    CHECK (state <> 'VOID' OR void_reason IS NOT NULL),
  CONSTRAINT rounds_finalized_has_timestamp
    CHECK (state <> 'FINALIZED' OR finalized_at IS NOT NULL)
);

COMMENT ON CONSTRAINT rounds_lasts_ten_minutes ON rounds IS
  'Section 3 locks the round at ten minutes with a one-minute pick phase. A scheduler that drifts fails here rather than shipping a mistimed round.';

-- Rounds are globally synchronized (§3): no two may overlap.
CREATE UNIQUE INDEX rounds_pick_open_unique ON rounds (pick_open_at);
CREATE INDEX rounds_state_idx ON rounds (state) WHERE state <> 'FINALIZED';
CREATE INDEX rounds_recent_idx ON rounds (pick_open_at DESC);

-- ---------------------------------------------------------------------------
-- battles (§49.7)
-- ---------------------------------------------------------------------------
CREATE TABLE battles (
  battle_id              TEXT PRIMARY KEY,
  round_id               TEXT NOT NULL REFERENCES rounds (round_id),

  -- Staging positions, not advantages. Sectors are neutral and reused; no
  -- faction owns one (§38.3).
  left_ticker            TEXT NOT NULL,
  right_ticker           TEXT NOT NULL,
  sector_id              TEXT NOT NULL,

  state                  battle_state NOT NULL DEFAULT 'SCHEDULED',

  -- Battle Confidence, snapshotted when the round opened and frozen at lock
  -- (§10.3). Stored as labels because §10 forbids an exact probability, and a
  -- numeric column would be an invitation to render one.
  left_confidence        confidence_label NOT NULL,
  right_confidence       confidence_label NOT NULL,

  data_health            feed_health NOT NULL DEFAULT 'HEALTHY',
  void_reason            void_reason_category,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- §4.3: self-match is impossible.
  CONSTRAINT battles_no_self_match CHECK (left_ticker <> right_ticker),
  CONSTRAINT battles_void_has_reason
    CHECK (state <> 'VOID' OR void_reason IS NOT NULL)
);

-- §4.3: each stock appears exactly once per round. Two partial indexes cover
-- both sides, and a ticker cannot occupy the same side twice either.
CREATE UNIQUE INDEX battles_left_once_per_round ON battles (round_id, left_ticker);
CREATE UNIQUE INDEX battles_right_once_per_round ON battles (round_id, right_ticker);
CREATE UNIQUE INDEX battles_sector_once_per_round ON battles (round_id, sector_id);

CREATE INDEX battles_by_round_idx ON battles (round_id);
CREATE INDEX battles_live_idx ON battles (state) WHERE state = 'LIVE';

-- ---------------------------------------------------------------------------
-- round_matchup_history (§4.3)
-- ---------------------------------------------------------------------------
-- The unordered matchup key for each battle, so the two-round cooldown is a
-- lookup rather than a scan over both ticker columns.
CREATE TABLE round_matchup_history (
  round_id               TEXT NOT NULL REFERENCES rounds (round_id),
  matchup_key            TEXT NOT NULL,
  battle_id              TEXT NOT NULL REFERENCES battles (battle_id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (round_id, matchup_key)
);

CREATE INDEX round_matchup_history_recent_idx
  ON round_matchup_history (matchup_key, created_at DESC);

COMMIT;
