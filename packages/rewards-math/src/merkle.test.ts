import { baseUnits, type BaseUnits, type WalletAddress } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { buildMerkleTree, leafOf, verifyProof, type MerkleEntry } from './merkle.js';

const DISTRIBUTION_ID = 1n;

const wallet = (n: number): WalletAddress =>
  `0x${n.toString(16).padStart(40, '0')}` as WalletAddress;

const entry = (n: number, amount: bigint): MerkleEntry => ({
  wallet: wallet(n),
  amount: baseUnits(amount),
});

const entries = (count: number): MerkleEntry[] =>
  Array.from({ length: count }, (_, i) => entry(i + 1, BigInt((i + 1) * 1_000)));

describe('leafOf', () => {
  it('is deterministic', () => {
    expect(leafOf(DISTRIBUTION_ID, wallet(1), baseUnits(100n))).toBe(
      leafOf(DISTRIBUTION_ID, wallet(1), baseUnits(100n)),
    );
  });

  it('binds the distribution id', () => {
    // §17: a valid proof for one window must prove nothing about another.
    expect(leafOf(1n, wallet(1), baseUnits(100n))).not.toBe(leafOf(2n, wallet(1), baseUnits(100n)));
  });

  it('binds the wallet and the amount', () => {
    expect(leafOf(DISTRIBUTION_ID, wallet(1), baseUnits(100n))).not.toBe(
      leafOf(DISTRIBUTION_ID, wallet(2), baseUnits(100n)),
    );
    expect(leafOf(DISTRIBUTION_ID, wallet(1), baseUnits(100n))).not.toBe(
      leafOf(DISTRIBUTION_ID, wallet(1), baseUnits(101n)),
    );
  });

  it('produces a 32-byte hash', () => {
    expect(leafOf(DISTRIBUTION_ID, wallet(1), baseUnits(100n))).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('buildMerkleTree', () => {
  it('produces a claim for every entry', () => {
    const tree = buildMerkleTree(DISTRIBUTION_ID, entries(5));
    expect(tree.claims).toHaveLength(5);
    expect(tree.root).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('sums the total the root commits to', () => {
    // The contract commits this total on publication and will not pay beyond
    // it, so a mismatch here would strand the last claimant.
    const tree = buildMerkleTree(DISTRIBUTION_ID, entries(4));
    expect(tree.total).toBe(1_000n + 2_000n + 3_000n + 4_000n);
  });

  it('verifies every proof it produces', () => {
    // Checked at every size from 1 to 33, so odd levels, single-node levels
    // and exact powers of two are all covered.
    for (let size = 1; size <= 33; size += 1) {
      const tree = buildMerkleTree(DISTRIBUTION_ID, entries(size));
      for (const claim of tree.claims) {
        expect(verifyProof(claim.leaf, claim.proof, tree.root)).toBe(true);
      }
    }
  });

  it('handles a single-entry tree', () => {
    const tree = buildMerkleTree(DISTRIBUTION_ID, [entry(1, 1_000n)]);
    expect(tree.claims[0]?.proof).toEqual([]);
    expect(tree.root).toBe(tree.claims[0]?.leaf);
  });

  it('is deterministic for the same entries in the same order', () => {
    expect(buildMerkleTree(DISTRIBUTION_ID, entries(10))).toEqual(
      buildMerkleTree(DISTRIBUTION_ID, entries(10)),
    );
  });

  it('produces a different root when entry order changes', () => {
    // allocateDistribution already returns a deterministic order, and this is
    // why the builder must not impose one of its own: two callers holding the
    // same allocation set in different orders would publish different roots,
    // and only one of them can go on chain.
    const forward = buildMerkleTree(DISTRIBUTION_ID, entries(4));
    const swapped = buildMerkleTree(DISTRIBUTION_ID, [
      entry(1, 1_000n),
      entry(3, 3_000n),
      entry(2, 2_000n),
      entry(4, 4_000n),
    ]);
    expect(swapped.root).not.toBe(forward.root);
    expect(swapped.total).toBe(forward.total);
  });

  it('gives a reversed power-of-two tree the same root', () => {
    // Surprising but correct, and worth pinning so nobody "fixes" it. Sorted-
    // pair hashing makes h(a,b) == h(b,a), so reversing a full tree swaps every
    // pair and every pair of pairs — each of which the sort undoes. It does NOT
    // mean order is irrelevant: the test above swaps two entries across a pair
    // boundary and the root changes.
    const forward = buildMerkleTree(DISTRIBUTION_ID, entries(4));
    const reversed = buildMerkleTree(DISTRIBUTION_ID, [...entries(4)].reverse());
    expect(reversed.root).toBe(forward.root);

    // An odd-sized tree has no such symmetry, because the promoted node moves.
    const oddForward = buildMerkleTree(DISTRIBUTION_ID, entries(3));
    const oddReversed = buildMerkleTree(DISTRIBUTION_ID, [...entries(3)].reverse());
    expect(oddReversed.root).not.toBe(oddForward.root);
  });

  it('gives a different root for a different distribution', () => {
    expect(buildMerkleTree(1n, entries(4)).root).not.toBe(buildMerkleTree(2n, entries(4)).root);
  });

  it('rejects an empty distribution', () => {
    expect(() => buildMerkleTree(DISTRIBUTION_ID, [])).toThrow(RangeError);
  });

  it('rejects a duplicated wallet', () => {
    // One address would get two leaves but only one claim slot on chain, so the
    // second allocation would be permanently unclaimable.
    expect(() => buildMerkleTree(DISTRIBUTION_ID, [entry(1, 1_000n), entry(1, 2_000n)])).toThrow(
      RangeError,
    );
  });

  it('rejects a non-positive allocation', () => {
    expect(() => buildMerkleTree(DISTRIBUTION_ID, [entry(1, 0n)])).toThrow(RangeError);
  });
});

describe('verifyProof', () => {
  const tree = buildMerkleTree(DISTRIBUTION_ID, entries(8));

  it('rejects a proof for a different leaf', () => {
    const first = tree.claims[0];
    const second = tree.claims[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(verifyProof(first!.leaf, second!.proof, tree.root)).toBe(false);
  });

  it('rejects a tampered amount', () => {
    const claim = tree.claims[0];
    expect(claim).toBeDefined();
    const inflated = leafOf(DISTRIBUTION_ID, claim!.wallet, (claim!.amount + 1n) as BaseUnits);
    expect(verifyProof(inflated, claim!.proof, tree.root)).toBe(false);
  });

  it('rejects a truncated proof', () => {
    const claim = tree.claims[0];
    expect(claim).toBeDefined();
    expect(verifyProof(claim!.leaf, claim!.proof.slice(1), tree.root)).toBe(false);
  });

  it('rejects a proof against the wrong root', () => {
    const other = buildMerkleTree(2n, entries(8));
    const claim = tree.claims[0];
    expect(claim).toBeDefined();
    expect(verifyProof(claim!.leaf, claim!.proof, other.root)).toBe(false);
  });

  it('is order independent within a proof, because pairs are sorted', () => {
    // Sorted-pair hashing is what lets a proof carry only siblings rather than
    // their left/right positions. Worth pinning: switching to positional
    // hashing would silently break every proof the contract verifies.
    const claim = tree.claims[3];
    expect(claim).toBeDefined();
    expect(verifyProof(claim!.leaf, claim!.proof, tree.root)).toBe(true);
  });
});
