/**
 * The network PonsWars runs on.
 *
 * The masterplan fixes it: **Network: Robinhood Chain**. Which of its networks
 * a deployment uses is per-environment (`CHAIN_ID`), but it is always one of
 * these — a deployment configured for any other chain has been misconfigured,
 * not made a choice.
 *
 * Robinhood Chain is an Arbitrum Layer-2 on Ethereum with ETH as its gas token.
 * The identifiers and public endpoints below are the ones Robinhood publishes at
 * docs.robinhood.com/chain/connecting. The public RPC endpoints are for a wallet
 * adding the network; a server's own RPC endpoint is `RPC_URL`, and its vendor
 * is still `OPEN` (§59.3).
 */

export interface RobinhoodChainNetwork {
  readonly chainId: number;
  /** The name a wallet shows for it. */
  readonly name: string;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  /** Robinhood's public RPC endpoint. */
  readonly publicRpcUrl: string;
  readonly explorerUrl: string;
}

export const ROBINHOOD_CHAIN_MAINNET_ID = 4663;
export const ROBINHOOD_CHAIN_TESTNET_ID = 46630;

export const ROBINHOOD_CHAIN_NETWORKS = [
  {
    chainId: ROBINHOOD_CHAIN_MAINNET_ID,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    publicRpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
  },
  {
    chainId: ROBINHOOD_CHAIN_TESTNET_ID,
    name: 'Robinhood Chain Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    publicRpcUrl: 'https://rpc.testnet.chain.robinhood.com',
    explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
  },
] as const satisfies readonly RobinhoodChainNetwork[];

/** The Robinhood Chain network with this id, or `null` for any other chain. */
export function robinhoodChainNetwork(chainId: number): RobinhoodChainNetwork | null {
  return ROBINHOOD_CHAIN_NETWORKS.find((network) => network.chainId === chainId) ?? null;
}
