-- 0011 — The block hash a chain-derived tiebreak was decided by.
--
-- Masterplan §12.7 (tiebreak order), §26 (a result is reproducible from what
-- was published), §49.9 (results are immutable).
--
-- §12.7's last step breaks a dead heat with a finalized Robinhood Chain block
-- hash and the battle id. `battle_results.tiebreak` already names the step, but
-- the hash was nowhere: the evidence chain covers the market ticks, not the
-- chain, so a battle the chain decided could be announced and never checked.
--
-- The column is written in the same insert as the rest of the result, so the
-- immutability trigger from 0004 covers it too. The constraint makes the two
-- columns agree: a hash exactly when the chain decided, and never a hash on a
-- result the market decided.

BEGIN;

ALTER TABLE battle_results
  ADD COLUMN tiebreak_block_hash TEXT;

ALTER TABLE battle_results
  ADD CONSTRAINT results_chain_tiebreak_names_its_block
    CHECK (
      (tiebreak IS NOT DISTINCT FROM 'chainDerived') = (tiebreak_block_hash IS NOT NULL)
    ),
  ADD CONSTRAINT results_tiebreak_block_hash_is_a_block_hash
    CHECK (tiebreak_block_hash ~ '^0x[0-9a-f]{64}$');

COMMENT ON COLUMN battle_results.tiebreak_block_hash IS
  'Section 12.7: the finalized Robinhood Chain block hash that broke a dead heat. Present exactly when tiebreak is chainDerived.';

COMMIT;
