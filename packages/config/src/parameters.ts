import { ROBINHOOD_CHAIN_NETWORKS, robinhoodChainNetwork } from '@ponswars/shared-types';
import {
  parseAddress,
  parseDecimalString,
  parseDurationMs,
  parseEnum,
  parseInteger,
  parseString,
  parseUrl,
  type ParseResult,
} from './parsers.js';

/**
 * The environment contract.
 *
 * Masterplan §65.2: environment-specific settings belong in validated
 * configuration, not scattered constants, and *"startup must fail fast when
 * required configuration is missing or invalid."*
 *
 * **No parameter in this table has a default, and none may acquire one.**
 * Every entry here corresponds to a row in `docs/OPEN_PARAMETERS.md`, and §102
 * is explicit: *"No engineer should invent an OPEN value and silently ship it
 * as product policy."* A default would be exactly that. A test asserts the
 * descriptor type has no way to express one.
 */

/** Groups a parameter to its section of the open-parameter registry. */
export const PARAMETER_GROUPS = [
  'runtime',
  'chain',
  'storage',
  'rewards',
  'feeds',
  'serving',
  'auth',
] as const;

export type ParameterGroup = (typeof PARAMETER_GROUPS)[number];

export interface ParameterSpec<T> {
  /** Which registry section this belongs to. */
  readonly group: ParameterGroup;
  /** Why it exists, and which masterplan section governs it. */
  readonly description: string;
  /** Parses the raw environment string. Returns an error, never a fallback. */
  readonly parse: (raw: string) => ParseResult<T>;
  /**
   * True when the value must never appear in a log line or an error message.
   *
   * §87 and §89: never log credentials. The loader redacts these when
   * reporting a validation failure, so a bad password cannot leak through the
   * very error that reports it.
   */
  readonly secret?: true;
}

const NODE_ENVS = ['development', 'test', 'production'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];

/**
 * The market data adapters that exist.
 *
 * - `onchain` reads the market from Robinhood Chain itself: Stock Token trades
 *   on its DEX pools, guarded by Chainlink's on-chain feeds, and Pons activity
 *   quoted in each token. The production source (§23).
 * - `synthetic` is a development tool: a plausible market from a seed, not a
 *   market.
 *
 * An environment asking for an adapter nobody has written fails at startup
 * with the name it asked for, rather than scoring a round against nothing.
 */
const MARKET_DATA_PROVIDERS = ['onchain', 'synthetic'] as const;

export type MarketDataProvider = (typeof MARKET_DATA_PROVIDERS)[number];

/**
 * A comma-separated origin list (§47).
 *
 * Empty is a real answer meaning *no browser may read this*, which is why it is
 * parsed rather than treated as absent — a service reached only by other
 * services should be able to say so, and `loadConfig` must not confuse that
 * with a missing parameter.
 *
 * A wildcard is refused. §5 makes spectating the normal case so browsers do
 * need in, but `*` would hand any page on the internet the ability to make
 * requests on a visitor's behalf the moment credentials were enabled.
 */
function parseOriginList(raw: string): ParseResult<readonly string[]> {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, value: [] };
  }

  const origins = trimmed.split(',').map((entry) => entry.trim());
  for (const origin of origins) {
    if (origin === '*') {
      return { ok: false, error: 'a wildcard origin is not allowed; list the origins' };
    }
    const parsed = parseUrl(origin, ['http:', 'https:']);
    if (!parsed.ok) {
      return { ok: false, error: `${origin}: ${parsed.error}` };
    }
  }
  return { ok: true, value: origins };
}

/**
 * Trusted proxies: comma-separated addresses, CIDR blocks or shorthands.
 *
 * Empty is a real answer — the API is reached directly and no forwarding header
 * is believed — so it is parsed rather than treated as missing, for the same
 * reason an empty origin list is.
 *
 * Checked here as well as by the server's own proxy matcher, so a typo is a
 * startup error naming the entry rather than a header that quietly stops being
 * believed and a rate limit that quietly counts everybody as one caller.
 */
