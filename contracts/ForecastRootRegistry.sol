// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice One-storage-slot timestamped Merkle anchors for forecast commitments.
/// @dev The root is the batch id. Preimages and proofs are revealed offchain;
///      this contract can verify membership and that anchoring preceded expiry.
contract ForecastRootRegistry {
    struct Anchor {
        uint64 blockNumber;
        uint64 blockTimestamp;
        uint64 leafCount;
    }

    mapping(bytes32 root => Anchor) public anchors;

    error EmptyRoot();
    error EmptyBatch();
    error AlreadyAnchored(bytes32 root);

    event RootAnchored(
        bytes32 indexed root,
        uint64 leafCount,
        uint64 blockNumber,
        uint64 blockTimestamp,
        address indexed submitter
    );

    function anchorRoot(bytes32 root, uint64 leafCount) external {
        if (root == bytes32(0)) revert EmptyRoot();
        if (leafCount == 0) revert EmptyBatch();
        if (anchors[root].blockNumber != 0) revert AlreadyAnchored(root);

        Anchor memory anchor = Anchor({
            blockNumber: uint64(block.number),
            blockTimestamp: uint64(block.timestamp),
            leafCount: leafCount
        });
        anchors[root] = anchor;
        emit RootAnchored(root, leafCount, anchor.blockNumber, anchor.blockTimestamp, msg.sender);
    }

    function verifyLeaf(
        bytes32 root,
        bytes32 leaf,
        bytes32[] calldata proof,
        uint256 index,
        uint256 expiryNs
    ) external view returns (bool) {
        Anchor memory anchor = anchors[root];
        if (anchor.blockNumber == 0) return false;
        if (uint256(anchor.blockTimestamp) * 1e9 >= expiryNs) return false;

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
