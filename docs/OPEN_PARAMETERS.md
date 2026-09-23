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

| Parameter                                   | Status     | Notes                                                                                                                   |
| ------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| Pons V2 creator-tax rate                    | `OPEN`     | Determines realized fee revenue feeding both pools.                                                                     |
| `$WAR` / SPY pair support and configuration | `OPEN`     | Must be confirmed against the production Robinhood Chain / Stock Token environment.                                     |
| Initial Rewards Distribution pool funding   | `OPEN`     | Manual funding; no promised amount (§30, §16.1).                                                                        |
| Initial Secret Stock Vault funding          | `OPEN`     | Gates whether Secret RNG is active at launch (§8.3).                                                                    |
| Secret reservation signer                   | `OPEN`     | `SECRET_RESERVER_KEY`: the key holding the vault's reserver role, or `disabled` (Secret off, its band deals Legendary). |
| Production multisig signers and threshold   | `OPEN`     | Required before any treasury-sensitive action (§20).                                                                    |
| Minimum claim threshold                     | `BASELINE` | Masterplan example is `0.001 SPY` (§16.7). Confirm before launch.                                                       |
| SPY token decimals                          | `OPEN`     | Needed to convert the locked `0.2 SPY` Secret reward into base units. Read from chain at startup; never assume 18.      |
| SPY token address                           | `OPEN`     | Per-environment.                                                                                                        |
| Chain ID                                    | `OPEN`     | Per-environment, but only ever Robinhood Chain: `4663` mainnet or `46630` testnet. `loadConfig` refuses any other.      |
| `$WAR` token address                        | `OPEN`     | Per-environment. Genesis eligibility reads its balance.                                                                 |
| `RewardsDistributor` address                | `OPEN`     | Populated after deployment.                                                                                             |
| `SecretStockVault` address                  | `OPEN`     | Populated after deployment.                                                                                             |

## 2. Data and scoring calibration (§59.2, §102)

The structural formulas are **locked** — 45/25/20/10, `sqrt(WP)`, 80/20, 2% cap.
Only the constants inside them are open.

| Parameter                                          | Status      | Notes                                                                                                                                |
| -------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Volatility normalization constants                 | `CALIBRATE` | Price Momentum is volatility-adjusted (§12.1); the lookback and normalizer are not fixed.                                            |
| Relative Volume historical baseline implementation | `CALIBRATE` | Must be ticker-specific and time-of-day aware (§12.2).                                                                               |
| Battle Confidence label-gap thresholds             | `CALIBRATE` | Which score gap becomes `FAVORED` vs `DOMINANT`. The label set itself is locked (§10.2).                                             |
| Feed freshness thresholds per source               | `OPEN`      | Source- and data-type-specific (§23.6). These decide when a battle VOIDs, so they are a product decision, not a tuning knob.         |
| Qualified Pons activity thresholds                 | `CALIBRATE` | Anti-abuse qualification before scoring (§12.3).                                                                                     |
| Anti-wash filters                                  | `CALIBRATE` | Suspicious-pattern filtering in the indexer (§21.2).                                                                                 |
| Card-support diminishing-return curve constants    | `CALIBRATE` | The 10-point cap and sqrt/log shape are locked (§12.4); the exact curve is not.                                                      |
| Battle engine tick cadence                         | `BASELINE`  | Masterplan says _approximately_ one authoritative tick per second (§12.5, §23.1).                                                    |
| Engine tuning and confidence bands                 | `CALIBRATE` | One decision (§59.4), one file: `ENGINE_CALIBRATION_FILE`, measured by `tools/calibrate-market.mjs` and deployed as it was replayed. |
| Frontend visual interpolation window               | `BASELINE`  | 3–5 seconds (§13.2). Presentation only — never applied to winner math.                                                               |

### The on-chain market's guards

`MARKET_DATA_PROVIDER=onchain` reads Stock Token trading on Robinhood Chain and
checks it against Chainlink
([ADR 0007](adr/0007-robinhood-chain-market-with-session-pause.md)). Each bound
below decides when a reading is trusted, degraded or voids a battle, so each is
a required parameter with no default. They are measured, not chosen by feel:
[Calibrating the market](operations/market-calibration.md) records the real
market and replays it under candidate values.

