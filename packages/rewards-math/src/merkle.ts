import type { BaseUnits, WalletAddress } from '@ponswars/shared-types';
import { concatHex, encodeAbiParameters, keccak256, type Hex } from 'viem';

/**
 * Merkle tree for reward claims (§17).
 *
 * **This module and `RewardsDistributor.claim` must agree exactly.** A tree
 * built here that the contract will not verify makes a whole distribution
 * unclaimable; a tree the contract verifies too loosely lets someone claim
 * SPY they were never allocated. The conformance test in
 * `contracts/test/MerkleConformance.t.sol` runs proofs produced by this code
 * through the deployed contract, so the two cannot drift apart unnoticed.
 *
 * Three conventions, all matching OpenZeppelin's `MerkleProof`:
 *
 * 1. **Leaves are double-hashed.** A single `keccak256(abi.encode(...))` leaf
 *    can be forged into a position where it collides with an internal node,
 *    letting a crafted proof authorise a payout that was never in the
 *    allocation set. Hashing twice puts leaves in a domain internal nodes
 *    cannot reach.
 * 2. **Pairs are sorted before hashing**, so a proof carries only siblings and
 *    not their left/right position.
 * 3. **An odd node is promoted unchanged** to the next level.
 *
 * Encoding uses `viem`'s `encodeAbiParameters`, which is the same ABI encoding
 * Solidity's `abi.encode` produces — not a hand-rolled concatenation that could
 * differ on padding.
 */

/** One wallet's entry in a distribution tree. */
export interface MerkleEntry {
  readonly wallet: WalletAddress;
  readonly amount: BaseUnits;
}

/** A wallet's claim material: what to pass to `RewardsDistributor.claim`. */
export interface MerkleClaim {
  readonly wallet: WalletAddress;
  readonly amount: BaseUnits;
  readonly leaf: Hex;
  readonly proof: readonly Hex[];
}

export interface MerkleTree {
  readonly root: Hex;
  readonly claims: readonly MerkleClaim[];
  /** Sum of every allocation. Published alongside the root and committed on chain. */
  readonly total: BaseUnits;
}

/**
 * Computes the leaf for one allocation.
 *
 * The distribution id is inside the leaf, so a valid proof for one window
 * proves nothing about another.
 */
export function leafOf(distributionId: bigint, wallet: WalletAddress, amount: BaseUnits): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }],
      [distributionId, wallet as Hex, amount],
    ),
  );
  return keccak256(inner);
}

function hashPair(left: Hex, right: Hex): Hex {
  const [a, b] = left.toLowerCase() < right.toLowerCase() ? [left, right] : [right, left];
  return keccak256(concatHex([a, b]));
}

function buildLevels(leaves: readonly Hex[]): Hex[][] {
  const levels: Hex[][] = [[...leaves]];
  let current = levels[0] ?? [];

  while (current.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1];
      /* c8 ignore next 3 -- unreachable: i is always within bounds. */
      if (left === undefined) {
        throw new Error('Merkle level index out of range');
      }
      next.push(right === undefined ? left : hashPair(left, right));
    }
    levels.push(next);
    current = next;
  }

  return levels;
}

/**
 * Builds the tree for a distribution.
 *
 * Entries are **not** reordered. `allocateDistribution` already returns a
 * deterministic order, and re-sorting here would mean two callers holding the
 * same allocation set could publish two different roots for it.
 *
 * @throws RangeError on an empty set, a duplicate wallet, or a non-positive
 *   amount. Each would produce a tree that is wrong rather than merely odd: an
 *   empty root is unclaimable, a duplicate wallet gives one address two leaves
 *   and only one claim slot, and a zero amount is a leaf nobody can use.
 */
export function buildMerkleTree(
  distributionId: bigint,
  entries: readonly MerkleEntry[],
): MerkleTree {
  if (entries.length === 0) {
    throw new RangeError('Cannot build a Merkle tree for an empty distribution');
  }

  const seen = new Set<string>();
  let total = 0n;
  for (const entry of entries) {
    const key = entry.wallet.toLowerCase();
    if (seen.has(key)) {
      throw new RangeError(`Wallet ${entry.wallet} appears twice in the distribution`);
    }
    seen.add(key);
    if (entry.amount <= 0n) {
      throw new RangeError(`Allocation for ${entry.wallet} must be positive`);
    }
    total += entry.amount;
  }

  const leaves = entries.map((entry) => leafOf(distributionId, entry.wallet, entry.amount));
  const levels = buildLevels(leaves);
  const rootLevel = levels[levels.length - 1];
  const root = rootLevel?.[0];
  /* c8 ignore next 3 -- unreachable: buildLevels always ends on one node. */
  if (root === undefined) {
    throw new Error('Merkle tree has no root');
  }

  const claims: MerkleClaim[] = entries.map((entry, index) => {
    const proof: Hex[] = [];
    let position = index;

    for (let depth = 0; depth < levels.length - 1; depth += 1) {
      const level = levels[depth];
      /* c8 ignore next 1 -- unreachable: depth is bounded by levels.length. */
      if (level === undefined) break;

      const siblingIndex = position % 2 === 0 ? position + 1 : position - 1;
      const sibling = level[siblingIndex];
      // An odd final node has no sibling; it is promoted unchanged, so nothing
      // is added to the proof at this depth.
      if (sibling !== undefined) {
        proof.push(sibling);
      }
      position = Math.floor(position / 2);
    }

    const leaf = leaves[index];
    /* c8 ignore next 3 -- unreachable: leaves and entries are the same length. */
    if (leaf === undefined) {
      throw new Error('Merkle leaf index out of range');
    }
    return { wallet: entry.wallet, amount: entry.amount, leaf, proof };
  });

  return { root, claims, total: total as BaseUnits };
}

/**
 * Verifies a proof the way the contract does.
 *
 * Used by the publication path to check every proof before a root goes on
 * chain: a root is immutable once published (§17), so a tree that fails here
 * has to be caught before that, not after.
 */
export function verifyProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  let computed = leaf;
  for (const sibling of proof) {
    computed = hashPair(computed, sibling);
  }
  return computed.toLowerCase() === root.toLowerCase();
}
