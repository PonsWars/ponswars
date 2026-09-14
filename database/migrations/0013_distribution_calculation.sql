-- 0013 — What a distribution was calculated with, and each claim's proof.
--
-- Masterplan §16.7 (minimum claim), §17 (publication and claims), §49.11.
--
-- A calculated window records the minimum claim it applied. The threshold
-- decides who is paid this window and who carries forward, so a window whose
-- threshold is not on record could not be recalculated to check it.
--
-- Each claimable allocation stores its Merkle leaf and proof as calculated.
-- The tree's order is part of the root, and a proof recomputed later from rows
-- read back in some other order would verify against nothing. Storing what was
-- published is the only way the proof a player is handed is the proof the
-- contract will accept.

BEGIN;

ALTER TABLE distribution_windows
  ADD COLUMN minimum_claim token_amount CHECK (minimum_claim >= 0),
  ADD CONSTRAINT distribution_calculated_has_threshold
    CHECK (state IN ('OPEN', 'SNAPSHOT') OR minimum_claim IS NOT NULL);

ALTER TABLE reward_allocations
  ADD COLUMN merkle_proof JSONB,
  ADD CONSTRAINT allocation_claimable_has_its_proof
    CHECK ((amount > 0) = (merkle_leaf IS NOT NULL AND merkle_proof IS NOT NULL)),
  ADD CONSTRAINT allocation_leaf_is_a_hash
    CHECK (merkle_leaf ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT allocation_proof_is_a_list
    CHECK (merkle_proof IS NULL OR jsonb_typeof(merkle_proof) = 'array');

COMMENT ON COLUMN reward_allocations.merkle_proof IS
  'Section 17: the proof for this allocation''s leaf, as calculated for the published root. Present exactly when the amount is claimable.';

COMMIT;
