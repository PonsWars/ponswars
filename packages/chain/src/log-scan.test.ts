import { describe, expect, it } from 'vitest';
import { isTooManyLogs, scanLogs, type RawLog, type RpcRequest } from './log-scan.js';

/** A chain with one log in each block from 0 to 99, capped at `limit` logs a query. */
function cappedEndpoint(limit: number): { request: RpcRequest; calls: string[] } {
  const calls: string[] = [];
  const request: RpcRequest = (method, params) => {
    const filter = params[0] as { fromBlock: string; toBlock: string };
    const from = Number(BigInt(filter.fromBlock));
    const to = Number(BigInt(filter.toBlock));
    calls.push(`${String(from)}-${String(to)}`);
    if (method !== 'eth_getLogs') {
      return Promise.reject(new Error('unexpected method'));
    }
    const count = Math.max(0, Math.min(to, 99) - from + 1);
    if (count > limit) {
      return Promise.reject(new Error(`logs matched by query exceeds limit of ${String(limit)}`));
    }
    const logs: RawLog[] = Array.from({ length: count }, (_, offset) => ({
      address: '0x01',
      topics: [],
      data: '0x',
      blockNumber: `0x${(from + offset).toString(16)}`,
      blockHash: '0x',
      transactionHash: '0x',
      logIndex: '0x0',
    }));
    // Out of order on purpose: the scanner owns the ordering.
    return Promise.resolve(logs.reverse());
  };
  return { request, calls };
}

describe('scanLogs', () => {
  it('splits a range the endpoint refuses until every part fits, and misses nothing', async () => {
    const { request, calls } = cappedEndpoint(30);
    const logs = await scanLogs(request, { address: '0x01' }, 0n, 99n);
    expect(logs.map((log) => Number(BigInt(log.blockNumber)))).toEqual(
      Array.from({ length: 100 }, (_, index) => index),
    );
    expect(calls[0]).toBe('0-99');
    expect(calls.length).toBeGreaterThan(1);
  });

  it('asks once when the range fits', async () => {
    const { request, calls } = cappedEndpoint(1_000);
    await scanLogs(request, {}, 10n, 20n);
    expect(calls).toEqual(['10-20']);
  });

  it('returns nothing for an empty range without asking', async () => {
    const { request, calls } = cappedEndpoint(1_000);
    expect(await scanLogs(request, {}, 5n, 4n)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('passes on any other error', async () => {
    const failing: RpcRequest = () => Promise.reject(new Error('connection refused'));
    await expect(scanLogs(failing, {}, 0n, 10n)).rejects.toThrow('connection refused');
  });

  it('gives up when a single block is already too many', async () => {
    const { request } = cappedEndpoint(0);
    await expect(scanLogs(request, {}, 3n, 3n)).rejects.toThrow('exceeds limit');
  });

  it('drops logs the endpoint marks as removed by a reorg', async () => {
    const request: RpcRequest = () =>
      Promise.resolve([
        {
          address: '0x01',
          topics: [],
          data: '0x',
          blockNumber: '0x1',
          blockHash: '0x',
          transactionHash: '0x',
          logIndex: '0x0',
          removed: true,
        },
      ]);
    expect(await scanLogs(request, {}, 1n, 1n)).toEqual([]);
  });
});

describe('isTooManyLogs', () => {
  it('recognises the refusal in a wrapped error', () => {
    const wrapped = new Error('RPC Request failed.', {
      cause: new Error('logs matched by query exceeds limit of 10000'),
    });
    expect(isTooManyLogs(wrapped)).toBe(true);
    expect(isTooManyLogs(new Error('HTTP response body exceeded the size limit.'))).toBe(true);
    expect(
      isTooManyLogs(
        Object.assign(new Error('Missing or invalid parameters.'), {
          details: 'Post "http://10.31.50.136:8547/rpc": context deadline exceeded',
        }),
      ),
    ).toBe(true);
    expect(isTooManyLogs(new Error('execution reverted'))).toBe(false);
  });
});
