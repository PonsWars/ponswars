import {
  parseAddress,
  parseDecimalString,
  parseDurationMs,
  parseEnum,
  parseInteger,
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
 * `synthetic` is the one written so far and is a development tool: it produces
 * a plausible market from a seed and is not a market. A production vendor is an
 * `OPEN` decision (§59.3), so this list is short on purpose — an environment
 * asking for a vendor nobody has written fails at startup with the name it
 * asked for, rather than starting and scoring a round against nothing.
 */
const MARKET_DATA_PROVIDERS = ['synthetic'] as const;

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

export const PARAMETERS = {
  NODE_ENV: {
    group: 'runtime',
    description: 'Runtime mode. Selects logging verbosity and safety checks.',
    parse: (raw) => parseEnum(raw, NODE_ENVS),
  } satisfies ParameterSpec<NodeEnv>,

  // -- Chain (docs/OPEN_PARAMETERS.md §1) -----------------------------------
  CHAIN_ID: {
    group: 'chain',
    description: 'EVM chain ID. Per-environment; never inferred from the RPC response alone.',
    parse: (raw) => parseInteger(raw, { min: 1 }),
  } satisfies ParameterSpec<number>,

  RPC_URL: {
    group: 'chain',
    description: 'Chain RPC endpoint (§59.3). Vendor choice is OPEN.',
    parse: (raw) => parseUrl(raw, ['http:', 'https:', 'ws:', 'wss:']),
    secret: true,
  } satisfies ParameterSpec<string>,

  WAR_TOKEN_ADDRESS: {
    group: 'chain',
    description: '$WAR token. Genesis eligibility reads its balance (§6).',
    parse: parseAddress,
  } satisfies ParameterSpec<string>,

  SPY_TOKEN_ADDRESS: {
    group: 'chain',
    description: 'SPY reward token for distributions and the Secret vault (§17, §18).',
    parse: parseAddress,
  } satisfies ParameterSpec<string>,

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
  } satisfies ParameterSpec<string>,

  SECRET_STOCK_VAULT_ADDRESS: {
    group: 'chain',
    description: 'SecretStockVault contract, populated after deployment (§18).',
    parse: parseAddress,
  } satisfies ParameterSpec<string>,

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

  MARKET_DATA_PROVIDER: {
    group: 'serving',
    description:
      'Which market data adapter to run (§59.3, §23.6). OPEN: no vendor is chosen, so there is nothing to default to and startup refuses rather than inventing one.',
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
} as const;

export type ParameterName = keyof typeof PARAMETERS;

export const PARAMETER_NAMES = Object.keys(PARAMETERS) as readonly ParameterName[];

/** The parsed configuration, keyed exactly as the environment is. */
export type Config = {
  readonly [K in ParameterName]: (typeof PARAMETERS)[K] extends ParameterSpec<infer T> ? T : never;
};
