import { walletAddress, type WalletAddress } from '@ponswars/shared-types';
import { decodeEventLog, parseAbi, toEventSelector, type Hex } from 'viem';
import { scanLogs, type RawLog, type RpcRequest } from './log-scan.js';

/**
 * Claims read back from `RewardsDistributor` (§17, §35.6).
 *
 * A claim is the player's own transaction: this service never sends one and
 * holds no key that could. What it can do is read the events back, so a page
 * can say a reward was claimed without an RPC call per allocation on every
 * request, and so a distribution's take-up is answerable from the record.
 *
 * Only the log is decoded. Whether an allocation existed, and for how much, is
 * the published tree's business; a `Claimed` event is evidence that the
 * contract paid, which is a different fact from the one the tree carries.
 */

const CLAIMED_ABI = parseAbi([
  'event Claimed(uint256 indexed distributionId, address indexed account, uint256 amount)',
]);

/** Topic 0 of `Claimed`, for the filter. */
export const CLAIMED_TOPIC = toEventSelector(CLAIMED_ABI[0]);

export interface RewardClaimEvent {
  readonly distributionId: bigint;
  readonly wallet: WalletAddress;
  readonly amount: bigint;
  readonly blockNumber: number;
  readonly transactionHash: `0x${string}`;
  readonly logIndex: number;
}

/**
 * Every claim the distributor emitted in `[from, to]`, oldest first.
 *
 * The range is split when an endpoint refuses it for size, the way every other
 * log read here is. A log that does not decode as `Claimed` is an error rather
 * than a skipped line: the filter asked for one topic from one address, so
 * anything else means the address is not the contract it was said to be.
 */
export async function readRewardClaims(
  request: RpcRequest,
  distributor: string,
  from: bigint,
  to: bigint,
): Promise<readonly RewardClaimEvent[]> {
  const logs = await scanLogs(request, { address: distributor, topics: [CLAIMED_TOPIC] }, from, to);
  return logs.map((log) => decodeClaim(log));
}

function decodeClaim(log: RawLog): RewardClaimEvent {
  const decoded = decodeEventLog({
    abi: CLAIMED_ABI,
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data as Hex,
    strict: true,
  });
  return {
    distributionId: decoded.args.distributionId,
    wallet: walletAddress(decoded.args.account.toLowerCase()),
    amount: decoded.args.amount,
    blockNumber: Number(BigInt(log.blockNumber)),
    transactionHash: log.transactionHash.toLowerCase() as `0x${string}`,
    logIndex: Number(BigInt(log.logIndex)),
  };
}
