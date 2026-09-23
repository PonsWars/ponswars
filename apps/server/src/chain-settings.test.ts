import { describe, expect, it } from 'vitest';
import { chainSettings, minimumClaim, publisherKey } from './chain-settings.js';

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

describe('the minimum claim', () => {
  it('is whatever base units it was given, including none at all', () => {
    expect(minimumClaim({ REWARDS_MINIMUM_CLAIM: '1000000' })).toBe(1_000_000n);
    expect(minimumClaim({ REWARDS_MINIMUM_CLAIM: '0' })).toBe(0n);
  });

  it('is never invented, and says so when it is missing (§16.7)', () => {
    for (const value of [undefined, '', '0.001', '1e6', '-1', '007']) {
      const env = value === undefined ? {} : { REWARDS_MINIMUM_CLAIM: value };
      expect(() => minimumClaim(env)).toThrow('REWARDS_MINIMUM_CLAIM');
    }
    // Decimal SPY is the mistake worth naming: the file wants base units.
    expect(() => minimumClaim({ REWARDS_MINIMUM_CLAIM: '0.001' })).toThrow('base units');
  });
});
