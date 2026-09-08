# PonsWars

A persistent, explorable spatial war world driven by real market data.

Ten stock factions fight five simultaneous battles every ten minutes. Players
spend the first minute picking a side and deciding whether to spend a Genesis
Card charge, then watch nine minutes of battle whose outcome is decided entirely
by market behaviour — price momentum, relative volume and on-chain Pons
activity. Real SPY rewards settle on chain every 24 hours.

## Source of truth

When documents disagree, this order decides:

1. [`01_Masterplan/PonsWars_Masterplan_v1.4.md`](01_Masterplan/PonsWars_Masterplan_v1.4.md) — mechanics and product rules
2. [`02_Claude_Guides/CLAUDE_KICKOFF_BRIEF.md`](02_Claude_Guides/CLAUDE_KICKOFF_BRIEF.md) — sequencing and non-negotiables
3. [`02_Claude_Guides/PONSWARS_VISUAL_IMPLEMENTATION_GUIDE.md`](02_Claude_Guides/PONSWARS_VISUAL_IMPLEMENTATION_GUIDE.md) — visual hierarchy and mockup corrections
4. Design tokens — _not yet delivered, see [`02_Claude_Guides/_MISSING.md`](02_Claude_Guides/_MISSING.md)_
5. [`03_Visual_Pack/`](03_Visual_Pack/) — art direction only
6. Text, numbers and logos rendered _inside_ the generated PNGs — **non-canonical**

The PNGs are art direction, never production UI exports and never a source of
gameplay truth. Several contain attractive but non-canonical mechanics — a live
exact battle score, staggered battle scheduling, an active-window reward
estimate. [`03_Visual_Pack/MANIFEST.md`](03_Visual_Pack/MANIFEST.md) lists
exactly which image carries which.

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

Design tokens are transcribed in `@ponswars/ui-tokens` from the visual guide;
the gaps noted in [`02_Claude_Guides/_MISSING.md`](02_Claude_Guides/_MISSING.md)
are still open.
