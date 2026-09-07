# Open / Tunable Parameter Registry

**Milestone 0 deliverable.** Kickoff Brief §18: _"List all `OPEN/TUNABLE`
parameters separately. Do not hardcode open production values as if locked."_
Masterplan §102: _"No engineer should invent an OPEN value and silently ship it
as product policy."_

Sources: masterplan §59 (Remaining Open Decisions) and §102 (V1 Defaults vs Open
Production Parameters).

## How this registry is enforced in code

| Kind       | Where it lives                                          | Rule                                                                   |
| ---------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| **LOCKED** | `packages/shared-types/src/**` as a `const`             | Compiled in. Changing one requires a masterplan revision.              |
| **OPEN**   | `packages/config` — validated environment configuration | Has no compiled-in default. Startup **fails fast** when it is missing. |

An OPEN parameter must never acquire a default value in source code. A default
is a silent product decision, and §102 forbids exactly that. Where this registry
lists a _placeholder_, that value exists only in `.env.example` and in local and
test fixtures — never in `packages/config` itself.

Status legend: `OPEN` — no decision yet. `BASELINE` — the masterplan names an
example value that still needs confirmation before launch. `CALIBRATE` — the
formula is locked, the constants inside it are not.

---

## 1. Launch and treasury (§59.1, §102)

| Parameter                                   | Status     | Notes                                                                                                              |
| ------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| Pons V2 creator-tax rate                    | `OPEN`     | Determines realized fee revenue feeding both pools.                                                                |
| `$WAR` / SPY pair support and configuration | `OPEN`     | Must be confirmed against the production Robinhood Chain / Stock Token environment.                                |
| Initial Rewards Distribution pool funding   | `OPEN`     | Manual funding; no promised amount (§30, §16.1).                                                                   |
| Initial Secret Stock Vault funding          | `OPEN`     | Gates whether Secret RNG is active at launch (§8.3).                                                               |
| Production multisig signers and threshold   | `OPEN`     | Required before any treasury-sensitive action (§20).                                                               |
| Minimum claim threshold                     | `BASELINE` | Masterplan example is `0.001 SPY` (§16.7). Confirm before launch.                                                  |
| SPY token decimals                          | `OPEN`     | Needed to convert the locked `0.2 SPY` Secret reward into base units. Read from chain at startup; never assume 18. |
| SPY token address                           | `OPEN`     | Per-environment.                                                                                                   |
| Chain ID                                    | `OPEN`     | Per-environment.                                                                                                   |
| `$WAR` token address                        | `OPEN`     | Per-environment. Genesis eligibility reads its balance.                                                            |
| `RewardsDistributor` address                | `OPEN`     | Populated after deployment.                                                                                        |
| `SecretStockVault` address                  | `OPEN`     | Populated after deployment.                                                                                        |

## 2. Data and scoring calibration (§59.2, §102)

The structural formulas are **locked** — 45/25/20/10, `sqrt(WP)`, 80/20, 2% cap.
Only the constants inside them are open.

| Parameter                                          | Status      | Notes                                                                                                                        |
| -------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Volatility normalization constants                 | `CALIBRATE` | Price Momentum is volatility-adjusted (§12.1); the lookback and normalizer are not fixed.                                    |
| Relative Volume historical baseline implementation | `CALIBRATE` | Must be ticker-specific and time-of-day aware (§12.2).                                                                       |
| Battle Confidence label-gap thresholds             | `CALIBRATE` | Which score gap becomes `FAVORED` vs `DOMINANT`. The label set itself is locked (§10.2).                                     |
| Feed freshness thresholds per source               | `OPEN`      | Source- and data-type-specific (§23.6). These decide when a battle VOIDs, so they are a product decision, not a tuning knob. |
| Qualified Pons activity thresholds                 | `CALIBRATE` | Anti-abuse qualification before scoring (§12.3).                                                                             |
| Anti-wash filters                                  | `CALIBRATE` | Suspicious-pattern filtering in the indexer (§21.2).                                                                         |
| Card-support diminishing-return curve constants    | `CALIBRATE` | The 10-point cap and sqrt/log shape are locked (§12.4); the exact curve is not.                                              |
| Battle engine tick cadence                         | `BASELINE`  | Masterplan says _approximately_ one authoritative tick per second (§12.5, §23.1).                                            |
| Frontend visual interpolation window               | `BASELINE`  | 3–5 seconds (§13.2). Presentation only — never applied to winner math.                                                       |

## 3. Infrastructure (§59.3)

| Parameter                                          | Status |
| -------------------------------------------------- | ------ |
| Cloud / runtime provider                           | `OPEN` |
| RPC vendors                                        | `OPEN` |
| Market-data provider configuration and credentials | `OPEN` |
| Managed PostgreSQL provider                        | `OPEN` |
| Managed Redis provider                             | `OPEN` |
| CDN / object storage                               | `OPEN` |
| Observability platform                             | `OPEN` |
| Alert thresholds                                   | `OPEN` |
| Asset and log retention durations                  | `OPEN` |
| Launch concurrency target                          | `OPEN` |
| WebSocket connection and rate limits               | `OPEN` |

## 4. Visual implementation tuning (§59.4)

Art direction is locked (§36, §39). Production tuning is not.

| Parameter                    | Status |
| ---------------------------- | ------ |
| Exact isometric camera angle | `OPEN` |
| Exact pixel / render scale   | `OPEN` |
| Texture resolutions          | `OPEN` |
| Shader implementation        | `OPEN` |
| Audio production scope       | `OPEN` |
| Mobile fidelity thresholds   | `OPEN` |
| Final LOD distances          | `OPEN` |
| Performance Mode presets     | `OPEN` |
| Device performance cutoffs   | `OPEN` |

## 5. Compliance (§59.5)

Blocking for public value launch (§33, §57).

| Parameter                                        | Status |
| ------------------------------------------------ | ------ |
| Permitted launch jurisdictions                   | `OPEN` |
| Final eligibility and disclosure text            | `OPEN` |
| Treatment and restrictions for Secret Stock Drop | `OPEN` |
| Geofencing / age / identity controls             | `OPEN` |
| Final terms and privacy disclosures              | `OPEN` |

---

## Changing a value in this registry

1. Decide the value outside the codebase and record the decision — an ADR under
   `docs/adr/` for engineering choices, a masterplan revision for product policy.
2. Add it to the environment schema in `packages/config`, still with no default.
3. Set it per environment.
4. Move the row here to a resolved state with a link to the deciding document.

Promoting a row to LOCKED — moving it into `packages/shared-types` as a
compiled-in constant — requires a masterplan revision, never a code review alone.
