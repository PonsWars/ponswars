# PonsWars

A persistent, explorable spatial war world driven by real market data.

Ten stock factions fight five simultaneous battles every ten minutes. Players
spend the first minute picking a side and deciding whether to spend a Genesis
Card charge, then watch nine minutes of battle whose outcome is decided entirely
by market behaviour — price momentum, relative volume and on-chain Pons
activity. Real SPY rewards settle on chain every 24 hours.

## Source of truth

The product rules come from a set of planning documents kept privately: the
PonsWars Masterplan v1.4, a kickoff brief, a visual implementation guide, a
design-token specification, and an art-direction pack of generated references.
When they disagree, the masterplan decides.

**None of them is published here.** The masterplan carries the treasury wallet
topology (§44.4) and the complete security threat model (§45); the visual pack
is unreleased art direction. Neither belongs in a public repository before an
independent contract review and launch. Afterwards transparency is the point —
§61 requires reward allocations to be auditable and reproducible — but until
then the security section reads more like a map for an attacker than evidence of
good faith.

That is a deliberate split rather than a gap. Every rule those documents fix is
implemented here and cited by section number at the point it is enforced, so
this codebase is readable on its own. What is not published is the record of how
each rule was decided, not the rule.

One consequence is worth stating plainly, because it shaped a lot of this code:
the generated PNGs in that pack are art direction and several contain
attractive but **non-canonical** mechanics — a live exact battle score,
staggered battle scheduling, an active-window reward estimate. Each is called
out in this repository at the point where the code refuses to implement it.

## Architecture in one line

> Realtime gameplay is offchain and authoritative. Value settlement is onchain.

The frontend never decides a winner. Admin never decides a winner. Only the
Battle Engine does, from recorded evidence, exactly once.

## Repository layout

```
apps/         web, api, battle-engine, market-data-service,
              pons-indexer, realtime-gateway, rewards-worker, admin-console
packages/     shared-types, config, and the shared libraries services build on
contracts/    RewardsDistributor, SecretStockVault
database/     migrations, seeds, fixtures
simulations/  deterministic replay, historical scenarios, load
tools/        replay, merkle, rng-audit, asset-pipeline, treasury-audit
docs/         ADRs, open-parameter registry, operations
```

## Packages

| Package                                           | Holds                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`@ponswars/shared-types`](packages/shared-types) | Every **LOCKED** constant and the domain types that cross a process boundary          |
| [`@ponswars/config`](packages/config)             | Every **OPEN** parameter, validated at startup with no defaults                       |
| [`@ponswars/battle-math`](packages/battle-math)   | Deterministic matchmaking, the battle score engine, winner resolution and Genesis RNG |
| [`@ponswars/rewards-math`](packages/rewards-math) | The 24-hour allocation procedure and the Merkle tree behind on-chain claims           |

The split is deliberate and is the subject of
[ADR 0002](docs/adr/0002-locked-constants-versus-open-configuration.md).
Locked values are product policy and change only through a masterplan revision.
Open values are undecided or environment-specific, and masterplan §102 forbids
inventing one and shipping it as policy — so nothing in `packages/config` has a
default, and startup fails with the complete list of what is missing.

## Getting started

Requires Node 22+ and pnpm 10+.

```bash
pnpm install
```

```bash
cp .env.example .env
```

`.env.example` is generated from the parameter table and every value in it is a
deliberately non-functional placeholder. See
[`docs/OPEN_PARAMETERS.md`](docs/OPEN_PARAMETERS.md) for what each still needs
decided.

## Verification

One gate covers everything:

```bash
pnpm run verify
```

It runs formatting, type-aware linting, a build typecheck, a test-project
typecheck, the full test suite, and a check that `.env.example` is still in sync
with the config table. Nothing in it is piped, so a failing tool fails the gate.

## Working rules

- **Do not redesign the game while implementing it.** If implementation reveals
  a conflict, name it, propose the smallest compatible fix, and mark any
  material rule change as needing a masterplan revision. Never replace a rule
  silently in code.
- **No hidden gameplay constants.** No weight, threshold, rarity range or reward
  rule may live as an unexplained number, least of all in client code (§66.8).
- **Never synthesize a result to keep the UI moving.** Missing or failed data
  degrades explicitly or voids the battle. It never becomes a fresh, empty, safe
  or complete state.
- **Money is never a float.** Integer base units and `bigint` throughout; see
  [ADR 0003](docs/adr/0003-integer-arithmetic-for-value-bearing-math.md).

## Contracts

Two V1 contracts (§19), built and tested with Foundry:

- **`RewardsDistributor`** — Merkle claims against immutable published roots.
  Admin can withdraw only uncommitted funds, and a published window's SPY is
  outside the treasury's reach from the moment it is published.
- **`SecretStockVault`** — the fixed Secret reward, reserved before the reveal.
  Reserved SPY cannot be withdrawn or reassigned, and pausing never erases an
  entitlement.

`foundry.toml` lives at the repository root so solc can read OpenZeppelin from
`node_modules`; forge-std is a submodule, so clone with
`git submodule update --init --recursive`.

## Status

**Milestone 0 — requirements freeze: complete.** Canonical constants and types,
the open-parameter registry, the enforced configuration contract, the toolchain
and the verification gate.

**Milestone 1 — simulation and contracts foundation: complete.** Deterministic
matchmaking and scoring, Genesis RNG with an audit path, the reward allocation
procedure, the PostgreSQL schema, both contracts with 57 Foundry tests, and a
generated fixture proving the TypeScript and Solidity Merkle code agree
([ADR 0006](docs/adr/0006-cross-language-conformance-by-generated-fixture.md)).

