import { describe, expect, it } from 'vitest';
import { assertTokenDecimals, type TokenReader } from './token.js';

const ADDRESS = `0x${'1'.repeat(40)}` as const;

function token(decimals: () => Promise<number>): TokenReader {
  return { address: ADDRESS, decimals, balanceOf: () => Promise.resolve(0n) };
}

const WAR = { parameter: 'WAR_TOKEN_DECIMALS', decimals: 18, chainId: 46630 };

describe('assertTokenDecimals', () => {
  it('accepts a token with the configured decimals', async () => {
    await expect(
      assertTokenDecimals(
        token(() => Promise.resolve(18)),
        WAR,
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a token whose decimals differ, naming both', async () => {
    // Six configured against eighteen on chain is every amount off by 10^12.
    await expect(
      assertTokenDecimals(
        token(() => Promise.resolve(6)),
        WAR,
      ),
    ).rejects.toThrow(
      `WAR_TOKEN_DECIMALS ${ADDRESS} has 6 decimals on Robinhood Chain Testnet (46630), but the configuration says 18.`,
    );
  });

  it('refuses an address that is not a token, and says which parameter it came from', async () => {
    const notAToken = token(() => Promise.reject(new Error('returned no data ("0x")\nmore')));

    await expect(assertTokenDecimals(notAToken, WAR)).rejects.toThrow(
      /WAR_TOKEN_DECIMALS 0x1{40} did not answer decimals\(\) on Robinhood Chain Testnet \(46630\)\. Is it a token on that network\? \(returned no data \("0x"\)\)$/,
    );
  });
});
