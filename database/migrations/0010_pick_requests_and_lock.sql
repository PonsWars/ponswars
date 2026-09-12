-- 0010 — Pick request idempotency, and the instant a round's picks froze.
--
-- Masterplan §4.2 (one pick per wallet per round), §22 (no change after lock),
-- §47.5 (the pick API), §66.6 (idempotency).
--
-- `player_picks` holds one row per wallet per round and replaces it on every
-- change, so it can only ever remember the *current* request's key. That is
-- not enough for §66.6. A player who picks LEFT, then changes to RIGHT, and
-- whose first request is retried by a flaky connection after the second, must
-- keep RIGHT: the retry is a replay of a request that has already been applied,
-- not a new decision. Knowing that needs every key a wallet has used in a
-- round, which is what `pick_requests` is.
--
-- And a round needs to say, in the database, that its picks are frozen. The
-- API checks the phase before it writes, but that check and the loop's lock are
-- two moments; a write that lands between them would be stored against a round
-- whose engine never saw it. `picks_locked_at` is set by the same transaction
-- that reads the frozen set, and every pick write checks it under a lock that
-- transaction also takes.

BEGIN;

CREATE TABLE pick_requests (
  wallet                 evm_address NOT NULL REFERENCES wallet_profiles (wallet),
  round_id               TEXT NOT NULL REFERENCES rounds (round_id),
  client_request_id      TEXT NOT NULL,

  -- What the request stored, so a replay can answer with it.
  battle_id              TEXT NOT NULL REFERENCES battles (battle_id),
  backed_ticker          TEXT NOT NULL,
  card_decision          card_decision NOT NULL,
  received_at            TIMESTAMPTZ NOT NULL,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Scoped to the wallet and the round. A key is the client's to generate, and
  -- a key another wallet happened to use says nothing about this one.
  PRIMARY KEY (wallet, round_id, client_request_id)
);

COMMENT ON TABLE pick_requests IS
  'Section 66.6: every pick request applied, so a late retry of a superseded request is recognised as a replay rather than written over the decision that replaced it.';

ALTER TABLE rounds ADD COLUMN picks_locked_at TIMESTAMPTZ;

COMMENT ON COLUMN rounds.picks_locked_at IS
  'Section 22: when this round''s picks were read and frozen for the engine. Pick writes are refused once it is set.';

COMMIT;
