# Calibrating the market

**Deciding sections:** §102 open parameters, §23.6 feed health, §23.7
cross-checks, §4.4 VOID, §10 confidence, §12 scoring, §59.4 engine tuning.
Decision record: [ADR 0007](../adr/0007-robinhood-chain-market-with-session-pause.md).

Every bound on the on-chain market, every divisor in the score and every
confidence band is `OPEN` or `CALIBRATE` (`docs/OPEN_PARAMETERS.md` §2). None of
them has a default, and none may be guessed. This is how they are measured:
record the real market, replay it under a candidate set of values, read what
that candidate would have done, choose.

## 1. Record

```bash
pnpm run build
```

```bash
pnpm run record:market
```

`tools/record-market.mjs` runs the same indexer the server runs, against
Robinhood Chain mainnet, and appends what it reads to
`recordings/market/tape-YYYY-MM-DD.jsonl` — every DEX trade, every Pons trade
with its wallet, every Chainlink reference, and a coverage mark after each read
timed by the wall clock. The directory is ignored by git: tapes are data, and a
day of them is tens of megabytes.

It runs until stopped, and a restart is safe: the tape marks it, trades read
twice count once, and the gap replays as the lag it was.

How much to record:

- **At least one full US trading day** before any number means anything — the
  regular session, pre-market and overnight trade very differently.
- **`MARKET_COMPARABLE_SESSIONS` + 1 trading days** before relative volume
  means anything. Until then it leans on `MARKET_EXPECTED_VOLUME_FLOOR_USD`,
  and the report says how many rounds did.
- **A week** before choosing values to launch on.

The public endpoint throttles hard (`--min-interval-ms` sets the fastest the
recorder will go; it slows itself when refused, and says so in its log). A
recorder that falls more than `maxSourceLagMs` behind records a market that
reads `STALE`, faithfully — which calibrates the endpoint rather than the
market. Record through the vendor endpoint production will use:

```bash
node tools/record-market.mjs --rpc https://your-vendor-endpoint --min-interval-ms 50
```

## 2. Replay a candidate

```bash
node tools/calibrate-market.mjs --candidate tools/calibration/initial-candidate.json --out report.json
```

`--clock chain`, the default, replays the market alone: each trade is visible
from the moment it happened, as though the source were never behind. That is
what the market's bounds are measured against, and it keeps a tape recorded
through a throttled endpoint usable. `--clock wall` replays what the recorder
had actually read at each instant, lag included — how a service reading through
that endpoint would have fared. If `SOURCE_LAG` tops the reasons on the wall
clock, the endpoint is the problem, not the bounds.

A candidate is one set of values: the `MARKET_*` variables exactly as they
would be set in the environment, the engine's scoring, momentum and victory
tuning, and the confidence bands. `tools/calibration/initial-candidate.json` is a
starting point, not policy. Copy it, change it, replay again, compare.

Every ten-minute slot the tapes cover while the market was open becomes a
round, and every pair of the ten tickers a battle — forty-five a round, not
five, because the question is how the market behaves under the bounds, not
which matchups were drawn. Each battle is ticked through the real
`OnchainMarket` and the real engine from what had been read at that second,
and finalized as the service would.

## 3. Read the report

**Read the void rates first.** A battle voids on a single `STALE` second
(§4.4). For each ticker the report gives the share of ticks that were healthy,
degraded or stale, the share of its battles that voided, and how many voids its
own readings caused. A ticker that causes most of its own voids is a ticker the
bounds are too strict for — or a market too thin to fight in.

Which bound moves which number:

| Too many voids from…                        | Look at                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| no trade for too long                       | `PRICE_FEED_STALE_AFTER_MS` — how long a price may carry before it is STALE           |
| the DEX price leaving the Chainlink price   | `MARKET_DIVERGENCE_BPS` — must allow for a reference that only moves on a 0.5% change |
| the recorder falling behind                 | not a bound: the endpoint. Record through a vendor                                    |
| a thin window marked DEGRADED (scores, but) | `MARKET_MIN_WINDOW_TRADES`, `MARKET_PRICE_WINDOW_MS`, `MARKET_MIN_TRADE_USD`          |

Loosening a bound trades voided battles for battles decided on thinner data.
That is a product decision (§102), not a tuning one, and the report does not
make it: it shows what each candidate costs.

Then the spreads: winning margins, how far from even battles sit, the gap
between two sides per score component, the victory labels and momentum states
that came out, and the confidence labels the lookbacks earned. A candidate
where every battle is a `DECISIVE_VICTORY`, or every frontline `DOMINATING`,
is tuned for a different market.

## 4. Suggested starting values

The report ends with values read off the spreads by fixed, stated rules
(`packages/calibration/src/suggest.ts`): a component saturates at the
90th-percentile gap, a margin is narrow below the 25th percentile and decisive
above the 75th, momentum pushes, surges and dominates at the 50th, 75th and
90th, each confidence signal puts its middle half in its middle band. A value
with nothing to read it from is `null` and listed, never zero.

They are a place to start the next candidate, not an answer. Replay the
candidate they suggest; a suggestion that changes the void rates or the label
mix in a way nobody wanted is a suggestion to throw away.

## 5. Apply the choice

- **Market bounds** are environment variables. Set them in the deployment and
  regenerate nothing: `loadConfig` validates them at startup.
- **Engine and confidence tuning** are the file `ENGINE_CALIBRATION_FILE`
  points at — the same file the tool replayed, since a candidate's `engine` and
  `confidence` blocks are exactly what the server reads. §59.4 treats them as
  one decision, so deploy the file that was measured rather than editing values
  one at a time. The server reads it once at startup: changing a calibration is
  a deploy, because a round scored under one and finalized under another is a
  result no replay reproduces (§26).
- **Record it.** Update `docs/OPEN_PARAMETERS.md` with the values, the tapes
  they were measured on, and the void rates they produce. A value nobody can
  trace back to a measurement is the guess §102 forbids.
