import { ROBINHOOD_CHAIN_MAINNET_ID, type ActiveTicker } from '@ponswars/shared-types';

/**
 * Where the market lives on Robinhood Chain (§74.1).
 *
 * Every address here is someone else's public, deployed contract — the Stock
 * Tokens Robinhood issues, the Chainlink feeds that price them, the Uniswap v4
 * PoolManager they trade in and the Pons launchpad. None of them is a PonsWars
 * decision, which is why they are compiled in rather than configured; what is
 * configured is the policy for reading them (`docs/OPEN_PARAMETERS.md` §2).
 *
 * They are still not trusted blind. `verifyMarketAddresses` checks each one on
 * chain at startup — a token's `symbol()` is its ticker, a feed's
 * `description()` names it — and the server refuses to start on a mismatch.
 *
 * Sources, read 2026-09-14:
 * - Stock Tokens: Robinhood's asset registry, `https://api.robinhood.com/rhj/assets`
 * - Feeds: Chainlink's directory, `reference-data-directory.vercel.app/feeds-robinhood-mainnet.json`
 * - PoolManager: Uniswap's v4 deployments page, "Robinhood Chain: 4663"
 * - Pons V2: `github.com/ponsdotdev/ponsfamily` and its verified factory
 * - USDG: Robinhood Chain's token contracts page
 */

type Address = `0x${string}`;

export interface TickerMarket {
  /** The Stock Token, 18 decimals. */
  readonly token: Address;
  /** Chainlink's AggregatorV3 proxy for it, USD at 8 decimals (§23.7). */
  readonly referenceFeed: Address;
}

export interface RobinhoodMarketAddresses {
  readonly chainId: number;
  /** Uniswap v4's singleton pool manager. */
  readonly poolManager: Address;
  /** The dollar token Stock Tokens trade against. */
  readonly usdg: Address;
  /** Pons V2's launch factory: every `TokenLaunched`. */
  readonly ponsFactory: Address;
  /** Pons V2's hook, on every graduated pool. */
  readonly ponsMemeHook: Address;
  /** Routers, whose address is never a trader's (§75.3). */
  readonly routers: readonly Address[];
  readonly tickers: Readonly<Record<ActiveTicker, TickerMarket>>;
}

export const ROBINHOOD_CHAIN_MAINNET_MARKET: RobinhoodMarketAddresses = {
  chainId: ROBINHOOD_CHAIN_MAINNET_ID,
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  ponsFactory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  ponsMemeHook: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
  routers: [
    // Uniswap Universal Router.
    '0x8876789976decbfcbbbe364623c63652db8c0904',
    // Pons V2 launch router.
    '0xe33e9e479df8802cb0866d5d05258bec4cf62948',
  ],
  tickers: {
    NVDA: {
      token: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
      referenceFeed: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15',
    },
    AAPL: {
      token: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
      referenceFeed: '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0',
    },
    MSFT: {
      token: '0xe93237C50D904957Cf27E7B1133b510C669c2e74',
      referenceFeed: '0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E',
    },
    TSLA: {
      token: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
      referenceFeed: '0x4A1166a659A55625345e9515b32adECea5547C38',
    },
    GME: {
      token: '0x1b0E319c6A659F002271B69dB8A7df2F911c153E',
      referenceFeed: '0x27C71df6A64fB476468EdF256CF72c038baB5B67',
    },
    META: {
      token: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35',
      referenceFeed: '0x7C38C00C30BEe9378381E7B6135d7283356D71b1',
    },
    AMZN: {
      token: '0x12f190a9F9d7D37a250758b26824B97CE941bF54',
      referenceFeed: '0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C',
    },
    GOOGL: {
      token: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3',
      referenceFeed: '0xF6f373a037c30F0e5010d854385cA89185AE638b',
    },
    AMD: {
      token: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC',
      referenceFeed: '0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72',
    },
    SPY: {
      token: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
      referenceFeed: '0x319724394D3A0e3669269846abE664Cd621f9f6A',
    },
  },
};

/** The market addresses for a chain, or `null` where none are known. */
export function marketAddressesFor(chainId: number): RobinhoodMarketAddresses | null {
  return chainId === ROBINHOOD_CHAIN_MAINNET_MARKET.chainId ? ROBINHOOD_CHAIN_MAINNET_MARKET : null;
}
