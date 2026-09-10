import { describe, expect, it } from 'vitest';
import { ConfigError, describeParameters, loadConfig } from './load.js';
import { PARAMETER_GROUPS, PARAMETER_NAMES, PARAMETERS } from './parameters.js';

/** A complete, valid environment. Every test starts from this and breaks one thing. */
const VALID: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  CHAIN_ID: '4663',
  RPC_URL: 'https://rpc.example.invalid',
  WAR_TOKEN_ADDRESS: '0x1111111111111111111111111111111111111111',
  SPY_TOKEN_ADDRESS: '0x2222222222222222222222222222222222222222',
  SPY_TOKEN_DECIMALS: '6',
  WAR_TOKEN_DECIMALS: '18',
  REWARDS_DISTRIBUTOR_ADDRESS: '0x3333333333333333333333333333333333333333',
  SECRET_STOCK_VAULT_ADDRESS: '0x4444444444444444444444444444444444444444',
  DATABASE_URL: 'postgres://user:pw@db.example.invalid:5432/ponswars',
  REDIS_URL: 'redis://cache.example.invalid:6379',
  MIN_CLAIM_THRESHOLD_SPY: '0.001',
  PRICE_FEED_STALE_AFTER_MS: '5000',
  VOLUME_FEED_STALE_AFTER_MS: '60000',
  PONS_FEED_STALE_AFTER_MS: '15000',
  BATTLE_ENGINE_TICK_MS: '1000',
  API_PORT: '4000',
  GATEWAY_PORT: '4001',
  ALLOWED_ORIGINS: 'https://play.example.invalid',
  MARKET_DATA_PROVIDER: 'synthetic',
};

