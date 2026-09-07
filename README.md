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

| Package                                           | Holds                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`@ponswars/shared-types`](packages/shared-types) | Every **LOCKED** constant and the domain types that cross a process boundary |
| [`@ponswars/config`](packages/config)             | Every **OPEN** parameter, validated at startup with no defaults              |

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

## Status

Milestone 0 — requirements freeze — is complete. Canonical constants and types,
the open-parameter registry, the enforced configuration contract, and the
toolchain and verification gate are in place. Milestone 1 is the deterministic
simulation and contracts foundation; the build order is in Kickoff Brief §18.
