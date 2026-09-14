/**
 * The calldata for `RewardsDistributor.claim` (§16.8, §17).
 *
 * Written out by hand rather than pulling an ABI library into the client for
 * one function with a fixed signature: four static words and one `bytes32[]`.
 * The test encodes the same call with viem and compares the bytes, so this
 * cannot drift from the ABI without failing.
 *
 *   claim(uint256 distributionId, address account, uint256 amount, bytes32[] proof)
 */

/** `keccak256("claim(uint256,address,uint256,bytes32[])")[:4]`. */
export const CLAIM_SELECTOR = '0x2e7ba6ef';

export function claimCalldata(input: {
  readonly distributionId: bigint;
  readonly account: string;
  readonly amount: bigint;
  readonly proof: readonly string[];
}): `0x${string}` {
  if (input.distributionId < 0n || input.amount < 0n) {
    throw new RangeError('A distribution id and an amount are never negative');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.account)) {
    throw new RangeError(`Not an address: ${input.account}`);
  }
  for (const node of input.proof) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(node)) {
      throw new RangeError(`Not a 32-byte proof node: ${node}`);
    }
  }

  const words = [
    uint(input.distributionId),
    input.account.slice(2).toLowerCase().padStart(64, '0'),
    uint(input.amount),
    // The array lives after the four head words: offset 4 × 32 bytes.
    uint(4n * 32n),
    uint(BigInt(input.proof.length)),
    ...input.proof.map((node) => node.slice(2).toLowerCase()),
  ];
  return `${CLAIM_SELECTOR}${words.join('')}`;
}

function uint(value: bigint): string {
  const hex = value.toString(16);
  if (hex.length > 64) {
    throw new RangeError('A uint256 is at most 32 bytes');
  }
  return hex.padStart(64, '0');
}
