-- 0014 — A claim is identified by its log, and a reader remembers where it got to.
--
-- Masterplan §17 (publication and claims), §35.6, §49.11.
--
-- `reward_claims` has been here since 0005, waiting for something to read the
-- chain into it. Two changes make it match what a reader actually sees:
--
-- **A transaction can carry more than one claim.** The unique index on
-- `claim_tx` said otherwise. `RewardsDistributor.claim` is one distribution at
-- a time, but nothing stops a wallet batching two of them through a multicall
-- contract, and a reader recording the second would have failed on an index
-- rather than recorded a claim that really happened. The identity of a claim
-- is its log: the transaction and the index within it.
--
-- **A reader needs a position.** `indexer_cursors` is its own table because it
-- will have company: the market indexer and the Pons indexer read the same
-- chain and will want the same thing.

BEGIN;

ALTER TABLE reward_claims
  ADD COLUMN log_index INTEGER NOT NULL DEFAULT 0 CHECK (log_index >= 0);

COMMENT ON COLUMN reward_claims.log_index IS
  'Index of the Claimed log within its transaction. With claim_tx it identifies the event, so a range re-read records nothing new.';

COMMENT ON COLUMN reward_claims.claimed_at IS
  'When the reader recorded the claim, not when the block was made: a block timestamp costs a read per block and nothing here is decided by this instant.';

DROP INDEX reward_claims_tx_unique;

CREATE UNIQUE INDEX reward_claims_event_unique ON reward_claims (claim_tx, log_index);

-- How far a chain reader has read, by name.
CREATE TABLE indexer_cursors (
  name          TEXT PRIMARY KEY,
  block_number  BIGINT NOT NULL CHECK (block_number >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE indexer_cursors IS
  'Section 49.11: where each chain reader has read to. Moved forward only — a reader that restarts re-reads rather than rewinding the record of what has been read.';

COMMIT;
