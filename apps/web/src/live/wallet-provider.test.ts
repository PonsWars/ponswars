import { describe, expect, it } from 'vitest';
import {
  sendTransaction,
  switchChain,
  transactionOutcome,
  type Eip1193Provider,
} from './wallet-provider.js';

/**
 * Switching a wallet to Robinhood Chain.
 *
 * A fake EIP-1193 provider that records every request and answers from a
 * script, so each test says exactly what the wallet did.
 */

interface Call {
  readonly method: string;
  readonly params?: readonly unknown[];
}

function wallet(answer: (call: Call) => unknown): {
  provider: Eip1193Provider;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    provider: {
      request: (call) => {
        calls.push(call);
        // A throw inside the executor rejects, as a wallet's refusal does.
        return new Promise((resolve) => {
          resolve(answer(call));
        });
      },
    },
  };
}

function walletError(code: number, message = 'refused'): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

const UNRECOGNIZED = walletError(4902, 'Unrecognized chain ID');

describe('switchChain', () => {
  it('switches a wallet that already knows the network, and adds nothing', async () => {
    const { provider, calls } = wallet(() => null);

    expect(await switchChain(provider, 4663)).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual([
      { method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }] },
    ]);
  });

  it('offers Robinhood Chain to a wallet that has never heard of it', async () => {
    const { provider, calls } = wallet((call) => {
      if (call.method === 'wallet_switchEthereumChain') {
        throw UNRECOGNIZED;
      }
      return null;
    });

    expect(await switchChain(provider, 4663)).toEqual({ ok: true, value: undefined });
    expect(calls[1]).toEqual({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: '0x1237',
          chainName: 'Robinhood Chain',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
          blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
        },
      ],
    });
  });

  it('offers the testnet by its own name and endpoints', async () => {
    const { provider, calls } = wallet((call) => {
      if (call.method === 'wallet_switchEthereumChain') {
        throw UNRECOGNIZED;
      }
      return null;
    });

    await switchChain(provider, 46630);

    expect(calls[1]?.params?.[0]).toMatchObject({
      chainId: '0xb626',
      chainName: 'Robinhood Chain Testnet',
      rpcUrls: ['https://rpc.testnet.chain.robinhood.com'],
    });
  });

  it('reads the unrecognized-chain code where MetaMask Mobile nests it', async () => {
    const nested = Object.assign(new Error('switch failed'), {
      code: -32603,
      data: { originalError: { code: 4902 } },
    });
    const { provider, calls } = wallet((call) => {
      if (call.method === 'wallet_switchEthereumChain') {
        throw nested;
      }
      return null;
    });

    expect((await switchChain(provider, 4663)).ok).toBe(true);
    expect(calls.map((call) => call.method)).toEqual([
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
    ]);
  });

  it('never adds a network that is not Robinhood Chain, whatever id it was asked for', async () => {
    // The id comes from a server response. Adding whatever it named would let a
    // response put a hostile RPC endpoint into a player's wallet.
    const { provider, calls } = wallet(() => {
      throw UNRECOGNIZED;
    });

    const result = await switchChain(provider, 8453);

    expect(result.ok).toBe(false);
    expect(calls.map((call) => call.method)).toEqual(['wallet_switchEthereumChain']);
  });

  it('treats a player declining to add the network as declined, not broken', async () => {
    const { provider } = wallet((call) => {
      throw call.method === 'wallet_switchEthereumChain' ? UNRECOGNIZED : walletError(4001);
    });

    expect(await switchChain(provider, 4663)).toEqual({
      ok: false,
      failure: { kind: 'DECLINED' },
    });
  });

  it('does not try to add a network when the switch failed for another reason', async () => {
    const { provider, calls } = wallet(() => {
      throw walletError(4001);
    });

    expect(await switchChain(provider, 4663)).toEqual({
      ok: false,
      failure: { kind: 'DECLINED' },
    });
    expect(calls).toHaveLength(1);
  });
});

describe('sending a claim', () => {
  const TX = `0x${'ab'.repeat(32)}`;
  const CLAIM = { from: `0x${'1'.repeat(40)}`, to: `0x${'2'.repeat(40)}`, data: '0x2e7ba6ef' };

  it('sends it from the connected account with no value, and returns the hash', async () => {
    const { provider, calls } = wallet(() => TX);

    expect(await sendTransaction(provider, CLAIM)).toEqual({ ok: true, value: TX });
    expect(calls).toEqual([
      { method: 'eth_sendTransaction', params: [{ ...CLAIM, value: '0x0' }] },
    ]);
  });

  it('treats a declined prompt as declined, and nonsense as a failure', async () => {
    expect(
      await sendTransaction(
        wallet(() => {
          throw walletError(4001);
        }).provider,
        CLAIM,
      ),
    ).toEqual({ ok: false, failure: { kind: 'DECLINED' } });
    expect((await sendTransaction(wallet(() => 42).provider, CLAIM)).ok).toBe(false);
  });

  it('reads a receipt as pending, succeeded or reverted', async () => {
    expect(await transactionOutcome(wallet(() => null).provider, TX)).toBe('PENDING');
    expect(await transactionOutcome(wallet(() => ({ status: '0x1' })).provider, TX)).toBe(
      'SUCCEEDED',
    );
    expect(await transactionOutcome(wallet(() => ({ status: '0x0' })).provider, TX)).toBe(
      'REVERTED',
    );
  });
});
