import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { CLAIM_SELECTOR, claimCalldata } from './claim-calldata.js';

const ABI = parseAbi(['function claim(uint256,address,uint256,bytes32[])']);
const ACCOUNT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('claim calldata', () => {
  it('uses the selector of RewardsDistributor.claim', () => {
    expect(CLAIM_SELECTOR).toBe(toFunctionSelector('claim(uint256,address,uint256,bytes32[])'));
  });

  it('matches the ABI encoding byte for byte, for proofs of every length', () => {
    for (const length of [0, 1, 2, 7, 20]) {
      const proof = Array.from(
        { length },
        (_, index) => `0x${(index + 1).toString(16).padStart(2, '0').repeat(32)}` as const,
      );
      const input = {
        distributionId: 1_234n,
        account: ACCOUNT,
        amount: 397_490_599_996_082_683n,
        proof,
      };

      expect(claimCalldata(input)).toBe(
        encodeFunctionData({
          abi: ABI,
          functionName: 'claim',
          args: [input.distributionId, ACCOUNT, input.amount, proof],
        }),
      );
    }
  });

  it('encodes the largest amounts exactly', () => {
    const max = 2n ** 256n - 1n;
    expect(claimCalldata({ distributionId: max, account: ACCOUNT, amount: max, proof: [] })).toBe(
      encodeFunctionData({ abi: ABI, functionName: 'claim', args: [max, ACCOUNT, max, []] }),
    );
    expect(() =>
      claimCalldata({ distributionId: 2n ** 256n, account: ACCOUNT, amount: 1n, proof: [] }),
    ).toThrow(RangeError);
  });

  it('refuses what is not an address, a proof node or an amount', () => {
    expect(() =>
      claimCalldata({ distributionId: 1n, account: '0x12', amount: 1n, proof: [] }),
    ).toThrow(RangeError);
    expect(() =>
      claimCalldata({ distributionId: 1n, account: ACCOUNT, amount: 1n, proof: ['0x1234'] }),
    ).toThrow(RangeError);
    expect(() =>
      claimCalldata({ distributionId: 1n, account: ACCOUNT, amount: -1n, proof: [] }),
    ).toThrow(RangeError);
  });
});
