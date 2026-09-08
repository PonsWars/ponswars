// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @notice Builds Merkle roots and proofs the way `MerkleProof` verifies them.
/// @dev Sorted-pair hashing, matching OpenZeppelin's default. Leaves are
/// double-hashed for the reason `RewardsDistributor.claim` documents: a
/// single-hashed leaf can collide with an internal node, which would let a
/// crafted proof authorise a payout that was never allocated.
///
/// Test-only. The production tree is built offchain by the Rewards Engine; this
/// exists so a contract test can prove a real proof verifies without trusting
/// that builder.
library MerkleHelper {
    /// @notice The leaf for one allocation.
    function leafOf(uint256 distributionId, address account, uint256 amount)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(distributionId, account, amount))));
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    /// @notice Root of a tree over `leaves`.
    /// @dev An odd node at any level is promoted unchanged, which is the
    /// convention the proof builder below mirrors.
    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        require(leaves.length > 0, "MerkleHelper: empty");
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            uint256 next = (level.length + 1) / 2;
            // Allocating a level per iteration is inherent to building the tree
            // bottom-up, and this is a pure memory allocation rather than the
            // external call the lint is looking for.
            // forge-lint: disable-next-line(calls-loop)
            bytes32[] memory parents = new bytes32[](next);
            for (uint256 i = 0; i < next; i++) {
                uint256 left = i * 2;
                uint256 right = left + 1;
                parents[i] =
                    right < level.length ? _hashPair(level[left], level[right]) : level[left];
            }
            level = parents;
        }
        return level[0];
    }

    /// @notice Proof for the leaf at `index`.
    function proof(bytes32[] memory leaves, uint256 index)
        internal
        pure
        returns (bytes32[] memory)
    {
        require(index < leaves.length, "MerkleHelper: index");

        bytes32[] memory path = new bytes32[](32);
        uint256 depth = 0;
        bytes32[] memory level = leaves;
        uint256 position = index;

        while (level.length > 1) {
            uint256 sibling = position % 2 == 0 ? position + 1 : position - 1;
            if (sibling < level.length) {
                path[depth] = level[sibling];
                depth++;
            }

            uint256 next = (level.length + 1) / 2;
            // Allocating a level per iteration is inherent to building the tree
            // bottom-up, and this is a pure memory allocation rather than the
            // external call the lint is looking for.
            // forge-lint: disable-next-line(calls-loop)
            bytes32[] memory parents = new bytes32[](next);
            for (uint256 i = 0; i < next; i++) {
                uint256 left = i * 2;
                uint256 right = left + 1;
                parents[i] =
                    right < level.length ? _hashPair(level[left], level[right]) : level[left];
            }
            level = parents;
            position /= 2;
        }

        bytes32[] memory trimmed = new bytes32[](depth);
        for (uint256 i = 0; i < depth; i++) {
            trimmed[i] = path[i];
        }
        return trimmed;
    }
}