function parseProxyList(raw: string): ParseResult<readonly string[]> {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, value: [] };
  }

  const shorthands = ['loopback', 'linklocal', 'uniquelocal'];
  const entries = trimmed.split(',').map((entry) => entry.trim());
  for (const entry of entries) {
    if (shorthands.includes(entry)) {
      continue;
    }
    const [address, prefix, ...rest] = entry.split('/');
    if (address === undefined || rest.length > 0) {
      return {
        ok: false,
        error: `${entry}: expected an address, a CIDR block or one of ${shorthands.join(', ')}`,
      };
    }
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
    const isIpv4 = ipv4?.slice(1).every((octet) => Number(octet) <= 255) === true;
    const isIpv6 = /^[0-9a-fA-F:]+$/.test(address) && address.includes(':');
    if (!isIpv4 && !isIpv6) {
      return { ok: false, error: `${entry}: ${address} is not an IP address` };
    }
    if (prefix !== undefined) {
      const bits = parseInteger(prefix, { min: 0, max: isIpv4 ? 32 : 128 });
      if (!bits.ok) {
        return { ok: false, error: `${entry}: prefix length ${bits.error}` };
      }
    }
  }
  return { ok: true, value: entries };
}

/** Basis points, 1 to 10,000. */
function parseBps(raw: string): ParseResult<number> {
  return parseInteger(raw, { min: 1, max: 10_000 });
}

/**
 * Exchange holidays: comma-separated `YYYY-MM-DD` New York dates.
 *
 * Empty is a real answer — a calendar with no holidays in it — and is parsed
 * rather than treated as absent. A date that does not exist is refused: a typo
 * here reopens the market on a day it is shut.
 */
function parseHolidayList(raw: string): ParseResult<readonly string[]> {
  const dates = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const date of dates) {
    const parsed = new Date(`${date}T12:00:00Z`);
    const valid =
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === date;
    if (!valid) {
      return { ok: false, error: `${date}: expected a YYYY-MM-DD date` };
    }
  }
  return { ok: true, value: dates };
}

/** The Secret reserver: a key, or a deployment's explicit statement that there is none. */
export type SecretReserverKey =
  { readonly kind: 'DISABLED' } | { readonly kind: 'KEY'; readonly privateKey: `0x${string}` };

/**
 * `disabled`, or a 32-byte private key.
 *
 * Required either way. A reserver absent by omission and one absent by decision
 * look the same at runtime and are not the same thing; `disabled` is the
 * second, written down. The key is secret, so a malformed one is reported
 * without its value.
 */
function parseReserverKey(raw: string): ParseResult<SecretReserverKey> {
  const trimmed = raw.trim();
  if (trimmed === 'disabled') {
    return { ok: true, value: { kind: 'DISABLED' } };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return { ok: false, error: 'expected "disabled" or a 0x-prefixed 32-byte private key' };
  }
  return { ok: true, value: { kind: 'KEY', privateKey: trimmed.toLowerCase() as `0x${string}` } };
}

/**
 * A Robinhood Chain network id.
 *
 * The masterplan fixes the network — *Network: Robinhood Chain* — so which of
 * its networks is per-environment and which chain is not. Any other id is a
 * deployment pointed somewhere PonsWars does not run, and a wallet signing in
 * against it would be signing for the wrong chain, so it is refused at startup
 * rather than discovered by the first player who tries.
 */
function parseRobinhoodChainId(raw: string): ParseResult<number> {
  const parsed = parseInteger(raw, { min: 1 });
  if (!parsed.ok) {
    return parsed;
  }
  if (robinhoodChainNetwork(parsed.value) === null) {
    const known = ROBINHOOD_CHAIN_NETWORKS.map(
      (network) => `${String(network.chainId)} (${network.name})`,
    ).join(' or ');
    return { ok: false, error: `expected a Robinhood Chain network: ${known}` };
  }
  return parsed;
}

