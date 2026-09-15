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
  type Chain,
  type PublicClient,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type {
  ReserveSimulation,
  SecretEntitlement,
  SecretVaultReader,
  VaultContract,
} from './secret-vault.js';

/** The parts of `SecretStockVault`'s ABI this reads, sends and decodes. */
const VAULT_ABI = [
  {
    type: 'function',
    name: 'isCovered',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'REWARD_AMOUNT',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'reserve',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'entitlements',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ type: 'uint8' }],
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
    name: 'Reserved',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'error',
    name: 'AlreadyEntitled',
    inputs: [{ name: 'account', type: 'address' }],
  },
  {
    type: 'error',
    name: 'InsufficientCoverage',
    inputs: [
      { name: 'available', type: 'uint256' },
      { name: 'required', type: 'uint256' },
    ],
  },
] as const;

const RESERVER_ROLE = keccak256(toBytes('RESERVER_ROLE'));

/**
 * How far back a reservation that landed without its claim is looked for.
 *
 * Such a reservation is the aftermath of a crash between a transaction and a
 * database write, and it is found on the next read — seconds or minutes later.
 * Two million blocks is days on Robinhood Chain, far beyond that. Searched in
 * windows, because an RPC endpoint limits how many blocks one `eth_getLogs`
 * may span.
 */
const RESERVATION_LOOKBACK_BLOCKS = 2_000_000n;
const LOG_WINDOW_BLOCKS = 10_000n;

/**
 * The vault, with the reserver key taken from configuration.
 *
 * The key becomes an account here and goes no further: the caller gets the
 * contract and the reserver's address, never the key again.
 */
export function reserverVault(options: {
  readonly url: string;
  readonly chainId: number;
  readonly vault: `0x${string}`;
  readonly privateKey: `0x${string}`;
}): { readonly contract: VaultContract; readonly reserver: `0x${string}` } {
  const reserver = privateKeyToAccount(options.privateKey);
  return {
    contract: rpcVaultContract({
      url: options.url,
      chainId: options.chainId,
      vault: options.vault,
      reserver,
    }),
    reserver: reserver.address,
  };
}

/**
 * The vault's entitlement state, read with no key at all (§8.5).
 *
 * The service shows a winner what the vault says they hold, and the winner's
 * own wallet sends the claim. Nothing here signs anything, so a deployment
 * with `SECRET_RESERVER_KEY=disabled` can still answer a claim page honestly.
 */
export function secretVaultReader(options: {
  readonly url: string;
  readonly chainId: number;
  readonly vault: `0x${string}`;
}): SecretVaultReader {
  const { client } = vaultTransport(options);
  const address = options.vault;
  return {
    rewardAmount: () =>
      client.readContract({ address, abi: VAULT_ABI, functionName: 'REWARD_AMOUNT' }),
    entitlementOf: async (wallet): Promise<SecretEntitlement> => {
      const state = await client.readContract({
        address,
        abi: VAULT_ABI,
        functionName: 'entitlements',
        args: [wallet as `0x${string}`],
      });
      // The contract's own enum: NONE, RESERVED, CLAIMED.
      switch (state) {
        case 0:
          return 'NONE';
        case 1:
          return 'RESERVED';
        case 2:
          return 'CLAIMED';
        default:
          throw new Error(`The vault reports entitlement state ${String(state)}, which is not one`);
      }
    },
  };
}

/** The Robinhood Chain client every vault read and write goes through. */
function vaultTransport(options: { readonly url: string; readonly chainId: number }): {
  readonly chain: Chain;
  readonly transport: Transport;
  readonly client: PublicClient;
} {
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
  return { chain, transport, client: createPublicClient({ chain, transport }) };
}

/**
 * `SecretStockVault` over a JSON-RPC endpoint, with the reserver key (§8.4).
 *
 * Only the reserver's key signs, and only `reserve`. The network is Robinhood
 * Chain's own description, never a chain an endpoint happens to report — the
 * server has already refused an endpoint on another network at startup.
 */
export function rpcVaultContract(options: {
  readonly url: string;
  readonly chainId: number;
  readonly vault: `0x${string}`;
  readonly reserver: Account;
}): VaultContract {
  const { chain, transport, client } = vaultTransport(options);
  const wallet = createWalletClient({ chain, transport, account: options.reserver });
  const address = options.vault;

  return {
    isCovered: () => client.readContract({ address, abi: VAULT_ABI, functionName: 'isCovered' }),

    rewardAmount: () =>
      client.readContract({ address, abi: VAULT_ABI, functionName: 'REWARD_AMOUNT' }),

    simulateReserve: async (account: WalletAddress): Promise<ReserveSimulation> => {
      try {
        await client.simulateContract({
          address,
          abi: VAULT_ABI,
          functionName: 'reserve',
          args: [account as `0x${string}`],
          account: options.reserver,
        });
        return 'WOULD_RESERVE';
      } catch (error: unknown) {
        const reverted =
          error instanceof BaseError
            ? error.walk((cause) => cause instanceof ContractFunctionRevertedError)
            : null;
        const name =
          reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
        if (name === 'InsufficientCoverage') {
          return 'UNCOVERED';
        }
        if (name === 'AlreadyEntitled') {
          return 'ALREADY_ENTITLED';
        }
        throw error;
      }
    },

    sendReserve: async (account) => {
      const hash = await wallet.writeContract({
        address,
        abi: VAULT_ABI,
        functionName: 'reserve',
        args: [account as `0x${string}`],
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error(`Secret reservation ${hash} for ${account} reverted`);
      }
      return hash;
    },

    findReservation: async (account) => {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      const floor = head > RESERVATION_LOOKBACK_BLOCKS ? head - RESERVATION_LOOKBACK_BLOCKS : 0n;
      for (let toBlock = head; toBlock >= floor;) {
        const fromBlock =
          toBlock - floor + 1n > LOG_WINDOW_BLOCKS ? toBlock - LOG_WINDOW_BLOCKS + 1n : floor;
        const logs = await client.getContractEvents({
          address,
          abi: VAULT_ABI,
          eventName: 'Reserved',
          args: { account: account as `0x${string}` },
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

    hasReserverRole: (account) =>
      client.readContract({
        address,
        abi: VAULT_ABI,
        functionName: 'hasRole',
        args: [RESERVER_ROLE, account],
      }),
  };
}
