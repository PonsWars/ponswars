import { chainLabel } from '@ponswars/shared-types';

/** An ERC-20 token on Robinhood Chain, for the two things PonsWars reads from one. */
export interface TokenReader {
  readonly address: `0x${string}`;
  decimals(): Promise<number>;
  /** In base units, at the latest block. */
  balanceOf(wallet: `0x${string}`): Promise<bigint>;
}

/**
 * Refuses a token whose decimals are not the configured ones.
 *
 * Decimals are configured rather than read at every use (`docs/OPEN_PARAMETERS.md`
 * §1) — and checked against the chain once, at startup. A wrong value converts
 * every amount by a power of ten: `0.2 SPY` reserved as `0.0000002`, or a
 * Genesis threshold a million times too low. Nothing downstream would look
 * wrong, so this is the one place it can be caught.
 *
 * An address with no token behind it fails here too, with the parameter named,
 * rather than on the first player who opens a profile.
 */
export async function assertTokenDecimals(
  token: TokenReader,
  expected: { readonly parameter: string; readonly decimals: number; readonly chainId: number },
): Promise<void> {
  let actual: number;
  try {
    actual = await token.decimals();
  } catch (error: unknown) {
    throw new Error(
      `${expected.parameter} ${token.address} did not answer decimals() on ` +
        `${chainLabel(expected.chainId)}. Is it a token on that network? ` +
        `(${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)})`,
      { cause: error },
    );
  }
  if (actual !== expected.decimals) {
    throw new Error(
      `${expected.parameter} ${token.address} has ${String(actual)} decimals on ` +
        `${chainLabel(expected.chainId)}, but the configuration says ${String(expected.decimals)}.`,
    );
  }
}
