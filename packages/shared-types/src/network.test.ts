import { describe, expect, it } from 'vitest';
import {
  ROBINHOOD_CHAIN_MAINNET_ID,
  ROBINHOOD_CHAIN_NETWORKS,
  ROBINHOOD_CHAIN_TESTNET_ID,
  robinhoodChainNetwork,
} from './network.js';

describe('Robinhood Chain networks', () => {
  it('are mainnet 4663 and testnet 46630, as Robinhood publishes them', () => {
    expect(ROBINHOOD_CHAIN_MAINNET_ID).toBe(4663);
    expect(ROBINHOOD_CHAIN_TESTNET_ID).toBe(46630);
    expect(ROBINHOOD_CHAIN_NETWORKS.map((network) => network.chainId)).toEqual([4663, 46630]);
  });

  it('pay gas in ETH, and point a wallet at https endpoints only', () => {
    for (const network of ROBINHOOD_CHAIN_NETWORKS) {
      expect(network.nativeCurrency).toEqual({ name: 'Ether', symbol: 'ETH', decimals: 18 });
      expect(new URL(network.publicRpcUrl).protocol).toBe('https:');
      expect(new URL(network.explorerUrl).protocol).toBe('https:');
    }
  });

  it('finds a network by id, and nothing for any other chain', () => {
    expect(robinhoodChainNetwork(4663)?.name).toBe('Robinhood Chain');
    expect(robinhoodChainNetwork(46630)?.name).toBe('Robinhood Chain Testnet');
    // Base, Base Sepolia and Ethereum mainnet are not where PonsWars runs.
    expect(robinhoodChainNetwork(8453)).toBeNull();
    expect(robinhoodChainNetwork(84532)).toBeNull();
    expect(robinhoodChainNetwork(1)).toBeNull();
  });
});