| Parameter                          | Status      | Notes                                                                                                      |
| ---------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| `MARKET_PRICE_WINDOW_MS`           | `CALIBRATE` | Trades pooled into one price. Longer is steadier and slower to follow the market.                          |
| `MARKET_MIN_TRADE_USD`             | `CALIBRATE` | Dust below it counts towards neither price nor volume.                                                     |
| `MARKET_OUTLIER_BPS`               | `CALIBRATE` | A trade this far from the reference is dropped.                                                            |
| `MARKET_DIVERGENCE_BPS`            | `OPEN`      | A window price this far from the reference is `STALE` (§23.7). Decides voids, so a product decision.       |
| `MARKET_REFERENCE_MAX_AGE_MS`      | `OPEN`      | Past it a reference guards nothing. The feeds have a 24-hour heartbeat.                                    |
| `MARKET_MIN_WINDOW_TRADES`         | `CALIBRATE` | Fewer trades in the window is `DEGRADED`.                                                                  |
| `MARKET_VOLATILITY_LOOKBACK_MS`    | `CALIBRATE` | The volatility a battle's return is divided by (§12.1).                                                    |
| `MARKET_VOLATILITY_FLOOR_BPS`      | `CALIBRATE` | Keeps a still hour from turning an ordinary move into many sigma.                                          |
| `MARKET_COMPARABLE_SESSIONS`       | `CALIBRATE` | Earlier trading days relative volume compares against (§12.2). Held in memory, so it lengthens startup.    |
| `MARKET_EXPECTED_VOLUME_FLOOR_USD` | `CALIBRATE` | Keeps one trade on a ticker that barely traded last week from reading as a surge.                          |
| `MARKET_HOLIDAYS`                  | `OPEN`      | Exchange holidays, published a year at a time. No round opens while the market is shut.                    |
| `PONS_MIN_ACTIVITY_USD`            | `CALIBRATE` | Smallest qualified Pons trade (§12.3, §75.3).                                                              |
| `PONS_MAX_IDENTICAL_PER_WALLET`    | `CALIBRATE` | Same-sized Pons trades from one wallet that count before the rest are a loop (§75.3).                      |
| `RPC_MIN_INTERVAL_MS`              | `OPEN`      | Least time between indexer calls. Depends on the RPC vendor's rate; the public endpoint needs it generous. |

### First measurement — 2026-09-21

Nothing above is chosen yet; this is what the first tapes say, so the choice
can be traced to them.

**Tapes.** 2026-09-15 to 2026-09-21, through the public endpoint, on a machine
that slept: 87 recorded hours out of 157, and 246 rounds that could be replayed
with the market open. Too little to launch on — record again, around the clock,
through the chosen vendor (`LAUNCH.md` step 2). `tools/tape-coverage.mjs` is
what those hours were counted with; run it before trusting a later measurement
more than this one.

**Void rates** (`tools/calibration/initial-candidate.json`, chain clock, all 45
pairs a round):

| `PRICE_FEED_STALE_AFTER_MS` | Battles voided | GME | AMZN | AMD | MSFT | NVDA, SPY, META, GOOGL, TSLA, AAPL  |
| --------------------------- | -------------- | --- | ---- | --- | ---- | ----------------------------------- |
| 15 minutes                  | 34.1%          | 72% | 59%  | 49% | 36%  | 21% — none caused by their own data |
| 30 minutes                  | 16.3%          | 41% | 31%  | 22% | 13%  | 9% — none caused by their own data  |

Almost every void comes from four tickers whose Robinhood Chain market is thin,
not from the bounds being wrong for the rest. Trades an hour over the recorded
hours: META 1,281, SPY 359, NVDA 341, GOOGL 168, AAPL 93, TSLA 68, AMD 51, MSFT
32, GME 15 (about $640 an hour, median trade $10), AMZN 9 (about $620 an hour).

A longer stale bound halves the voids by deciding more battles on a price
carried from an older trade (`DEGRADED`). On GME and AMZN, a few dollars of
trading move the price a battle is decided by — which is a question about
manipulation (§75) as much as about voids, and a product decision (§102).

**The suggested engine values, replayed.** `suggest` reads starting values off
the spreads; replaying them over the same tapes (475 and 473 rounds, 21,000
battles each) says what they would do:

|                       | Initial candidate | Its own suggestion |
| --------------------- | ----------------- | ------------------ |
| Battles voided        | 35.2%             | 35.2%              |
| Momentum `CONTESTED`  | 27.7%             | 45.1%              |
| Momentum `DOMINATING` | 16.3%             | 8.2%               |
| `NARROW_VICTORY`      | 4.5%              | 12.7%              |
| `DECISIVE_VICTORY`    | 25.1%             | 13.3%              |
| `UPSET_VICTORY`       | 24.8%             | 35.2%              |

