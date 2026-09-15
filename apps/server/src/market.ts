import {
  marketAddressesFor,
  PacingStopped,
  RobinhoodMarketIndexer,
  robinhoodMarketRpc,
} from '@ponswars/chain';
import type { Config } from '@ponswars/config';
import {
  nextOpenWindow,
  OnchainMarket,
  onchainMarketPolicy,
  SyntheticMarket,
} from '@ponswars/market-data';
import type { MarketDataPort } from '@ponswars/round-service';
import { CONFIDENCE_LOOKBACK, ROUND_DURATION, type UtcTimestamp } from '@ponswars/shared-types';

/**
 * The market this deployment scores battles from (§23).
 *
 * `onchain` reads Robinhood Chain; `synthetic` makes a market up and says so.
 * Built here rather than in `main.ts` because the on-chain one is a running
 * thing — an indexer that backfills, then follows the chain until the process
 * stops — and its lifecycle is worth keeping in one place.
 */

export interface RunningMarket {
  readonly port: MarketDataPort;
  /** Whether the prices are observed rather than generated. */
  readonly real: boolean;
  /** When a whole round can next run; absent for a market that never shuts. */
  readonly roundsOpenAt?: (at: UtcTimestamp) => UtcTimestamp;
  /** Resolves once the market has stopped following its source. */
  readonly stopped: Promise<void>;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * How often the indexer asks for new blocks once it has caught up.
 *
 * Once a second, the scoring cadence (§23.1): a tick can only score trades
 * that were read before it. Not an `OPEN` value — no result depends on it,
 * only how fresh the market a tick sees is, and `MARKET_*` lag limits decide
 * when that is too stale.
 */
const POLL_MS = 1_000;

/** The widest block range one poll reads: about eight minutes of Robinhood Chain. */
const MAX_BLOCKS_PER_POLL = 5_000n;

/**
 * How often the Chainlink references are re-read.
 *
 * They update on a 0.5% move or every 24 hours; reading every thirty seconds
 * catches a deviation update well inside any sensible divergence bound.
 */
const REFERENCE_REFRESH_MS = 30_000;

export async function startMarket(
  config: Config,
  signal: AbortSignal,
  say: (line: string) => void,
): Promise<RunningMarket> {
  switch (config.MARKET_DATA_PROVIDER) {
    case 'synthetic':
      return { port: new SyntheticMarket(), real: false, stopped: Promise.resolve() };
    case 'onchain':
      return startOnchainMarket(config, signal, say);
  }
}

async function startOnchainMarket(
  config: Config,
  signal: AbortSignal,
  say: (line: string) => void,
): Promise<RunningMarket> {
  const addresses = marketAddressesFor(config.CHAIN_ID);
  if (addresses === null) {
    throw new Error(
      `MARKET_DATA_PROVIDER=onchain has no Stock Token market on chain ${String(config.CHAIN_ID)}. ` +
        'Robinhood Stock Tokens and their feeds are on mainnet (4663); use synthetic elsewhere.',
    );
  }

  const rpc = robinhoodMarketRpc(config.RPC_URL, {
    minIntervalMs: config.RPC_MIN_INTERVAL_MS,
    retries: 8,
    backoffMs: 2_000,
    maxBackoffMs: 60_000,
    // A stop during the backfill ends it at the next call instead of after it.
    signal,
  });
  const quoteDecimals = await rpc.tokenDecimals(addresses.usdg);
  const policy = onchainMarketPolicy(config, {
    quoteDecimals,
    excludedAddresses: addresses.routers,
  });

  const indexer = new RobinhoodMarketIndexer({
    rpc,
    addresses,
    // Enough for a price at lock and the volatility lookback behind it.
    tradeRetentionMs:
      config.MARKET_VOLATILITY_LOOKBACK_MS + config.PRICE_FEED_STALE_AFTER_MS + ROUND_DURATION,
    // Every comparable trading day, with a long weekend and a holiday between.
    volumeRetentionMs: (config.MARKET_COMPARABLE_SESSIONS + 4) * DAY + ROUND_DURATION,
    // Volume counts from the same dust bound the price does.
    minTradeQuote: policy.price.minTradeQuote,
    // A battle, and the confidence lookback before its round.
    ponsRetentionMs: ROUND_DURATION + CONFIDENCE_LOOKBACK + MINUTE,
    maxBlocksPerPoll: MAX_BLOCKS_PER_POLL,
    referenceRefreshMs: REFERENCE_REFRESH_MS,
    now: Date.now,
    onLog: (line) => {
      say(`${line}\n`);
    },
  });

  say('market: reading Robinhood Chain — no round opens until the backfill is done\n');
  await indexer.start();
  say('market: caught up\n');

  const stopped = follow(indexer, signal, say);

  const port = new OnchainMarket(indexer, policy);

  return {
    port,
    real: true,
    roundsOpenAt: (at) => nextOpenWindow(at, ROUND_DURATION, policy.calendar),
    stopped,
  };
}

/**
 * Follows the chain until the signal stops it.
 *
 * A poll that fails is logged and tried again: an RPC hiccup must not take the
 * market down, and while the indexer is behind its market reads `STALE`, which
 * voids the battles that depend on it rather than scoring them from old data.
 */
async function follow(
  indexer: RobinhoodMarketIndexer,
  signal: AbortSignal,
  say: (line: string) => void,
): Promise<void> {
  let failing = false;
  while (!signal.aborted) {
    let caughtUp = false;
    try {
      caughtUp = await indexer.poll();
      if (failing) {
        say('market: following the chain again\n');
        failing = false;
      }
    } catch (error) {
      // A call refused because the process is stopping is not a failure.
      if (error instanceof PacingStopped) {
        break;
      }
      if (!failing) {
        say(`market: poll failed, retrying: ${String(error)}\n`);
        failing = true;
      }
    }
    if (caughtUp || failing) {
      await wait(POLL_MS, signal);
    }
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
