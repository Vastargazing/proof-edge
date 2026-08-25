// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Storage-free Merkle-root timestamping for budget-constrained testnet runs.
/// @dev Inclusion is verified against the emitted root. Anchor time is the
///      immutable timestamp of the transaction receipt's block.
contract ForecastRootEmitter {
    error EmptyRoot();
    error EmptyBatch();

    event RootAnchored(bytes32 indexed root, uint64 leafCount, address indexed submitter);

    function anchorRoot(bytes32 root, uint64 leafCount) external {
        if (root == bytes32(0)) revert EmptyRoot();
        if (leafCount == 0) revert EmptyBatch();
        emit RootAnchored(root, leafCount, msg.sender);
    }

    function verifyLeaf(
        bytes32 root,
        bytes32 leaf,
        bytes32[] calldata proof,
        uint256 index
    ) external pure returns (bool) {
        bytes32 hash = leaf;
        for (uint256 i = 0; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            hash = (index & 1) == 0
                ? keccak256(abi.encodePacked(hash, sibling))
                : keccak256(abi.encodePacked(sibling, hash));
            index >>= 1;
        }
        return hash == root;
    }
}
