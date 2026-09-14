# 7. Battles are scored from Robinhood Chain's own market, and pause when it shuts

- **Status:** Accepted
- **Date:** 2026-09-15
- **Milestone:** 2

## Context

A battle is decided by its two stocks' price momentum, relative volume and
Pons activity (§12). Until now the only market behind the port was
`synthetic`: generated prices, labelled as such on every start, because the
vendor was an `OPEN` decision (§102).

Robinhood Chain answers most of that decision itself. Every roster ticker is a
Stock Token on mainnet (4663) with 18 decimals, trading against USDG in
Uniswap v4 pools, and each has a Chainlink Data Feed on the same chain. What
was measured before choosing:

- **The Chainlink feeds are too slow to score from.** They update on a 0.5%
  move or every 24 hours. A nine-minute battle between two stocks that each
  move 0.3% would read as two flat lines.
- **The DEX is fast but uneven.** Over thirty minutes of a trading session,
  NVDA, GOOGL, SPY, AMD and META traded steadily; AAPL, TSLA and MSFT
  moderately; GME ten times for about $230 and AMZN twice for about $55.
- **A thin pool is the cheapest thing to push.** A single trade in a quiet
  pool can move its price further than the whole market moved that hour.
- **The market shuts.** Stock Tokens trade on the underlying's session, 24/5,
  from Sunday 20:00 to Friday 20:00 New York time, and not on exchange
  holidays. A battle fought across a weekend is decided by nothing.

## Decision

**`MARKET_DATA_PROVIDER=onchain`: the DEX is the price, Chainlink is the
guard.**

`RobinhoodMarketIndexer` (`@ponswars/chain`) reads Swap events from the USDG
pools of each Stock Token, Pons curve and hook-pool trades quoted in it, and
the Chainlink answer for it. `OnchainMarket` (`@ponswars/market-data`) turns
that into the engine's inputs:

- **Price** is the notional-weighted median of the trades in a short window,
  after dropping dust below `MARKET_MIN_TRADE_USD` and any trade further than
  `MARKET_OUTLIER_BPS` from the reference. A median by dollars means one
  trade cannot set the price unless it is most of the window's money.
- **Divergence is STALE.** A window price further than
  `MARKET_DIVERGENCE_BPS` from a fresh reference is a feed integrity failure
  (§23.7), and the engine does not score it; a battle with no scorable tick
  voids (§4.4). A reference older than `MARKET_REFERENCE_MAX_AGE_MS` guards
  nothing, so a price without a fresh one is `DEGRADED` at best.
- **Quiet is DEGRADED, then STALE.** With no trades in the window the last
  price carries, marked `DEGRADED`, until `PRICE_FEED_STALE_AFTER_MS`. Fewer
  than `MARKET_MIN_WINDOW_TRADES` is `DEGRADED` too. GME and AMZN will spend
  a lot of time here; that is the honest reading of their market.
- **Volume** is dollar volume per minute against the same span on the last
  `MARKET_COMPARABLE_SESSIONS` trading days (§12.2, §23.3), floored by
  `MARKET_EXPECTED_VOLUME_FLOOR_USD`.
- **Pons activity** is qualified by the existing rules (§12.3, §75.3), sized in
  dollars through the reference.

**No round opens unless it can finish inside the session.** The round driver
takes `roundsOpenAt` and, when the next round would not fit, waits and emits
`MARKET_CLOSED` with the time it reopens. A round already running when the
market shuts is not stopped; its feeds go `STALE` and it voids. This revises
the masterplan's continuous schedule (§3.1) for a market that is not
continuous, under §23.8: a shut market must not be read as flat price action.

The roster is unchanged. GME and AMD stay: both exist on chain, and the
factions are designed for them.

## Consequences

- **An RPC vendor is required in production.** The indexer makes far more
  calls than anything else: history-wide discovery, then a poll a second. The
  public endpoint answers bursts with a Cloudflare challenge. Calls are paced
  (`RPC_MIN_INTERVAL_MS`) and throttling is retried, which keeps the public
  endpoint usable for development and nothing more.
- **Startup takes as long as the backfill.** Relative volume needs the last
  `MARKET_COMPARABLE_SESSIONS` trading days in memory before the first round.
  The API and gateway bind first, so health answers and readiness says the
  service is starting.
- **Mainnet only.** Stock Tokens and their feeds are not on testnet (46630);
  `onchain` refuses to start there, and testnet keeps `synthetic`.
- **Thresholds are calibrated, not guessed.** Every bound above is a required
  parameter with no default (§102). They and the confidence calibration are
  to be measured against this market before launch.
- **Voids will be more common on thin tickers.** That is preferred to a
  winner decided by one wallet's trade in an empty pool.
- **Splits and multipliers** reach the DEX price already applied, since a
  trade prices the token as it is. The reference is compared in the same
  terms; a corporate action that moves them apart shows up as divergence and
  voids rather than scoring.
