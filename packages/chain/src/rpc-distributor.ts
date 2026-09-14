import { robinhoodChainNetwork, type WalletAddress } from '@ponswars/shared-types';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  toBytes,
  webSocket,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** The parts of `RewardsDistributor`'s ABI this reads and sends. */
const DISTRIBUTOR_ABI = [
  {
    type: 'function',
    name: 'distributions',
    stateMutability: 'view',
    inputs: [{ name: 'distributionId', type: 'uint256' }],
    outputs: [
      { name: 'root', type: 'bytes32' },
      { name: 'total', type: 'uint256' },
      { name: 'claimed', type: 'uint256' },
      { name: 'publishedAt', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'publishDistribution',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'distributionId', type: 'uint256' },
      { name: 'root', type: 'bytes32' },
      { name: 'total', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'uncommittedBalance',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'hasClaimed',
    stateMutability: 'view',
    inputs: [
      { name: 'distributionId', type: 'uint256' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'hasRole',
    stateMutability: 'view',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'event',
    name: 'DistributionPublished',
    inputs: [
      { name: 'distributionId', type: 'uint256', indexed: true },
      { name: 'root', type: 'bytes32', indexed: false },
      { name: 'total', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'error',
    name: 'DistributionAlreadyPublished',
    inputs: [{ name: 'distributionId', type: 'uint256' }],
  },
] as const;

const PUBLISHER_ROLE = keccak256(toBytes('DISTRIBUTION_PUBLISHER_ROLE'));
const ZERO_ROOT = `0x${'0'.repeat(64)}`;

/** How far back a publication is looked for, and in what windows (see `rpc-vault.ts`). */
const PUBLICATION_LOOKBACK_BLOCKS = 2_000_000n;
const LOG_WINDOW_BLOCKS = 10_000n;

/** A published distribution as the contract holds it, or `null` if the id carries no root. */
export interface OnChainDistribution {
  readonly root: `0x${string}`;
  readonly total: bigint;
}

/** The slice of `RewardsDistributor` publication and claims need (§17). */
export interface DistributorContract {
  distribution(distributionId: bigint): Promise<OnChainDistribution | null>;
  /** SPY the distributor holds beyond what earlier roots already commit. */
  uncommittedBalance(): Promise<bigint>;
  hasClaimed(distributionId: bigint, wallet: WalletAddress): Promise<boolean>;
  hasPublisherRole(account: `0x${string}`): Promise<boolean>;
  /** Sends `publishDistribution` and waits for it to land; the transaction hash. */
  publish(distributionId: bigint, root: `0x${string}`, total: bigint): Promise<`0x${string}`>;
  /** The transaction that published `distributionId`, or `null` if none is found. */
  findPublication(distributionId: bigint): Promise<`0x${string}` | null>;
}

/**
 * `RewardsDistributor` over a JSON-RPC endpoint (§17).
 *
 * Reads need no key. Publishing needs the key holding
 * `DISTRIBUTION_PUBLISHER_ROLE`; without one, `publish` refuses and a
 * multisig-published root is recorded from the chain instead.
 */
export function rpcDistributorContract(options: {
  readonly url: string;
  readonly chainId: number;
  readonly distributor: `0x${string}`;
  readonly publisherKey: `0x${string}` | null;
}): DistributorContract {
  const network = robinhoodChainNetwork(options.chainId);
  if (network === null) {
    throw new Error(`Chain ${String(options.chainId)} is not a Robinhood Chain network`);
  }
  const chain = defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: { default: { http: [network.publicRpcUrl] } },
  });
  const protocol = new URL(options.url).protocol;
  const transport =
    protocol === 'ws:' || protocol === 'wss:' ? webSocket(options.url) : http(options.url);
  const client = createPublicClient({ chain, transport });
  const publisher: Account | null =
    options.publisherKey === null ? null : privateKeyToAccount(options.publisherKey);
  const address = options.distributor;

  return {
    distribution: async (distributionId) => {
      const [root, total] = await client.readContract({
        address,
        abi: DISTRIBUTOR_ABI,
        functionName: 'distributions',
        args: [distributionId],
      });
      return root === ZERO_ROOT ? null : { root, total };
    },

    uncommittedBalance: () =>
      client.readContract({ address, abi: DISTRIBUTOR_ABI, functionName: 'uncommittedBalance' }),

    hasClaimed: (distributionId, wallet) =>
      client.readContract({
        address,
        abi: DISTRIBUTOR_ABI,
        functionName: 'hasClaimed',
        args: [distributionId, wallet as `0x${string}`],
      }),

    hasPublisherRole: (account) =>
      client.readContract({
        address,
        abi: DISTRIBUTOR_ABI,
        functionName: 'hasRole',
        args: [PUBLISHER_ROLE, account],
      }),

    publish: async (distributionId, root, total) => {
      if (publisher === null) {
        throw new Error('No publisher key is configured, so this cannot publish a root');
      }
      try {
        await client.simulateContract({
          address,
          abi: DISTRIBUTOR_ABI,
          functionName: 'publishDistribution',
          args: [distributionId, root, total],
          account: publisher,
        });
      } catch (error: unknown) {
        const reverted =
          error instanceof BaseError
            ? error.walk((cause) => cause instanceof ContractFunctionRevertedError)
            : null;
        if (
          reverted instanceof ContractFunctionRevertedError &&
          reverted.data?.errorName === 'DistributionAlreadyPublished'
        ) {
          throw new Error(`Distribution ${distributionId.toString()} is already published`, {
            cause: error,
          });
        }
        throw error;
      }
      const wallet = createWalletClient({ chain, transport, account: publisher });
      const hash = await wallet.writeContract({
        address,
        abi: DISTRIBUTOR_ABI,
        functionName: 'publishDistribution',
        args: [distributionId, root, total],
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error(
          `Publication ${hash} of distribution ${distributionId.toString()} reverted`,
        );
      }
      return hash;
    },

    findPublication: async (distributionId) => {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      const floor = head > PUBLICATION_LOOKBACK_BLOCKS ? head - PUBLICATION_LOOKBACK_BLOCKS : 0n;
      for (let toBlock = head; toBlock >= floor;) {
        const fromBlock =
          toBlock - floor + 1n > LOG_WINDOW_BLOCKS ? toBlock - LOG_WINDOW_BLOCKS + 1n : floor;
        const logs = await client.getContractEvents({
          address,
          abi: DISTRIBUTOR_ABI,
          eventName: 'DistributionPublished',
          args: { distributionId },
          fromBlock,
          toBlock,
        });
        const found = logs.at(-1)?.transactionHash;
        if (found !== undefined) {
          return found;
        }
        if (fromBlock === floor) {
          break;
        }
        toBlock = fromBlock - 1n;
      }
      return null;
    },
  };
}
