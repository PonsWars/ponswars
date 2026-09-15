import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  parseAbiParameters,
  type Hex,
} from 'viem';
import { readRewardClaims, CLAIMED_TOPIC } from './claim-reader.js';
import type { RawLog, RpcRequest } from './log-scan.js';

const DISTRIBUTOR = '0x00000000000000000000000000000000000000d1';
const WALLET = '0x00000000000000000000000000000000000000aa';
const CLAIMED = parseAbi([
  'event Claimed(uint256 indexed distributionId, address indexed account, uint256 amount)',
]);

const claimLog = (distributionId: bigint, amount: bigint, block: number): RawLog => ({
  address: DISTRIBUTOR,
  topics: encodeEventTopics({
    abi: CLAIMED,
    eventName: 'Claimed',
    args: { distributionId, account: WALLET as Hex },
  }) as Hex[],
  data: encodeAbiParameters(parseAbiParameters('uint256'), [amount]),
  blockNumber: `0x${block.toString(16)}`,
  blockHash: '0x00',
  transactionHash: `0x${'ab'.repeat(32)}`,
  logIndex: '0x2',
});

describe('readRewardClaims', () => {
  it('asks the distributor for its Claimed logs and decodes each one', async () => {
    const asked: unknown[] = [];
    const request: RpcRequest = (method, params) => {
      asked.push(params[0]);
      expect(method).toBe('eth_getLogs');
      return Promise.resolve([claimLog(8n, 400n, 100), claimLog(9n, 10n, 120)]);
    };

    const claims = await readRewardClaims(request, DISTRIBUTOR, 50n, 200n);

    expect(asked).toEqual([
      { address: DISTRIBUTOR, topics: [CLAIMED_TOPIC], fromBlock: '0x32', toBlock: '0xc8' },
    ]);
    expect(claims).toEqual([
      {
        distributionId: 8n,
        wallet: WALLET,
        amount: 400n,
        blockNumber: 100,
        transactionHash: `0x${'ab'.repeat(32)}`,
        logIndex: 2,
      },
      expect.objectContaining({ distributionId: 9n, amount: 10n, blockNumber: 120 }),
    ]);
  });

  it('refuses a log that is not a claim, rather than skipping it', async () => {
    // The filter named one address and one topic, so anything else means the
    // address is not the contract it was configured as.
    const request: RpcRequest = () =>
      Promise.resolve([{ ...claimLog(1n, 1n, 1), data: '0x' } satisfies RawLog]);

    await expect(readRewardClaims(request, DISTRIBUTOR, 0n, 1n)).rejects.toThrow();
  });
});
