# Market data degraded or lost

**Deciding sections:** §23.6 feed health, §23.7 cross-checks, §23.8 corporate
actions and halts, §12.6 the scoring cutoff, §4.4 VOID.

## The four states, and what each one means

`HEALTHY → DEGRADED → STALE → UNAVAILABLE` (§23.6).

The line that matters sits between the second and the third. **`DEGRADED` data
is late but real, and a battle scored on it is a legitimate battle.** `STALE`
and `UNAVAILABLE` are not slower versions of the same thing — they are the
absence of data, and a battle cannot be scored on absence.

The engine already draws this line. `tickBattle` ignores a tick whose feed
health is not usable, and a battle that reaches its cutoff with no scorable tick
voids rather than reporting a zero-zero draw. If you find yourself reaching for
a manual override to "let the round complete", stop: that is the fabrication
§61 principle 19 exists to prevent, and the simulation has a test asserting the
engine refuses it.

## What players see

A `DEGRADED` public feed health reaches the client and the HUD says **MARKET
DATA DELAYED** (§23.6, §42.14). It does not say which vendor is failing — the
public health enum has two values for that reason.

The round continues. Say so, and do not pause anything the engine is willing to
score.

## If it degrades

1. Record the round id and the affected tickers.
2. Confirm the engine is still receiving scorable ticks for both sides of every
   battle. A one-sided feed is the dangerous case: the battle is still scoring,
   and one side's momentum is frozen.
3. If one side is unscorable and the other is not, that battle voids. It is not
   a fair battle and finishing it would produce a result decided by an outage.
4. Do not extend the battle window. §12.6 makes the cutoff hard, and data
   arriving after it is excluded by definition — a battle extended to wait for a
   feed is a battle scored on a different window than the one it was sold as.

## If it fails completely

Every affected battle voids. Unaffected battles in the same round continue —
they are separate battles with separate evidence, and voiding all five because
one ticker's vendor failed punishes four sets of players for nothing.

Voided battles refund the deployed card and record no loss (§4.4, §11).

## A halt or a corporate action

§23.8 is explicit that a halt **must not** be treated as ordinary flat price
action. A halted stock is not a stock that happened not to move; scoring it as
though it were hands its opponent a win produced by an exchange decision.

- **Before the round opens:** the asset can be substituted. This is the cheap
  case — do it.
- **During a battle:** the battle may VOID under integrity policy. Do not let it
  run to a result.

Splits and multipliers must be normalized _before_ return calculations. A split
that reaches the scoring path unnormalized reads as a catastrophic price move,
and the battle will be decided by an accounting event.

## If the two sources disagree

§23.7: abnormal divergence triggers data-health protection rather than silently
picking a winner from suspicious data. Divergence is not a tie to be broken by
preferring the primary — it is a signal that one of them is wrong and you do not
yet know which.

## Afterwards

Replay the round from its recording (§26). A degradation incident is one of the
few where the replay is genuinely informative: it shows exactly which ticks the
engine accepted and which it ignored, and whether the VOID was the right call
under the data that actually arrived.
