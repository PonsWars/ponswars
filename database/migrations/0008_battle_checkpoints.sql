-- 0008 — The rest of what a restart needs to resume a battle.
--
-- Masterplan §25 (crash recovery, exactly-once), §26 (audit evidence), §13
-- (momentum), §12.6 (hard cutoff).
--
-- `battle_tick_evidence` already describes itself as the per-tick checkpoint
-- §25 recovers from, and it stored the outputs: sequence, both scores, the
-- frontline and feed health. What it did not store is everything else the
-- engine holds — the momentum memory, the running evidence digest, and the last
-- observation each side was scored from. A process restarting from these rows
-- would have resumed with a fresh momentum window, a broken evidence chain and
-- no last-known inputs, which is a different battle that happens to have the
-- same score.
--
-- The engine's own type says it plainly: "Everything §25 requires in a
-- checkpoint: state, score, momentum memory, sequence and the running evidence
-- digest. Serialising this and restoring it resumes the battle exactly where it
-- stopped." These columns are what makes that sentence true.

BEGIN;

ALTER TABLE battle_tick_evidence
  -- §13.3 reads a comeback from the largest advantage a side has held, so the
  -- peaks are memory rather than a derived reading — a restart that reset them
  -- would label a recovery as an ordinary lead.
  ADD COLUMN momentum_peak_left  BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN momentum_peak_right BIGINT  NOT NULL DEFAULT 0,
  -- The previous tick's advantage, which velocity is measured against (§13.2).
  ADD COLUMN momentum_previous   BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN momentum_ticks      INTEGER NOT NULL DEFAULT 0 CHECK (momentum_ticks >= 0),

  -- The running digest at this tick (§26). A fold over everything applied so
  -- far, so it cannot be recomputed from a single row and has to be carried.
  ADD COLUMN evidence_hash       TEXT,

  -- The observation each side was last scored from (§12.6).
  --
  -- JSONB, and this is the one place in the schema that is. These are the
  -- engine's scoring inputs — nine values a side, including a four-part card
  -- aggregate — and giving each a column would make every change to §12's
  -- inputs a migration on a table that already carries the audit trail. They
  -- are versioned by the `scoring_engine_version` recorded with the result,
  -- which is what makes an old row still readable by the engine that wrote it.
  --
  -- Scaled integers cross as JSON strings on purpose: a `bigint` written as a
  -- JSON number would round past 2^53 and a replayed battle would diverge from
  -- the one that was fought (§66.4).
  ADD COLUMN left_inputs         JSONB,
  ADD COLUMN right_inputs        JSONB;

COMMENT ON COLUMN battle_tick_evidence.evidence_hash IS
  'Section 26: the running digest at this tick. Nullable only because rows written before this migration cannot have one; every row the engine writes now carries it.';

COMMENT ON COLUMN battle_tick_evidence.left_inputs IS
  'Section 12.6: the last observation scored, so a restart resumes from the same window rather than an empty one. JSONB because these are the scoring inputs themselves, versioned by scoring_engine_version rather than by the column list.';

COMMIT;
