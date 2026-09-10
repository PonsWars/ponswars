-- 0009 — Wallet authentication: challenges and sessions.
--
-- Masterplan §45.2 (wallet authentication), §69.4–69.5 (the two endpoints),
-- §49 (database model).
--
-- Two tables holding two properties that cannot live in application code.
--
--   1. A nonce is single-use. Not "usually", and not "unless two requests
--      arrive at once" — a check-then-write across several server processes is
--      a race, and the race is the replay this whole flow exists to stop. It is
--      a conditional UPDATE against a primary key here, which the database
--      settles for everyone.
--
--   2. A session can be revoked. §45.2 asks for revocation after suspicious
--      behaviour, and a stateless token cannot be withdrawn — it is valid until
--      it expires no matter what anybody learns in the meantime.
--
-- Neither table stores a credential as issued. The session token exists in the
-- response that carried it and in the client that holds it; what is here is a
-- SHA-256 fingerprint, so a leaked backup or a query in a log is not a set of
-- live sessions.

BEGIN;

-- ---------------------------------------------------------------------------
-- auth_challenges (§69.4)
-- ---------------------------------------------------------------------------
-- Issued, then answered once or never. Rows are short-lived by construction:
-- everything here expires within minutes and is pruned afterwards.
CREATE TABLE auth_challenges (
  nonce       TEXT        PRIMARY KEY,
  wallet      evm_address NOT NULL,
  chain_id    BIGINT      NOT NULL CHECK (chain_id > 0),

  -- The exact message that was issued. Verification compares the client's copy
  -- against this one before reading a single field out of it, so a message that
  -- differs anywhere — including in a field nothing checks — is refused.
  message     TEXT        NOT NULL,

  issued_at   TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,

  -- NULL until answered. The single-use rule is `UPDATE ... WHERE used_at IS
  -- NULL`, so exactly one caller can ever see the transition.
  used_at     TIMESTAMPTZ,

  CONSTRAINT auth_challenge_expires_after_issue CHECK (expires_at > issued_at)
);

COMMENT ON TABLE auth_challenges IS
  'Section 69.4 sign-in challenges. Single-use: consumption is a conditional UPDATE on used_at, never a read followed by a write, because two requests carrying the same nonce is the attack rather than an edge case.';

COMMENT ON COLUMN auth_challenges.message IS
  'The EIP-4361 message as issued. The server verifies against this rather than against whatever the client says it signed.';

-- Pruning reads by age, and nothing else ever does.
CREATE INDEX auth_challenges_by_expiry_idx ON auth_challenges (expires_at);

-- ---------------------------------------------------------------------------
-- auth_sessions (§45.2)
-- ---------------------------------------------------------------------------
CREATE TABLE auth_sessions (
  -- SHA-256 of the bearer token, hex. The token itself is never stored: this
  -- column is what a lookup arrives with, and holding the real value would make
  -- every backup a set of working credentials.
  token_fingerprint TEXT        PRIMARY KEY,
  wallet            evm_address NOT NULL,
  chain_id          BIGINT      NOT NULL CHECK (chain_id > 0),

  issued_at         TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,

  -- Set on sign-out, on rotation, and by an operator ending a session early
  -- (§45.2). A row is live only while this is NULL and the expiry is ahead.
  revoked_at        TIMESTAMPTZ,

  CONSTRAINT auth_session_expires_after_issue CHECK (expires_at > issued_at)
);

COMMENT ON TABLE auth_sessions IS
  'Section 45.2 sessions. Server-side rather than a stateless token, because a stateless token cannot be revoked: it stays valid until it expires no matter what is learned in between.';

COMMENT ON COLUMN auth_sessions.revoked_at IS
  'Sign-out, rotation, or an operator ending a session. Kept rather than deleted so that a revocation is a fact with a time on it.';

-- Ending every session a wallet holds — the revocation §45.2 asks for after
-- suspicious behaviour — is a scan by wallet, and there is no other index that
-- would serve it.
CREATE INDEX auth_sessions_by_wallet_idx ON auth_sessions (wallet, issued_at DESC);
CREATE INDEX auth_sessions_by_expiry_idx ON auth_sessions (expires_at);

COMMIT;
