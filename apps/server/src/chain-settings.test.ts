import { describe, expect, it } from 'vitest';
import { chainSettings, minimumClaim, publisherKey, spyToken } from './chain-settings.js';

/**
 * What the rewards jobs accept from the environment (§16.7, §20, §102).
 *
 * Each of these refuses rather than defaults, and the refusals are the point:
 * a job that guessed an endpoint would read another chain, and one that
 * guessed a minimum claim would be deciding who gets paid this window.
 */

const GOOD = {
  RPC_URL: 'https://rpc.mainnet.chain.robinhood.com',
  CHAIN_ID: '4663',
  REWARDS_DISTRIBUTOR_ADDRESS: '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa',
} satisfies NodeJS.ProcessEnv;

const KEY = `0x${'ab'.repeat(32)}`;

describe('the chain a rewards job talks to', () => {
  it('takes the endpoint, the chain and the distributor, lowercased', () => {
    const settings = chainSettings(GOOD);

    expect(settings.url).toBe(GOOD.RPC_URL);
    expect(settings.chainId).toBe(4663);
    // Lowercased, because an address is compared as text in more places than
    // it is checksummed in.
    expect(settings.distributor).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('takes the testnet as well, and nothing else', () => {
    expect(chainSettings({ ...GOOD, CHAIN_ID: '46630' }).chainId).toBe(46630);
    // Not Base, not Ethereum, not a chain a copied .env happens to name.
    for (const chainId of ['1', '8453', '', 'mainnet']) {
      expect(() => chainSettings({ ...GOOD, CHAIN_ID: chainId })).toThrow('CHAIN_ID');
    }
  });

  it('refuses an endpoint that is not one, naming it', () => {
    for (const url of ['', 'rpc.mainnet.chain.robinhood.com', 'file:///etc/passwd']) {
      expect(() => chainSettings({ ...GOOD, RPC_URL: url })).toThrow('RPC_URL');
    }
  });

  it('refuses anything but an address for the distributor', () => {
    for (const address of ['', '0x1234', 'not-an-address', `0x${'g'.repeat(40)}`]) {
      expect(() => chainSettings({ ...GOOD, REWARDS_DISTRIBUTOR_ADDRESS: address })).toThrow(
        'REWARDS_DISTRIBUTOR_ADDRESS',
      );
    }
  });
});

describe('the publisher key', () => {
  it('is null when there is none, because a multisig publishes instead (§20)', () => {
    expect(publisherKey({})).toBeNull();
    expect(publisherKey({ DISTRIBUTION_PUBLISHER_KEY: '' })).toBeNull();
  });

  it('is taken lowercased when it is a key', () => {
    expect(
      publisherKey({ DISTRIBUTION_PUBLISHER_KEY: KEY.toUpperCase().replace('0X', '0x') }),
    ).toBe(KEY);
  });

  it('refuses what is not a key, without repeating it back', () => {
    const nearly = `0x${'ab'.repeat(31)}`;
    try {
      publisherKey({ DISTRIBUTION_PUBLISHER_KEY: nearly });
      expect.unreachable('a 31-byte key is not a key');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('DISTRIBUTION_PUBLISHER_KEY');
      // A refusal that quotes the value writes a private key into a log.
      expect(message).not.toContain(nearly);
    }
  });
});

const SPY = {
  SPY_TOKEN_ADDRESS: '0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb',
  SPY_TOKEN_DECIMALS: '18',
} satisfies NodeJS.ProcessEnv;

describe('the SPY token', () => {
  it('is the address and decimals the server is configured with, lowercased', () => {
    expect(spyToken(SPY)).toEqual({
      address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      decimals: 18,
    });
  });

  it('refuses what the server would refuse, naming it', () => {
    expect(() => spyToken({ ...SPY, SPY_TOKEN_ADDRESS: '0x1234' })).toThrow('SPY_TOKEN_ADDRESS');
    for (const decimals of [undefined, '', '-1', '37', '6.5', 'eighteen']) {
      const env = { ...SPY, SPY_TOKEN_DECIMALS: decimals };
      expect(() => spyToken(env)).toThrow('SPY_TOKEN_DECIMALS');
    }
  });
});

describe('the minimum claim', () => {
  it('is the configured SPY amount, in SPY base units', () => {
    // The masterplan's baseline (§16.7), at SPY's 18 decimals and at 6.
    expect(minimumClaim({ ...SPY, MIN_CLAIM_THRESHOLD_SPY: '0.001' })).toBe(10n ** 15n);
    expect(
      minimumClaim({ ...SPY, SPY_TOKEN_DECIMALS: '6', MIN_CLAIM_THRESHOLD_SPY: '0.001' }),
    ).toBe(1_000n);
    // None at all is a real answer: every qualifying allocation is claimable.
    expect(minimumClaim({ ...SPY, MIN_CLAIM_THRESHOLD_SPY: '0' })).toBe(0n);
  });

  it('is read from the one variable the server reads, not a second one', () => {
    // A base-unit copy used to live beside it, and nothing kept the two in
    // step. Setting only the old one must not be enough to run.
    expect(() => minimumClaim({ ...SPY, REWARDS_MINIMUM_CLAIM: '1000000000000000' })).toThrow(
      'MIN_CLAIM_THRESHOLD_SPY',
    );
  });

  it('is never invented, and says so when it is missing or malformed (§16.7)', () => {
    // The same shapes the server's configuration refuses.
    for (const value of [undefined, '', '1e-3', '.001', '-0.001', '0.001 SPY']) {
      const env = { ...SPY, MIN_CLAIM_THRESHOLD_SPY: value };
      expect(() => minimumClaim(env)).toThrow('MIN_CLAIM_THRESHOLD_SPY');
    }
  });

  it('refuses more decimal places than SPY has, rather than rounding', () => {
    // Rounding would be choosing a threshold nobody configured.
    expect(() =>
      minimumClaim({ ...SPY, SPY_TOKEN_DECIMALS: '6', MIN_CLAIM_THRESHOLD_SPY: '0.0000001' }),
    ).toThrow('more decimal places');
    // Trailing zeros past SPY's precision change nothing and are accepted.
    expect(
      minimumClaim({ ...SPY, SPY_TOKEN_DECIMALS: '6', MIN_CLAIM_THRESHOLD_SPY: '0.00100000' }),
    ).toBe(1_000n);
  });

  it('cannot be converted without SPY decimals to convert it with', () => {
    expect(() =>
      minimumClaim({ SPY_TOKEN_ADDRESS: SPY.SPY_TOKEN_ADDRESS, MIN_CLAIM_THRESHOLD_SPY: '0.001' }),
    ).toThrow('SPY_TOKEN_DECIMALS');
  });
});
