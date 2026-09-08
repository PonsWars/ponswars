# A round will not finalize

**Deciding sections:** §22 the round state machine, §25 finalization, §66.6
idempotency, §4.4 VOID, §3 timing.

## First, establish which state it is actually in

`PREPARING → PICK_OPEN → LOCKING → BATTLE_LIVE → FINALIZING → FINALIZED`, with a
`VOID` branch out of every non-terminal state (§22). `ROUND_STATE_TRANSITIONS`
in `@ponswars/shared-types` is the authority, and it is data rather than
scattered conditionals precisely so an incident can read it.

A round that "will not finalize" is usually in one of three situations, and they
need opposite responses:

| Symptom                                 | What it is                              | What to do                           |
| --------------------------------------- | --------------------------------------- | ------------------------------------ |
| `BATTLE_LIVE` past the cutoff           | Finalization has not been attempted     | Attempt it                           |
| `FINALIZING` and not moving             | Finalization is blocked on something    | Find the block; do not retry blindly |
| `FINALIZED` but clients still show live | A delivery problem, not a round problem | See the realtime path below          |

The third is the common one and the least dangerous. Check it first.

## It is finalized and clients disagree

The round is done. Nothing about the result is at risk.

Clients that missed the `ROUND_FINALIZED` event recover on their own: a
sequence gap makes them stop applying incremental updates and fetch a snapshot
(§70.7), and the snapshot carries the finalized state. A client that has been
disconnected long enough shows its own reconnect banner.

If many clients are stuck simultaneously, the incident is the gateway, not the
round.

## It is live and past the cutoff

§12.6 makes the scoring cutoff hard: data after `battleEndAt` is excluded
whatever happens next. So a delayed finalization does not change the result — it
delays a result that is already determined by the data inside the window.

Finalize it. `finalizeRound` is exactly-once and the state machine refuses a
second attempt (§25, §66.6), so the risk of running it is not duplication.

If finalization throws, read what it threw. A round with no scorable tick in a
battle produces a VOID for that battle, and that is the engine working.

## It is finalizing and blocked

Do not retry in a loop. Finalization writes War Points and is guarded by
idempotency keys, but a retry storm against a blocked dependency turns one
incident into two.

Find what it is waiting on. The likely candidates:

- the finalization block hash (§13.6) — the chain, not the engine
- the evidence bundle write (§26)
- the awards write

Each has a different answer, and none of them is "skip it". A result published
without its evidence cannot be reproduced, which makes §26's promise false for
that round permanently.

## When to void deliberately

§4.4 and §22 allow VOID out of any non-terminal state. Void when the round
cannot produce a legitimate result — not when it is merely inconvenient.

Legitimate reasons: required data never arrived, the feed was compromised, a
halt made a battle unscoreable, matchmaking produced an invalid schedule.

Not reasons: the round is late, an operator is unsure, the result is surprising.

A VOID refunds deployed cards and records no loss. It costs one round out of a
hundred and forty-four a day, and it is always cheaper than a result nobody can
defend.

## What never happens

- **A second finalization.** The state machine refuses it, and the refusal is
  tested. Do not work around it.
- **An edited result.** §25 makes a finalized result immutable. A wrong result
  is investigated and disclosed, and corrected — if at all — in what comes after
  it, never in place.
- **An extended battle window.** §12.6's cutoff is what makes every spectator's
  view of the same battle the same battle.
