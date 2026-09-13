-- 0012 — Genesis requests bound to their block from the start, and claims that
-- cannot change.
--
-- Masterplan §6 (one claim per wallet), §9 (future finalized block entropy),
-- §76.1 (no other block may be selected), §49.3 (claims).
--
-- 0002 allowed a request to exist without its target block, which left room
-- for the target to be chosen once its hash was already visible — exactly the
-- reroll §76.1 forbids. A request now carries its target from the moment it is
-- written, and the hash, once there, is a real 32-byte hash.
--
-- Genesis numbers (`#008271`) come from a sequence, so they are assigned by the
-- database in the order claims land and two claims cannot share one.
--
-- A claim is the record of a card a wallet was dealt. §9 makes it un-rerollable,
-- so nothing may update or delete one; the trigger makes that a property of the
-- table rather than of whichever code happens to be writing to it.

BEGIN;

ALTER TABLE genesis_requests
  ALTER COLUMN entropy_target_block SET NOT NULL,
  ADD CONSTRAINT genesis_request_target_is_a_block
    CHECK (entropy_target_block > 0),
  ADD CONSTRAINT genesis_request_hash_is_a_block_hash
    CHECK (entropy_block_hash ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT genesis_request_committed_at_with_hash
    CHECK ((entropy_block_hash IS NULL) = (committed_at IS NULL));

COMMENT ON COLUMN genesis_requests.entropy_target_block IS
  'Section 76.1: the future block whose finalized hash seeds this request. Set when the request is written and never changed.';

CREATE SEQUENCE genesis_number_seq AS BIGINT START WITH 1 MINVALUE 1 NO CYCLE;

CREATE OR REPLACE FUNCTION genesis_claims_are_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'genesis_claims is immutable (masterplan 9, 76.1); claim % cannot be modified',
    OLD.genesis_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER genesis_claims_no_update
  BEFORE UPDATE OR DELETE ON genesis_claims
  FOR EACH ROW EXECUTE FUNCTION genesis_claims_are_immutable();

COMMIT;
