# Rewards distribution

**Deciding sections:** §16 the distribution, §17 publication and claims, §35 the
hub UX, §44 treasury, §44.5 role separation, §45.10 exactly-once.

## The sequence

`OPEN → SNAPSHOT → CALCULATED → PUBLISHED → CLOSED` (§16.2, §17).
`DISTRIBUTION_TRANSITIONS` in `@ponswars/shared-types` is the authority, and it
has no backwards edges.

Each step is a point of no return in a different way:

- **SNAPSHOT** fixes the pool balance and the qualified set. Everything after is
  arithmetic on numbers chosen here.
- **CALCULATED** produces the allocations. Reproducible from the snapshot, so
  this step can be re-run and compared.
- **PUBLISHED** puts the Merkle root on chain. **From here nothing can change.**
- **CLOSED** ends claiming against that window. Unclaimed rewards are never
  swept (`RewardsDistributor` has a test named for it).

## Opening a window

A window opens at an instant the operator chooses and lasts exactly 24 hours
(§16.2). One is open at a time, and an identifier is never reused — the claim
contract commits to it inside every Merkle leaf, so it is a whole number.

```bash
node apps/server/dist/distribution.js open --id 42 --start 2026-09-14T00:00:00Z
```

The start must carry its timezone. An instant without one is midnight wherever
the shell happens to be, and a day of players lands in the wrong window.

War Points earned before a window opens are not lost: they belong to whichever
window's snapshot claims them first.

## Taking the snapshot

```bash
node apps/server/dist/distribution.js snapshot --id 42 --pool-balance <base units> --minimum-claim <base units> --out snapshot-42.json
```

It refuses a window whose 24 hours are not over. Otherwise, in one transaction,
it claims every War Point no earlier snapshot claimed, fixes the pool balance
and the 80% split, records who qualified, and writes `snapshot-42.json` — the
exact input the next step recomputes from. It will not overwrite an existing
file, and it claims the file before touching the database, so a snapshot is
never taken without its standings landing on disk.

**The pool balance is read by you, from the Rewards Distribution wallet, at
the moment you run this.** Nothing reads the chain yet (§59.3 leaves the RPC
provider open). When something does, it supplies this one number and the step
is otherwise unchanged. Both amounts are base units: whole numbers, no decimal
point, which is why the command refuses one.

## Before the snapshot

The snapshot is the moment the pool balance is read. §35.3 says the UI may show
a current pool figure with the explicit caveat that the final distributable
amount comes from the actual balance at snapshot — so a balance that moves
between a player reading it and the snapshot is expected, not an incident.

Check before snapshotting:

- The funding for this window has settled. §44.7 makes funding manual, and a
  transfer in flight at snapshot time is simply not in this window.
- No round is mid-finalization whose War Points belong to this window. A round
  finalizing across the boundary is the one genuine ordering hazard here, and
  §45.8 names boundary-time races as a threat category.

## Between calculation and publication

This is the only window where an error is cheap. Use it.

The allocation is deterministic (`allocateDistribution` in
`@ponswars/rewards-math`): the same snapshot produces the same allocations, the
same weights, the same cap redistribution. Re-run it and compare before
publishing:

```bash
pnpm run build && node tools/verify-distribution.mjs snapshot.json
```

Add `--expect-root <hash>` to compare against the root you are about to publish.
It exits non-zero on any problem, so it can be run from a script and believed.

The snapshot it reads is what the window is calculated _from_ — pool balance,
minimum claim, and every wallet's window War Points. A snapshot carrying
allocations is refused, because a file holding the answer could "verify" it by
handing it back.

Everything below is checked by that command; the list is here so you know what
it is asserting rather than trusting the exit code alone:

- **Conservation.** Allocations plus carry-forward equal the distributable
  amount. The simulation asserts a full window settles without creating or
  losing SPY.
- **The cap.** No wallet exceeds 2% of the pool (§16.6), and capped excess is
  redistributed rather than kept.
- **The floor.** Wallets below `MIN_QUALIFYING_WP` are absent, not present with
  zero.
- **The tree.** Every allocation verifies against the root. The generated
  fixture proves the TypeScript and Solidity Merkle implementations agree
  ([ADR 0006](../adr/0006-cross-language-conformance-by-generated-fixture.md)),
  but that proves the encoding, not this tree.

## After publication

**The root is immutable.** §17: admin may not edit individual rewards after
publication, and `RewardsDistributor` stores the root as immutable with an
`outstandingCommitment` that keeps the committed SPY outside the treasury's
reach from the moment it is published.

So an error discovered after publication has exactly one remedy: disclose it,
and correct it in a later window. There is no mechanism to do otherwise and
building one would break the promise the immutability is there to make.

## Claims

The user-facing flow is `READY_TO_CLAIM → CONFIRM IN WALLET → SUBMITTING →
CONFIRMED` (§35.6).

A failed claim transaction **never** touches the entitlement. The allocation is
a published Merkle leaf; a rejected wallet signature, an out-of-gas, a dropped
transaction — none of them has any bearing on it. The player returns to
`READY_TO_CLAIM` and tries again, and the copy says so: _"Your allocation is
still available. Try again."_

Claims are exactly-once against the root (§45.10). A double-claim attempt is
rejected on chain, not by the client.

## Below the minimum claim threshold

The allocation carries forward into the next window (§16.7, §35.5). **It is not
lost**, and the UI says the words — a small number with no explanation reads as
a reward that quietly vanished.

The threshold itself is `BASELINE, not locked` in
[`../OPEN_PARAMETERS.md`](../OPEN_PARAMETERS.md). The masterplan's `0.001 SPY`
is an example still to be confirmed, and the constant is named
`MIN_CLAIM_THRESHOLD_BASELINE_DECIMAL` so nothing reads it as settled.

## Role separation

§44.5 and §61 principle 21: no single ordinary hot key controls every critical
permission. The distributor separates publication from withdrawal, and the
contract tests assert the roles are distinct.

If an incident tempts you to consolidate roles to move faster, that is the
moment the separation was for.

## What never happens

- **Editing a published allocation.** §17. The contract refuses.
- **Sweeping unclaimed rewards.** They stay claimable with no expiry.
- **Withdrawing committed funds.** `uncommittedBalance` is the only withdrawable
  amount and the contract computes it, not the operator.
- **Showing an estimated payout during an open window.** §35.2 is a hard UX
  rule, and the client enforces it structurally — the active window shape has no
  allocation field at all.
