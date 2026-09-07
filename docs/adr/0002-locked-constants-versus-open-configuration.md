# 2. Locked constants live in code, open parameters live in configuration

- **Status:** Accepted
- **Date:** 2026-09-08
- **Milestone:** 0

## Context

The masterplan draws a hard line between two kinds of value.

**Locked** values are product policy: the ten-minute round, the 45/25/20/10
battle score, `sqrt(WP)` weighting, the 2% per-wallet cap, the 0.2 SPY Secret
reward. §102 lists them and they change only through a masterplan revision.

**Open** values are undecided or environment-specific: SPY decimals, feed
freshness thresholds, RPC endpoints, the minimum claim threshold. §102 closes
with a rule that reads as a warning:

> No engineer should invent an OPEN value and silently ship it as product
> policy.

Both kinds are just numbers in a file. Nothing about a `const` says which one it
is, and the failure mode is asymmetric: an open value hardcoded as if locked
looks completely normal in review and is discovered only when someone asks why
production behaves differently from the document.

## Decision

The two kinds live in physically different places, and the location carries the
status.

| Kind   | Location                       | Shape                                     |
| ------ | ------------------------------ | ----------------------------------------- |
| Locked | `packages/shared-types/src/**` | Exported `const`, compiled in             |
| Open   | `packages/config`              | Environment parameter with **no default** |

Three rules follow:

1. **No open parameter has a default.** `ParameterSpec` has no field to express
   one, `loadConfig` throws when a value is absent, and a test asserts no
   descriptor has acquired a default under another name. Startup fails with the
   complete list of what is missing (§65.2).

2. **A value the masterplan calls an example is named as one.** The minimum
   claim threshold is `MIN_CLAIM_THRESHOLD_BASELINE_DECIMAL` in code and
   `MIN_CLAIM_THRESHOLD_SPY` in configuration. The constant exists so the
   documented baseline is discoverable; the runtime value comes from config,
   because the exact figure decides who gets paid in a window.

3. **Promotion requires a revision.** Moving a row from `OPEN` to a compiled
   constant is a product decision, never a code review.

Placeholders exist in exactly one place: `.env.example`, generated from the
parameter table, with values chosen to be non-functional (`<chain id>`,
`<calibrate per source>`) so nobody can copy one into production and have it
appear to work.

## Consequences

- A missing configuration value is a loud startup failure instead of a quiet
  wrong answer.
- `docs/OPEN_PARAMETERS.md`, `packages/config` and `.env.example` cannot drift:
  the registry is the human index, the table is the enforcement, and the example
  is generated from the table and checked in CI.
- Bringing up a new environment surfaces all sixteen missing variables at once
  rather than one restart at a time.
- Some ceremony is unavoidable for values that feel obvious. SPY decimals are
  almost certainly 18 — but "almost certainly" is not a basis on which to
  convert a real reward amount, and the cost of asking is one environment
  variable.
