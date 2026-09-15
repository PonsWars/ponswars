import { encodeEventTopics, encodeAbiParameters, parseAbiParameters, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { RawLog } from './log-scan.js';
import {
  decodeMarketEvent,
  logPosition,
  MARKET_EVENTS_ABI,
  MARKET_TOPICS,
} from './market-events.js';

const POOL_ID: Hex = `0x${'ab'.repeat(32)}`;
const TOKEN = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const WALLET = '0x00000000000000000000000000000000000000aa';

function log(
  topics: readonly Hex[],
  data: Hex,
  address = '0x0000000000000000000000000000000000000001',
): RawLog {
  return {
    address,
    topics,
    data,
    blockNumber: '0x10',
    blockHash: '0x00',
    transactionHash: '0xABCDEF',
    logIndex: '0x3',
    blockTimestamp: '0x6700000a',
  };
}

describe('decodeMarketEvent', () => {
  it('decodes a v4 pool initialization with its currencies and hook', () => {
    const topics = encodeEventTopics({
      abi: MARKET_EVENTS_ABI,
      eventName: 'Initialize',
      args: { id: POOL_ID, currency0: USDG, currency1: TOKEN },
    });
    const data = encodeAbiParameters(parseAbiParameters('uint24, int24, address, uint160, int24'), [
      3000,
      60,
      '0x0000000000000000000000000000000000000000',
      1n,
      0,
    ]);
    expect(topics[0]).toBe(MARKET_TOPICS.initialize);
    expect(decodeMarketEvent(log(topics as Hex[], data))).toEqual({
      kind: 'POOL_INITIALIZED',
      poolId: POOL_ID,
      currency0: USDG.toLowerCase(),
      currency1: TOKEN.toLowerCase(),
      hooks: '0x0000000000000000000000000000000000000000',
    });
  });

  it('decodes a swap with signed amounts', () => {
    const topics = encodeEventTopics({
      abi: MARKET_EVENTS_ABI,
      eventName: 'Swap',
      args: { id: POOL_ID, sender: WALLET },
    });
    const data = encodeAbiParameters(
      parseAbiParameters('int128, int128, uint160, uint128, int24, uint24'),
      [-210_000_000n, 10n ** 18n, 1n, 1n, 0, 3000],
    );
    expect(decodeMarketEvent(log(topics as Hex[], data))).toMatchObject({
      kind: 'SWAP',
      amount0: -210_000_000n,
      amount1: 10n ** 18n,
    });
  });

  it('reads a curve trade from the curve that emitted it, credited to the recipient', () => {
    const curve = '0x00000000000000000000000000000000000000c0';
    const topics = encodeEventTopics({
      abi: MARKET_EVENTS_ABI,
      eventName: 'CurveSell',
      args: { seller: '0x00000000000000000000000000000000000000ee', recipient: WALLET },
    });
    const data = encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, uint256'), [
      5n,
      42n,
      1n,
      0n,
    ]);
    expect(decodeMarketEvent(log(topics as Hex[], data, curve))).toEqual({
      kind: 'CURVE_TRADE',
      curve,
      trader: WALLET.toLowerCase(),
      quoteAmount: 42n,
    });
  });

  it('refuses a log whose data does not match its topic', () => {
    const topics = encodeEventTopics({
      abi: MARKET_EVENTS_ABI,
      eventName: 'Swap',
      args: { id: POOL_ID, sender: WALLET },
    });
    expect(() => decodeMarketEvent(log(topics as Hex[], '0x'))).toThrow();
  });
});

describe('logPosition', () => {
  it('identifies a log by transaction and index, and dates it from the block', () => {
    expect(logPosition(log([], '0x'))).toEqual({
      eventId: '0xabcdef:3',
      transactionHash: '0xabcdef',
      blockNumber: 16,
      at: 0x6700000a * 1_000,
    });
  });

  it('treats a zero block timestamp as no date, as the public endpoint sends it', () => {
    expect(logPosition({ ...log([], '0x'), blockTimestamp: '0x0' }).at).toBeNull();
    expect(logPosition({ ...log([], '0x'), blockTimestamp: undefined }).at).toBeNull();
  });
});
