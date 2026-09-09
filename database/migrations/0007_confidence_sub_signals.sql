-- 0007 — The four qualitative sub-signals behind a confidence label.
--
-- Masterplan §10.2 (sub-signals), §10.3 (frozen at lock), §27.5 (intel panel).
--
-- `battles` stored `left_confidence` and `right_confidence` as labels, which
-- was everything the engine had when it was written. §10 is now implemented and
-- the engine carries a whole `ConfidenceSnapshot` — the label plus the four
-- words the intel panel draws — so the store could no longer hold what it is
-- given, and a round read back would have lost the panel.
--
-- Still no numbers. §10 forbids an exact probability and Guide §7.1 lists one
-- as a mockup error; the standing that ranks two sides is computed from these
-- and never stored, so there is nothing here for anyone to render as a
-- percentage.
--
-- The columns are NOT NULL with no default, which means this applies only to an
-- empty `battles` table. That is true today — nothing is deployed — and it is
-- the honest choice: a default would invent a sub-signal for battles that were
-- fought without one, and a panel showing invented intel beside a real label is
-- worse than a migration that has to be run before the first round.

BEGIN;

-- §10.2's vocabularies, one enum each. Separate types rather than one shared
-- three-value enum because they are different scales that happen to have three
-- points: a `WEAK` volume pulse and a `WEAK` price trend are not the same fact,
-- and a single type would let a mistake in one column pass as valid in another.
CREATE TYPE price_trend_signal AS ENUM ('STRONG', 'MIXED', 'WEAK');
CREATE TYPE volume_pulse_signal AS ENUM ('RISING', 'NORMAL', 'WEAK');
CREATE TYPE pons_activity_signal AS ENUM ('HIGH', 'MEDIUM', 'LOW');
CREATE TYPE momentum_stability_signal AS ENUM ('STABLE', 'MIXED', 'UNSTABLE');

ALTER TABLE battles
  ADD COLUMN left_price_trend         price_trend_signal        NOT NULL,
  ADD COLUMN left_volume_pulse        volume_pulse_signal       NOT NULL,
  ADD COLUMN left_pons_activity       pons_activity_signal      NOT NULL,
  ADD COLUMN left_momentum_stability  momentum_stability_signal NOT NULL,
  ADD COLUMN right_price_trend        price_trend_signal        NOT NULL,
  ADD COLUMN right_volume_pulse       volume_pulse_signal       NOT NULL,
  ADD COLUMN right_pons_activity      pons_activity_signal      NOT NULL,
  ADD COLUMN right_momentum_stability momentum_stability_signal NOT NULL;

COMMENT ON COLUMN battles.left_price_trend IS
  'Section 10.2 sub-signal, snapshotted with the label at round open and frozen at lock. NOT NULL because a label without the signals it was computed from cannot be shown, and a panel that fell back to a default would disagree with the word beside it.';

COMMIT;