The void rate does not move, because the market bounds are the same in both:
the engine's tuning decides what a battle _looks_ like, not whether its data
was trusted.

Neither is chosen. The suggestion flattens the world — nearly half of all ticks
`CONTESTED`, a dominant push in one battle of twelve — and it makes the
pre-battle label wrong more often: better than a third of finalized battles
would be upsets, against a quarter under the initial values, which is a lot to
ask of a `FAVORED` label a player reads before picking (§10). Measure again on
a full week of uninterrupted tapes before choosing.

## 3. Infrastructure (§59.3)

| Parameter                                          | Status                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| Cloud / runtime provider                           | `OPEN`                                                             |
| Robinhood Chain RPC vendor                         | `OPEN`                                                             |
| Market-data provider configuration and credentials | `OPEN` — `onchain` needs no vendor credentials, only an RPC vendor |
| Managed PostgreSQL provider                        | `OPEN`                                                             |
| Managed Redis provider                             | `OPEN`                                                             |
| CDN / object storage                               | `OPEN`                                                             |
| Observability platform                             | `OPEN`                                                             |
| Alert thresholds                                   | `OPEN` — the stuck-round threshold is now configuration; see below |
| Asset and log retention durations                  | `OPEN`                                                             |
| Launch concurrency target                          | `OPEN`                                                             |
| WebSocket connection and rate limits               | `OPEN` — the API's sign-in limit is now configuration; see §4      |

Alerting is configuration rather than code, because where alerts go and when a
round counts as stuck are both judgements about a deployment:

| Variable                     | Status | Meaning                                                                                                                                                                |
| ---------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALERT_WEBHOOK`              | `OPEN` | `ntfy+<url>` for a phone, `json+<url>` for any webhook, or `disabled`. Required either way: no alerts must be a decision, not an omission. Secret.                     |
| `ALERT_ROUND_STUCK_AFTER_MS` | `OPEN` | How long past its battle end a round may go unfinalized before it is reported. Finalization can legitimately wait on a chain-derived tiebreak (§12.7), so no constant. |

## 4. Wallet authentication (§45.2, §102)

§45.2 asks for a short-lived challenge and a short-lived session and names no
figure for either. Both are therefore deployment decisions, and both are real
ones: the first bounds how long an unsigned challenge is worth stealing, and the
second is how long a stolen session works.

| Parameter                   | Status | Note                                                                                      |
| --------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `AUTH_CHALLENGE_TTL_MS`     | `OPEN` | Long enough for a hardware wallet, short enough that a stolen challenge is worth little.  |
| `AUTH_SESSION_TTL_MS`       | `OPEN` | How long a bearer session lasts. Rotation (§45.2) is what keeps a long visit signed in.   |
| `AUTH_ORIGIN`               | `OPEN` | The client's public origin. A signature is bound to it and must not work elsewhere.       |
| `AUTH_RATE_LIMIT_REQUESTS`  | `OPEN` | Sign-in requests one client address may make per window. `0` means unlimited.             |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `OPEN` | How long refilling the whole allowance takes.                                             |
| `API_TRUSTED_PROXIES`       | `OPEN` | The proxies whose `X-Forwarded-For` is believed. Empty means the API is reached directly. |

The rate limit exists because sign-in is the only request in the API whose cost
is CPU rather than IO: verifying an EIP-4361 signature recovers a public key,
measured at 281 a second on one core (`docs/operations/load-testing.md`). It is
a token bucket, so `AUTH_RATE_LIMIT_REQUESTS` is both the sustained allowance
per window and the largest burst a caller who has been quiet may make at once,
and one sign-in spends two of it — the challenge and the verify share a bucket.

Choosing it needs a number nobody has yet: how many people open the app at a
round boundary (§3.1), since every one of them signs in inside the same minute.
Until then the honest setting is one generous enough that no player meets it —
the point is to stop one machine spending every core, not to ration players.

`API_TRUSTED_PROXIES` is not a tuning decision but a fact about the deployment,
and it is listed here because getting it wrong breaks the limit in both
directions: empty behind a load balancer puts every caller in one bucket, and
trusting a forwarded address from anyone lets a caller invent a new one per
request.

## 5. Visual implementation tuning (§59.4)

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

## 6. Compliance (§59.5)

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
