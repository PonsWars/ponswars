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

## Running the windows on time

The two steps with no judgement in them — opening each window where the last
one ended and snapshotting it at its close — are a job that runs continuously:

```bash
node apps/server/dist/rewards-worker.js --snapshots /var/lib/ponswars/snapshots
```

It reads `DATABASE_URL`, `RPC_URL`, `CHAIN_ID`, `REWARDS_DISTRIBUTOR_ADDRESS`
and `REWARDS_MINIMUM_CLAIM` (base units, §16.7 — it records the number in every
snapshot and never invents one). The pool is the distributor's uncommitted
balance, read at the snapshot.

**It stops at the snapshot file, deliberately.** Calculating and publishing
each have a check in front of them below, and a scheduler that ran ahead would
automate past the two steps that exist to be read by somebody. §17 makes a
published root immutable.

A worker that was down for a day opens the window it owes, starting where the
last one ended: windows stay contiguous (§16.2), so the late one is a late
window rather than a gap nobody could earn points in. The commands below are
still the way to run a window by hand, and the two ways do not conflict — the
job reads the state that is there.

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
the moment you run this.** The server reads Robinhood Chain for tiebreaks and
`$WAR` balances, but not for the pool balance yet, so it is still read by hand
at the snapshot. When that is automated, it supplies this one number and the
step is otherwise unchanged. Both amounts are base units: whole numbers, no
decimal point, which is why the command refuses one.

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

## Calculating the window

```bash
node apps/server/dist/distribution.js calculate --id 42 --minimum-claim <base units>
```

Use the same minimum claim the snapshot file carries. In one transaction it runs
the allocation on the War Points the snapshot claimed, writes every qualified
wallet's allocation — paid, with its Merkle leaf and proof, or carried forward —
and records the root. It prints the root. A window is calculated once; a second
run is refused, because what the first produced may already be on chain.

If no wallet is above the minimum claim, there is no root: nothing is published
and the whole pool carries forward (§16.7).

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

## Publishing

```bash
RPC_URL=… CHAIN_ID=46630 REWARDS_DISTRIBUTOR_ADDRESS=0x… DISTRIBUTION_PUBLISHER_KEY=0x… \
  node apps/server/dist/distribution.js publish --id 42 --expect-root <root verify printed>
```

`--expect-root` is required: it is the root `verify-distribution` reproduced,
and the job refuses if the calculated root is anything else. Before sending, it
also refuses when:

- the RPC endpoint is not the `CHAIN_ID` Robinhood Chain network;
- the key does not hold `DISTRIBUTION_PUBLISHER_ROLE`;
- the distributor's **uncommitted** SPY is less than the root's total — a root
  the distributor cannot pay is one whose claims revert. Fund it first.

The contract enforces that last rule too, so it holds on every path: a
`publishDistribution` whose total the uncommitted balance cannot cover reverts
with `InsufficientUncommittedBalance`. The job's own check is early warning. The
contract's check is the guarantee — on the multisig path the job only prints a
proposal, and by the time the signers execute it the SPY it saw may already be
committed to another window. **Fund before proposing, and expect the
transaction to revert if it is no longer there.**

It reads the root and total back from the contract and records those. If the id
is already on chain with this root — a publication that landed before the
database heard of it — it records that instead of publishing twice. If the id is
on chain with a different root, the id is spent: stop, and treat it as an
incident.

Publishing from a multisig: leave `DISTRIBUTION_PUBLISHER_KEY` unset. The job
prints the root and total to propose as `publishDistribution(id, root, total)`,
and running it again after the transaction lands records it.

## After publication

**The root is immutable.** §17: admin may not edit individual rewards after
publication, and `RewardsDistributor` stores the root as immutable with an
`outstandingCommitment` that keeps the committed SPY outside the treasury's
reach from the moment it is published.

So an error discovered after publication has exactly one remedy: disclose it,
and correct it in a later window. There is no mechanism to do otherwise and
building one would break the promise the immutability is there to make.

## Claims

A signed-in player sees each published allocation on the Rewards page with its
claimed status read from the contract, and claims it from their own wallet: the
page checks the wallet is the signed-in account and on Robinhood Chain, then
sends `claim` with the stored proof. The server never sends a claim.

The user-facing flow is `READY_TO_CLAIM → CONFIRM IN WALLET → SUBMITTING →
CONFIRMED` (§35.6).

A failed claim transaction **never** touches the entitlement. The allocation is
a published Merkle leaf; a rejected wallet signature, an out-of-gas, a dropped
transaction — none of them has any bearing on it. The player returns to
`READY_TO_CLAIM` and tries again, and the copy says so: _"Your allocation is
still available. Try again."_

Claims are exactly-once against the root (§45.10). A double-claim attempt is
rejected on chain, not by the client.

**The server reads claims back.** It follows the distributor's `Claimed` events
every thirty seconds from where it last read — the position is in
`indexer_cursors` — and records them in `reward_claims`. Nothing waits on that
read: the claims page asks the record first and the contract only about a claim
the reader has not seen yet, so a reward claimed a second ago never reads as
unclaimed. A claim with no allocation behind it is dropped; another
deployment's distribution on the same contract says nothing about this one's
players.

To see where the reader is:

```sql
SELECT * FROM indexer_cursors WHERE name = 'reward-claims';
```

A reader that has fallen behind costs nothing but freshness. Deleting its
cursor row makes it read the distributor's whole history again, which is safe:
a claim already recorded is recorded once.

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
