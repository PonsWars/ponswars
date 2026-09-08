# Security policy

## Current state, so you know what you are looking at

Nothing here is deployed. There are no live contracts, no running services, no
funds at risk today, and **the contracts have not been independently audited** —
that review is step 19 of the build plan and has not happened.

That is worth knowing before you spend time on this: a finding today is a
finding against code that can still be changed cheaply, which is the best time
to make one, and the worst time to expect a bounty. There is no bug bounty
programme.

## Reporting a vulnerability

**Do not open a public issue for a security finding.**

Use GitHub's private vulnerability reporting on this repository — the **Report a
vulnerability** button under the Security tab. It opens a private thread visible
only to the maintainers.

Please include enough to reproduce: the file and line, what an attacker gains,
and the smallest input that demonstrates it. A proof-of-concept test against the
existing suites is the most useful form; `pnpm run verify` runs everything.

## What is in scope

The parts where a defect costs someone money or breaks the guarantee the product
is built on:

- **`contracts/`** — `RewardsDistributor` and `SecretStockVault`. Anything that
  lets committed or reserved funds move, lets a claim happen twice, or lets a
  proof authorise a payout that was never in the tree.
- **`packages/rewards-math`** — the allocation procedure and the Merkle tree.
  Conservation, the per-wallet cap, the qualification floor, and the encoding
  agreement between TypeScript and Solidity.
- **`packages/battle-math`** and **`packages/battle-engine`** — determinism and
  the integrity of a result. A path where the same recorded inputs produce two
  different outcomes, or where a result can be produced without the evidence it
  claims to be reproducible from.
- **`packages/genesis-service`** — Genesis RNG integrity, one claim per wallet,
  and the rule that a Secret is never revealed before its reward is reserved.
- **`packages/realtime`** — anything that lets a client be told something the
  server did not say, or lets a private channel be read without owning the
  wallet.

## What is out of scope

- **Missing services.** The HTTP server, WebSocket gateway, database and RPC
  clients do not exist yet; every transport choice is still open. "There is no
  authentication middleware" is a description of the current state, not a
  finding.
- **The seeded placeholder data in `apps/web`.** The wallet fragment, the round,
  the balances and the finalized battle in the web client are local fixtures for
  the prototype. They are not a data source and are not claimed to be.
- **Dependency advisories with no exploitable path here.** A report that names a
  CVE in a transitive dependency without showing how it is reachable is a
  dependency update, and those are welcome as ordinary pull requests.
- **`ponswars_dev_only`** in `infra/containers/docker-compose.yml`. It is a
  local development password for a container that binds to localhost, and it is
  named so nobody mistakes it for anything else.

## Things worth attacking first

If you want the highest-value targets, these are the invariants the design
depends on, each enforced somewhere you can read:

1. A claim is exactly-once against an immutable published root, and a failed
   transaction never mutates the entitlement.
2. Committed and reserved funds cannot be withdrawn by an admin, and a
   reservation cannot be reassigned.
3. The exact battle score is unreachable before finalization — not hidden by a
   condition, but absent from the types the client can see.
4. A round with no scorable data voids rather than producing a result.
5. Replaying a recorded round reproduces its evidence hash exactly, and altering
   any recorded input changes it.

If you can break one of those, that is the report worth writing.