**Milestone 2 — core services: logic complete, transports pending.** The
deterministic core of every service in Kickoff Brief §18 is built and tested:
market-data ingestion, Pons qualification, the Genesis lifecycle, the battle
engine and round orchestration, and the realtime protocol. Each is a pure
reducer, so the same code runs in production, in a test and in a replay.

What is **not** built is the runnable `apps/*` shells that wire those cores to
real transports — an HTTP server, a WebSocket server, PostgreSQL, an RPC client,
a market-data vendor. Every one of those choices is still `OPEN` in
[`docs/OPEN_PARAMETERS.md`](docs/OPEN_PARAMETERS.md), and §102 forbids picking
one and shipping it as policy. The cores are shaped to be wired in when the
decisions land.

**Milestone 3 — spatial frontend: complete.** One persistent world scene, a
camera that reaches every level of §37.2 by pan, zoom, pinch, tap and `ESC`, and
a HUD whose contents are decided by the zoom budget rather than by each panel.
The three presentations — Commander Profile, Rewards and Genesis — layer over
that world at `/profile`, `/rewards` and `/genesis` without ever unmounting it,
which is what §80.4 requires; the canvas is mounted once in the shell, outside
every route branch, so no route has the power to tear it down.

Four rules the frontend enforces structurally rather than by care:

- **No live score.** `ClientBattle` has no score field and
  `PublicBattleStateUpdate` has a type test pinning its key set, so the number
  §12.5 hides is not reachable from a component at all. Three of the delivered
  mockups show one.
- **No estimated SPY during an open window.** `RewardView`'s active variant has
  no allocation field, so §35.2's hard rule is a fact about the data rather than
  a condition someone can delete.
- **Reserve before reveal.** A Secret is never named until the vault reservation
  is confirmed (§8.4) — an unreserved reveal script simply has no revealing step
  to reach.
- **A failed claim never touches the entitlement.** §35.6's `FAILED` returns to
  `READY_TO_CLAIM` and nowhere else.

What the client still lacks is a server to talk to. Round state, picks, wallet
and allocations are seeded locally, because the API host, the WebSocket
endpoint, the RPC provider and the market-data vendor are all still `OPEN` in
[`docs/OPEN_PARAMETERS.md`](docs/OPEN_PARAMETERS.md), and §102 forbids picking
one and shipping it as policy. Every seeded value passes through the same types
and the same reducers the real feed will.

Design tokens are transcribed into `@ponswars/ui-tokens` from the design-token
specification, with a test asserting the stylesheet and the typed constants
agree value by value. The gaps that specification still leaves open are tracked
privately alongside it.

**Milestone 4 — flows, replay and runbooks: complete.** The full
Pick → Card → Live Battle → Result sequence of execution-order step 15 and the
Profile / Rewards / Secret claim flows of step 16, plus the two parts of steps 17
and 18 that do not need a running transport, plus the runbooks of step 20.

- **Replay** (§26). A round records every input the engine consumed and nothing
  it produced, and replays to an identical evidence hash. The recorder is a thin
  wrapper over the replayer rather than a second implementation, and the tests
  that matter are the ones expecting divergence: altering one tick's window
  return changes that battle's hash, and a different base seed produces
  different pairings. Without those, the happy-path assertions would pass
  against an engine that ignored its inputs.
- **Chaos** (§49, §70.7, §66.6). Redelivery, reordering, gaps, snapshot
  recovery, five minutes of clock skew, a second finalization attempt, and a
  round whose feed never delivered a scorable tick. The assertion is never that
  the system survives — it is that it does not fabricate.
- **Runbooks** ([`docs/operations/`](docs/operations/)). What to do when the
  feed degrades, a round will not finalize, the Secret vault runs dry, a
  distribution needs publishing, or a result is disputed — and, more often the
  point, what never to do.

There is no `as never`, `as any`, `@ts-ignore`, `@ts-expect-error` or ESLint
suppression anywhere in the repository, and no skipped test.

## What is blocked, and on what

Everything remaining in §60's execution order waits on a decision rather than on
implementation. Listed so the blocking decision is visible rather than buried:

| Step                                     | Blocked on                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Runnable `apps/*` service shells         | The HTTP framework, WebSocket server, database, RPC provider and market-data vendor — all `OPEN` (§102)                   |
| 17 · historical calibration              | The market-data vendor. The replay harness is built and takes recorded ticks from any source                              |
| 18 · load testing                        | A running transport to put load on                                                                                        |
| 19 · contract security review            | An independent auditor. Not something this repository can do to itself                                                    |
| 20 · infrastructure, backups, monitoring | Hosting. The runbooks that do not depend on it are written                                                                |
| 21–23 · freeze, deploy, activation       | Steps 1 and 2 of §60: the `$WAR` launch and treasury parameters, and the legal review of the Genesis and Secret structure |

Each of those is a product or business decision, and §102 is explicit that an
`OPEN` value must not be invented and shipped as policy. The cores every one of
them would wire into are built, tested and replayable.

## Licence

Copyright (C) 2026 PonsWars.

Licensed under the **GNU Affero General Public License, version 3** — see
[`LICENSE`](LICENSE).

The Affero clause is the reason for this choice over a permissive licence. Use
it, fork it, change it; but if you run a modified version as a network service,
the people using that service are entitled to its source. PonsWars is a hosted
game settling real value, so a closed fork operating as a competing service is
the case the licence is meant to cover — and the one an MIT or Apache licence
would allow without recourse.

Nothing here is deployed and the contracts are unaudited. See
[`SECURITY.md`](SECURITY.md) before relying on any of it.
