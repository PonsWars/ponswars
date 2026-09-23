/**
 * Reading event logs from an endpoint that caps how many one query may return.
 *
 * Robinhood Chain's public RPC refuses an `eth_getLogs` whose match exceeds ten
 * thousand logs, and the chain is busy enough that a two-minute range of the
 * Uniswap v4 PoolManager already does. So a range is asked for whole and, when
 * the endpoint refuses it as too large, split in half and asked for again —
 * down to a single block, which is as far as splitting can go.
 *
 * The raw JSON-RPC shape comes back rather than a decoded one, because the
 * decoder is the caller's and because this endpoint adds `blockTimestamp` to
 * every log: the one field a market needs that the standard shape lacks, and
 * the one that saves a block lookup per trade.
 */

/** A log as `eth_getLogs` returns it. Hex strings throughout. */
export interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: string;
  readonly removed?: boolean;
  /** Seconds, as hex. Present on Robinhood Chain; not every endpoint sends it. */
  readonly blockTimestamp?: string;
}

/** A filter, in `eth_getLogs` terms, without the range. */
export interface LogFilter {
  readonly address?: string | readonly string[];
  /** `null` is a wildcard; an array is an OR. */
  readonly topics?: readonly (string | readonly string[] | null)[];
}

/** One JSON-RPC call. */
export type RpcRequest = (method: string, params: readonly unknown[]) => Promise<unknown>;

/** Whether an error is the endpoint saying the result would be too large. */
export function isTooManyLogs(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return (
    text.includes('exceeds limit') ||
    text.includes('query returned more than') ||
    // "too many logs" and "too many results", never a bare "too many": "too
    // many requests" is the endpoint asking for a slower caller, which is
    // `isThrottled`'s, and reading it here would split a range for ever.
    text.includes('too many logs') ||
    text.includes('too many results') ||
    text.includes('response size exceeded') ||
    // viem's own limit on how large a response it will read.
    text.includes('exceeded the size limit') ||
    // The node gave up before the query finished: too much to scan at once.
    // The public endpoint reports it as invalid parameters, with this detail.
    text.includes('context deadline exceeded') ||
    text.includes('block range')
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const details = (error as { details?: unknown }).details;
    return `${error.message} ${typeof details === 'string' ? details : ''} ${errorText(error.cause)}`;
  }
  return typeof error === 'string' ? error : '';
}

const hex = (value: bigint): string => `0x${value.toString(16)}`;

/**
 * Every log matching `filter` in `[from, to]`, oldest first.
 *
 * @throws the endpoint's error when it is anything but "too many logs", and
 *   when a single block alone is too many — splitting cannot help there.
 */
export async function scanLogs(
  request: RpcRequest,
  filter: LogFilter,
  from: bigint,
  to: bigint,
): Promise<RawLog[]> {
  if (to < from) {
    return [];
  }
  const collected: RawLog[] = [];
  // A stack of ranges still to read, newest last so the oldest is read first.
  const pending: [bigint, bigint][] = [[from, to]];
  while (pending.length > 0) {
    const range = pending.pop();
    if (range === undefined) {
      break;
    }
    const [start, end] = range;
    try {
      const result = await request('eth_getLogs', [
        { ...filter, fromBlock: hex(start), toBlock: hex(end) },
      ]);
      if (!Array.isArray(result)) {
        throw new Error('eth_getLogs did not return an array');
      }
      collected.push(...(result as RawLog[]).filter((log) => log.removed !== true));
    } catch (error) {
      if (!isTooManyLogs(error) || start === end) {
        throw error;
      }
      const middle = start + (end - start) / 2n;
      // Pushed newer half first, so the older half is read next.
      pending.push([middle + 1n, end], [start, middle]);
    }
  }
  return collected.sort(compareLogs);
}

/** Chain order: block, then position in the block. */
export function compareLogs(a: RawLog, b: RawLog): number {
  const blockA = BigInt(a.blockNumber);
  const blockB = BigInt(b.blockNumber);
  if (blockA !== blockB) {
    return blockA < blockB ? -1 : 1;
  }
  const indexA = BigInt(a.logIndex);
  const indexB = BigInt(b.logIndex);
  return indexA === indexB ? 0 : indexA < indexB ? -1 : 1;
}