export const PARAMETERS = {
  NODE_ENV: {
    group: 'runtime',
    description: 'Runtime mode. Selects logging verbosity and safety checks.',
    parse: (raw) => parseEnum(raw, NODE_ENVS),
  } satisfies ParameterSpec<NodeEnv>,

  // -- Chain (docs/OPEN_PARAMETERS.md §1) -----------------------------------
  CHAIN_ID: {
    group: 'chain',
    description:
      'Robinhood Chain network ID: 4663 mainnet or 46630 testnet. Per-environment; never inferred from the RPC response alone.',
    parse: parseRobinhoodChainId,
  } satisfies ParameterSpec<number>,

  RPC_URL: {
    group: 'chain',
    description:
      'Robinhood Chain JSON-RPC endpoint (§59.3), on the CHAIN_ID network; startup refuses one on another chain. Vendor choice is OPEN.',
    parse: (raw) => parseUrl(raw, ['http:', 'https:', 'ws:', 'wss:']),
    secret: true,
  } satisfies ParameterSpec<string>,

  WAR_TOKEN_ADDRESS: {
    group: 'chain',
    description: '$WAR token. Genesis eligibility reads its balance (§6).',
    parse: parseAddress,
  } satisfies ParameterSpec<`0x${string}`>,

  SPY_TOKEN_ADDRESS: {
    group: 'chain',
    description: 'SPY reward token for distributions and the Secret vault (§17, §18).',
    parse: parseAddress,
  } satisfies ParameterSpec<`0x${string}`>,

  SPY_TOKEN_DECIMALS: {
    group: 'chain',
    description:
      'SPY decimals. Required to convert the locked 0.2 SPY Secret reward into base units. Read from chain and configured explicitly — never assumed to be 18.',
    parse: (raw) => parseInteger(raw, { min: 0, max: 36 }),
  } satisfies ParameterSpec<number>,

  WAR_TOKEN_DECIMALS: {
    group: 'chain',
    description: '$WAR decimals, for converting the 1,000,000 Genesis threshold (§6).',
    parse: (raw) => parseInteger(raw, { min: 0, max: 36 }),
  } satisfies ParameterSpec<number>,

  REWARDS_DISTRIBUTOR_ADDRESS: {
    group: 'chain',
    description: 'RewardsDistributor contract, populated after deployment (§17).',
    parse: parseAddress,
  } satisfies ParameterSpec<`0x${string}`>,

  SECRET_STOCK_VAULT_ADDRESS: {
    group: 'chain',
    description: 'SecretStockVault contract, populated after deployment (§18).',
    parse: parseAddress,
  } satisfies ParameterSpec<`0x${string}`>,

  SECRET_RESERVER_KEY: {
    group: 'chain',
    description:
      'The private key holding RESERVER_ROLE on SecretStockVault, so a Secret reward is reserved before it is revealed (§8.4), or "disabled". Disabled, Secret results are off and their band deals Legendary (§8.3). Startup refuses a key without the role.',
    parse: parseReserverKey,
    secret: true,
  } satisfies ParameterSpec<SecretReserverKey>,

  // -- Storage (docs/OPEN_PARAMETERS.md §3) ---------------------------------
  DATABASE_URL: {
    group: 'storage',
    description: 'PostgreSQL connection string for authoritative game state (§21.3).',
    parse: (raw) => parseUrl(raw, ['postgres:', 'postgresql:']),
    secret: true,
  } satisfies ParameterSpec<string>,

  REDIS_URL: {
    group: 'storage',
    description: 'Redis connection string for hot state, pub/sub and locks (§21.3).',
    parse: (raw) => parseUrl(raw, ['redis:', 'rediss:']),
    secret: true,
  } satisfies ParameterSpec<string>,

  // -- Rewards (docs/OPEN_PARAMETERS.md §1) ---------------------------------
  MIN_CLAIM_THRESHOLD_SPY: {
    group: 'rewards',
    description:
      'Minimum claimable allocation as a decimal SPY amount. BASELINE in the masterplan (0.001, §16.7) and still to be confirmed — amounts below it carry forward, so the figure decides who gets paid this window.',
    parse: parseDecimalString,
  } satisfies ParameterSpec<string>,

  // -- Feeds (docs/OPEN_PARAMETERS.md §2) -----------------------------------
  PRICE_FEED_STALE_AFTER_MS: {
    group: 'feeds',
    description:
      'Age at which a price sample becomes STALE and can void a live battle (§23.6, §4.4). A product decision, not a tuning knob.',
    parse: parseDurationMs,
  } satisfies ParameterSpec<number>,

  VOLUME_FEED_STALE_AFTER_MS: {
    group: 'feeds',
    description: 'Age at which a volume sample becomes STALE (§23.3, §23.6).',
    parse: parseDurationMs,
  } satisfies ParameterSpec<number>,

  PONS_FEED_STALE_AFTER_MS: {
    group: 'feeds',
    description: 'Age at which Pons indexer data becomes STALE (§23.4, §23.6).',
    parse: parseDurationMs,
  } satisfies ParameterSpec<number>,

  MARKET_PRICE_WINDOW_MS: {
    group: 'feeds',
    description:
      'How far back from an instant DEX trades are pooled into one Stock Token price (§23.2). Longer is steadier and slower to follow the market.',
    parse: parseDurationMs,
  } satisfies ParameterSpec<number>,

  MARKET_MIN_TRADE_USD: {
    group: 'feeds',
    description:
      'Smallest trade, in USD, that counts towards a price or volume (§23.7). Below it a trade is dust — the cheapest way to push a thin pool.',
    parse: parseDecimalString,
  } satisfies ParameterSpec<string>,

  MARKET_OUTLIER_BPS: {
    group: 'feeds',
    description:
      'How far from the Chainlink reference a single trade may be before it is dropped as an outlier (§23.7), in basis points.',
    parse: parseBps,
  } satisfies ParameterSpec<number>,

  MARKET_DIVERGENCE_BPS: {
    group: 'feeds',
    description:
      'How far the DEX price may sit from the Chainlink reference before the feed is STALE and a live battle voids (§23.7, §4.4), in basis points. Must allow for the reference only updating on a 0.5% move.',
    parse: parseBps,
  } satisfies ParameterSpec<number>,

  MARKET_REFERENCE_MAX_AGE_MS: {
    group: 'feeds',
    description:
      'Age past which a Chainlink reference cannot vouch for a price (§23.7). The Robinhood feeds have a 24-hour heartbeat.',
    parse: parseDurationMs,
  } satisfies ParameterSpec<number>,

  MARKET_MIN_WINDOW_TRADES: {
    group: 'feeds',
    description:
      'Fewest trades in the price window for a HEALTHY reading; fewer is DEGRADED (§23.6).',
    parse: (raw) => parseInteger(raw, { min: 1 }),
  } satisfies ParameterSpec<number>,

  MARKET_VOLATILITY_LOOKBACK_MS: {
    group: 'feeds',
    description:
      'How far back an asset’s own volatility is measured, which a battle’s return is divided by (§12.1).',
    parse: parseDurationMs,
  } satisfies ParameterSpec<number>,

  MARKET_VOLATILITY_FLOOR_BPS: {
    group: 'feeds',
    description:
      'The smallest volatility a battle window may be given, in basis points (§12.1), so a still hour does not turn an ordinary move into many sigma.',
    parse: parseBps,
  } satisfies ParameterSpec<number>,

  MARKET_COMPARABLE_SESSIONS: {
    group: 'feeds',
    description:
      'How many earlier trading days relative volume is measured against (§12.2). The indexer keeps that much trading in memory.',
    parse: (raw) => parseInteger(raw, { min: 1, max: 20 }),
  } satisfies ParameterSpec<number>,

  MARKET_EXPECTED_VOLUME_FLOOR_USD: {
    group: 'feeds',
    description:
      'The smallest expected volume for a window, in USD (§12.2), so a ticker that barely traded last week does not make one trade today a surge.',
    parse: parseDecimalString,
  } satisfies ParameterSpec<string>,

  MARKET_HOLIDAYS: {
    group: 'feeds',
    description:
      'US exchange holidays as comma-separated YYYY-MM-DD dates. No round opens while the market is shut (§23.8). Published by the exchange a year at a time; empty means none.',
    parse: parseHolidayList,
  } satisfies ParameterSpec<readonly string[]>,

  PONS_MIN_ACTIVITY_USD: {
    group: 'feeds',
    description:
      'Smallest Pons trade, in USD, that counts as qualified activity (§12.3, §75.3). TUNABLE: calibrated, not guessed.',
    parse: parseDecimalString,
  } satisfies ParameterSpec<string>,

  PONS_MAX_IDENTICAL_PER_WALLET: {
    group: 'feeds',
    description:
      'How many same-sized Pons trades from one wallet count before the rest are a loop (§75.3). TUNABLE.',
    parse: (raw) => parseInteger(raw, { min: 1 }),
  } satisfies ParameterSpec<number>,

  RPC_MIN_INTERVAL_MS: {
    group: 'chain',
    description:
      'Least time between two market-indexer calls to RPC_URL. The public endpoint answers bursts with a challenge page; a vendor has a rate it bills or cuts at.',
    parse: parseDurationMs,
  } satisfies ParameterSpec<number>,

  ENGINE_CALIBRATION_FILE: {
    group: 'feeds',
    description:
      'Path to the JSON holding the engine tuning and confidence bands this deployment scores by (§59.4): the scoring divisors, momentum and victory thresholds, and the four confidence bands with their matchup gaps. §59.4 treats the block as one decision, so it is one file rather than a dozen variables, and it is the file `tools/calibrate-market.mjs` measures a candidate as. No default: a service that invented a calibration would be shipping product policy (§102).',
    parse: parseString,
  } satisfies ParameterSpec<string>,

  BATTLE_ENGINE_TICK_MS: {
    group: 'feeds',
    description:
      'Authoritative scoring tick interval. BASELINE: §12.5 and §23.1 say approximately one per second.',
    parse: parseDurationMs,
  } satisfies ParameterSpec<number>,

  // -- Serving (docs/OPEN_PARAMETERS.md §3) ---------------------------------
  API_PORT: {
    group: 'serving',
    description:
      'Port the REST API binds (§47). A deployment fact: the same image runs behind different ingresses.',
    parse: (raw) => parseInteger(raw, { min: 1, max: 65_535 }),
  } satisfies ParameterSpec<number>,

  GATEWAY_PORT: {
    group: 'serving',
    description:
      'Port the realtime gateway binds (§48). Separate from the API so the two can scale and fail independently.',
    parse: (raw) => parseInteger(raw, { min: 1, max: 65_535 }),
  } satisfies ParameterSpec<number>,

  ALLOWED_ORIGINS: {
    group: 'serving',
    description:
      'Browser origins allowed to read the API (§47). Comma separated. An empty value is valid and means no browser may.',
    parse: parseOriginList,
  } satisfies ParameterSpec<readonly string[]>,

  API_TRUSTED_PROXIES: {
    group: 'serving',
    description:
      'The proxies in front of the API, comma separated (§59.3): IP addresses, CIDR blocks, or the shorthands loopback, linklocal and uniquelocal. The rate limiter counts per client address, so what counts as the client is a deployment fact. X-Forwarded-For is believed only from these; empty is a real answer meaning the API is reached directly and the header is never believed. Trusting it from anyone would let a caller invent an address and never be limited, which is worse than not limiting because it looks like limiting.',
    parse: parseProxyList,
  } satisfies ParameterSpec<readonly string[]>,

  MARKET_DATA_PROVIDER: {
    group: 'serving',
    description:
      'Which market to score battles from (§59.3, §23.6): `onchain` reads Stock Token trading on Robinhood Chain mainnet, checked against Chainlink; `synthetic` generates prices and says so. No default — a deployment that scored real battles from made-up prices must not be one typo away.',
    parse: (raw) => parseEnum(raw, MARKET_DATA_PROVIDERS),
  } satisfies ParameterSpec<MarketDataProvider>,

  // -- Wallet authentication (docs/OPEN_PARAMETERS.md §4) --------------------
  AUTH_ORIGIN: {
    group: 'auth',
    description:
      'The origin a sign-in signature is bound to (§45.2). The message names its host, and a signature produced for one site must not authenticate at another — so this is the public URL of the client, not of the API.',
    parse: (raw) => parseUrl(raw, ['http:', 'https:']),
  } satisfies ParameterSpec<string>,

  AUTH_CHALLENGE_TTL_MS: {
    group: 'auth',
    description:
      'How long a sign-in challenge is worth signing (§45.2). OPEN: the masterplan says short-lived and names no figure. Long enough for a hardware wallet, short enough that a stolen unsigned challenge is worth little.',
    parse: parseDurationMs,
  } satisfies ParameterSpec<number>,

  AUTH_SESSION_TTL_MS: {
    group: 'auth',
    description:
      'How long a session lasts before the wallet is asked again (§45.2). OPEN, and the more consequential of the two: a session is a bearer credential, so this is how long a stolen one works.',
    parse: parseDurationMs,
  } satisfies ParameterSpec<number>,

  AUTH_RATE_LIMIT_REQUESTS: {
    group: 'auth',
    description:
      'How many sign-in requests one client address may make per AUTH_RATE_LIMIT_WINDOW_MS (§59.3). Verifying a signature is the only request in this API whose cost is CPU, so this is what stops one caller spending everybody’s. A sign-in costs two: the challenge and the verify share a bucket. OPEN, and 0 is a real answer meaning unlimited — for a deployment that limits at its edge instead.',
    parse: (raw) => parseInteger(raw, { min: 0 }),
  } satisfies ParameterSpec<number>,

  AUTH_RATE_LIMIT_WINDOW_MS: {
    group: 'auth',
    description:
      'How long refilling a whole sign-in allowance takes (§59.3). The allowance is a token bucket, so this is the sustained rate and AUTH_RATE_LIMIT_REQUESTS is also the largest burst a caller who has been quiet may make at once. OPEN: nothing in the masterplan names a figure, and the honest way to choose is against the load a round boundary actually produces (docs/operations/load-testing.md).',
    parse: parseDurationMs,
  } satisfies ParameterSpec<number>,
} as const;

export type ParameterName = keyof typeof PARAMETERS;

export const PARAMETER_NAMES = Object.keys(PARAMETERS) as readonly ParameterName[];

/** The parsed configuration, keyed exactly as the environment is. */
export type Config = {
  readonly [K in ParameterName]: (typeof PARAMETERS)[K] extends ParameterSpec<infer T> ? T : never;
};
