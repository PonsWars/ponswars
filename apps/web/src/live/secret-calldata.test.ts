import { encodeFunctionData, parseAbi } from 'viem';
import { describe, expect, it } from 'vitest';
import { SECRET_CLAIM_CALLDATA } from './secret-calldata.js';

describe('SECRET_CLAIM_CALLDATA', () => {
  it('is what the vault ABI encodes for claim()', () => {
    expect(SECRET_CLAIM_CALLDATA).toBe(
      encodeFunctionData({ abi: parseAbi(['function claim()']), functionName: 'claim' }),
    );
  });
});
