# A disputed result

**Deciding sections:** §26 evidence and reproducibility, §25 immutability, §12
the score, §45.4 RNG integrity, §61 principle 20 auditability.

Someone says a battle was scored wrongly, or that a Genesis outcome was not
fair. This is the case the evidence system was built for, so the answer is a
procedure rather than a judgement.

## Do not start by defending the result

Start by reproducing it. A result that reproduces is a fact; a result that does
not is an incident far larger than the complaint that surfaced it.

## Reproducing a battle

1. **Fetch the recording** for the round. It holds every input the engine
   consumed and nothing it produced — seed, clock, confidence snapshot, picks,
   the ordered tick log, and the engine tuning that was in force
   (`@ponswars/replay`).
2. **Replay it.**

   ```bash
   pnpm run build && node tools/replay-round.mjs round.json
   ```

   This prints each battle's score, winner, victory label and evidence hash. It
   runs the same code path production ran, under the tuning the recording
   carries — the tuning is part of the record precisely so a replay cannot be
   run under calibration the round never saw.

3. **Compare the evidence hash**, not just the winner:

   ```bash
   node tools/replay-round.mjs round.json --expect <battleId>=<hash>
   ```

   Exits non-zero on any mismatch, so it can be run from a script and believed.
   §26's promise is the hash: identical inputs produce an identical chained
   hash, and a matching winner with a differing hash means the inputs diverged
   somewhere the outcome happened not to notice.

If it reproduces, the dispute is about the rules, not the execution — go to
"explaining a result" below.

If it does not reproduce, stop and escalate. Either the recording is incomplete
or the engine is not deterministic, and both are serious. Do not finalize any
further rounds until you know which.

## Explaining a result

The result screen already shows the working: both sides' four components, the
victory label, the tiebreak step if one ran, the scoring engine version and the
evidence hash. Most disputes are answered by reading it back.

The four components are fixed weights (§12.2): price momentum, relative volume,
Pons power, holder card support, summing to 100 across both sides. Cards tilt
and cannot replace market signal (§61 principle 4) — a player who backed the
"obviously better" stock and lost usually lost on relative volume, which is
measured against that ticker's own expected volume rather than against its
opponent's raw share count.

If the totals tied, a named tiebreak step decided it (§12.7). Say which one.
A result decided by a documented rule stops looking arbitrary the moment the
rule is named.

## A disputed Genesis outcome

§45.4 governs RNG integrity, §76 the derivation.

The Genesis RNG is deterministic from a domain-separated seed, so a specific
wallet's outcome is recomputable. Two things to check that are easy to miss:

- **Which rarity table was in force.** A card opened while the Secret vault was
  dormant was drawn against `RARITY_TABLE_SECRET_DISABLED` — Legendary `2.0%`,
  Secret `0%` (§8.3). The table version is recorded on the outcome (§76.3)
  precisely so this is answerable rather than arguable.
- **Card selection uses its own stream.** §76.4 gives card choice a separate
  domain from rarity, so a player reasoning "the rarity roll must have decided
  the card too" is reasoning about a different stream.

## What a correction looks like

§25 makes a finalized result immutable, and the round state machine refuses a
second finalization. So a confirmed error is not fixed in place. It is:

1. reproduced and documented, with the round id and evidence hash
2. disclosed — §61 principle 24 forbids silent changes to locked rules, and the
   same standard applies to a wrong result
3. corrected forward, in a later window if it affected rewards

That is less satisfying than editing the record, and it is the reason the record
can be trusted at all.

## What never happens

- **A quiet re-finalization.** The state machine refuses it; do not route
  around it.
- **An edited evidence bundle.** The hash is the whole guarantee.
- **A per-wallet adjustment inside a published distribution.** §17. Correct it
  in the next one.
- **Changing a scoring weight to make a past result look right.** §66.8 forbids
  hidden gameplay constants and §110.3 forbids secretly altering score weights.
  A weight change is a versioned, disclosed decision that applies going forward.