const withOverride = (
  patch: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> => ({ ...VALID, ...patch });

describe('the origin list', () => {
  it('accepts an empty value as a real answer', () => {
    // §47: a service reached only by other services should be able to say no
    // browser may read it, and the loader must not confuse that with a missing
    // parameter.
    const config = loadConfig(withOverride({ ALLOWED_ORIGINS: '' }));
    expect(config.ALLOWED_ORIGINS).toEqual([]);
  });

  it('takes a list', () => {
    const config = loadConfig(
      withOverride({ ALLOWED_ORIGINS: 'https://a.example.invalid, https://b.example.invalid' }),
    );
    expect(config.ALLOWED_ORIGINS).toEqual([
      'https://a.example.invalid',
      'https://b.example.invalid',
    ]);
  });

  it('refuses a wildcard', () => {
    // §5 makes spectating normal so browsers do need in, but `*` hands any page
    // on the internet the ability to make requests on a visitor's behalf the
    // moment credentials are enabled.
    expect(() => loadConfig(withOverride({ ALLOWED_ORIGINS: '*' }))).toThrow(ConfigError);
  });
});

describe('the market data provider', () => {
  it('refuses a vendor nobody has written', () => {
    // §59.3 leaves the vendor OPEN, so there is nothing to fall back to. An
    // environment naming one that does not exist has to fail at startup rather
    // than start and score a round against nothing.
    expect(() => loadConfig(withOverride({ MARKET_DATA_PROVIDER: 'acme-feeds' }))).toThrow(
      ConfigError,
    );
  });
});

describe('the parameter table', () => {
  it('covers every declared parameter', () => {
    expect(PARAMETER_NAMES.length).toBeGreaterThan(0);
    expect([...PARAMETER_NAMES].sort()).toEqual(Object.keys(PARAMETERS).sort());
  });

  it('declares no defaults, anywhere', () => {
    // §102: "No engineer should invent an OPEN value and silently ship it as
    // product policy." A default IS that invention. The descriptor type has no
    // field to express one, and this asserts none has been added.
    for (const name of PARAMETER_NAMES) {
      const spec: Record<string, unknown> = PARAMETERS[name];
      expect(Object.keys(spec).sort()).not.toContain('default');
      expect(Object.keys(spec).sort()).not.toContain('fallback');
      expect(Object.keys(spec).sort()).not.toContain('defaultValue');
    }
  });

  it('documents every parameter with a known group', () => {
    for (const entry of describeParameters()) {
      expect(entry.description.length).toBeGreaterThan(20);
      expect(PARAMETER_GROUPS).toContain(entry.group as (typeof PARAMETER_GROUPS)[number]);
    }
  });

  it('marks credential-bearing parameters as secret', () => {
    const secrets = describeParameters()
      .filter((entry) => entry.secret)
      .map((entry) => entry.name);
    expect(secrets).toContain('DATABASE_URL');
    expect(secrets).toContain('REDIS_URL');
    expect(secrets).toContain('RPC_URL');
  });

  it('does not mark public addresses as secret', () => {
    const secrets = new Set(
      describeParameters()
        .filter((e) => e.secret)
        .map((e) => e.name),
    );
    expect(secrets.has('SPY_TOKEN_ADDRESS')).toBe(false);
    expect(secrets.has('CHAIN_ID')).toBe(false);
  });
});

describe('loadConfig on a valid environment', () => {
  const config = loadConfig(VALID);

  it('parses every value to its declared type', () => {
    expect(config.NODE_ENV).toBe('test');
    expect(config.CHAIN_ID).toBe(4663);
    expect(config.SPY_TOKEN_DECIMALS).toBe(6);
    expect(config.BATTLE_ENGINE_TICK_MS).toBe(1000);
    expect(config.MIN_CLAIM_THRESHOLD_SPY).toBe('0.001');
  });

  it('keeps the claim threshold a string rather than a float', () => {
    // §66.3: the value is converted against a token precision that is itself
    // configuration. Going through a double here would defeat the exact
    // conversion parseDecimalToBaseUnits provides.
    expect(typeof config.MIN_CLAIM_THRESHOLD_SPY).toBe('string');
  });

  it('normalizes addresses to lowercase', () => {
    const mixed = loadConfig(
      withOverride({ SPY_TOKEN_ADDRESS: '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa' }),
    );
    expect(mixed.SPY_TOKEN_ADDRESS).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('ignores unrelated environment variables', () => {
    expect(() => loadConfig(withOverride({ SOME_OTHER_VAR: 'whatever' }))).not.toThrow();
  });
});

describe('loadConfig failures', () => {
  it('fails fast when a required parameter is missing', () => {
    // §65.2: startup must fail fast when required configuration is missing.
    expect(() => loadConfig(withOverride({ CHAIN_ID: undefined }))).toThrow(ConfigError);
  });

  it('never substitutes a value for a missing parameter', () => {
    // The single most important behaviour in this package.
    let thrown: unknown;
    try {
      loadConfig(withOverride({ MIN_CLAIM_THRESHOLD_SPY: undefined }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).issues).toHaveLength(1);
    expect((thrown as ConfigError).issues[0]?.name).toBe('MIN_CLAIM_THRESHOLD_SPY');
  });

  it('reports every problem at once, not just the first', () => {
    // An operator bringing up a new environment should learn about all the
    // missing variables in one run, not one restart at a time.
    const broken = withOverride({
      CHAIN_ID: undefined,
      RPC_URL: undefined,
      SPY_TOKEN_ADDRESS: 'not-an-address',
      BATTLE_ENGINE_TICK_MS: '0',
    });
    let thrown: unknown;
    try {
      loadConfig(broken);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const names = (thrown as ConfigError).issues.map((issue) => issue.name).sort();
    expect(names).toEqual(['BATTLE_ENGINE_TICK_MS', 'CHAIN_ID', 'RPC_URL', 'SPY_TOKEN_ADDRESS']);
  });

  it('quotes the offending value for a non-secret parameter', () => {
    let thrown: unknown;
    try {
      loadConfig(withOverride({ CHAIN_ID: 'abc' }));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ConfigError).issues[0]?.reason).toContain('"abc"');
  });

  it('redacts the value of a secret parameter', () => {
    // §87, §89: never log credentials. An error message is a log line, and a
    // bad DATABASE_URL contains a password.
    const secretUrl = 'postgres-but-wrong://user:hunter2@host/db';
    let thrown: unknown;
    try {
      loadConfig(withOverride({ DATABASE_URL: secretUrl }));
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as ConfigError).message;
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain(secretUrl);
  });

  it.each([
    ['NODE_ENV', 'staging'],
    ['CHAIN_ID', '0'],
    ['CHAIN_ID', '1.5'],
    ['SPY_TOKEN_DECIMALS', '37'],
    ['SPY_TOKEN_ADDRESS', '0x123'],
    ['SPY_TOKEN_ADDRESS', '1111111111111111111111111111111111111111'],
    ['RPC_URL', 'not a url'],
    ['RPC_URL', 'ftp://example.invalid'],
    ['DATABASE_URL', 'mysql://host/db'],
    ['REDIS_URL', 'http://host'],
    ['MIN_CLAIM_THRESHOLD_SPY', '-0.001'],
    ['MIN_CLAIM_THRESHOLD_SPY', '1e-3'],
    ['MIN_CLAIM_THRESHOLD_SPY', '.001'],
    ['PRICE_FEED_STALE_AFTER_MS', '0'],
    ['PRICE_FEED_STALE_AFTER_MS', '-1'],
    ['BATTLE_ENGINE_TICK_MS', 'fast'],
  ])('rejects %s = %s', (name, value) => {
    expect(() => loadConfig(withOverride({ [name]: value }))).toThrow(ConfigError);
  });

  it('rejects an empty string as firmly as a missing value', () => {
    // An empty variable is a deployment mistake, not an instruction to use a
    // default.
    expect(() => loadConfig(withOverride({ RPC_URL: '' }))).toThrow(ConfigError);
    expect(() => loadConfig(withOverride({ CHAIN_ID: '' }))).toThrow(ConfigError);
  });

  it('rejects an entirely empty environment and names everything', () => {
    let thrown: unknown;
    try {
      loadConfig({});
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ConfigError).issues).toHaveLength(PARAMETER_NAMES.length);
  });
});
