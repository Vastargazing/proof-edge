// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Storage-free Merkle-root timestamping for budget-constrained testnet runs.
/// @dev Inclusion is verified against the emitted root. Anchor time is the
///      immutable timestamp of the transaction receipt's block.
contract ForecastRootEmitter {
    error EmptyRoot();
    error EmptyBatch();

    event RootAnchored(bytes32 indexed root, uint64 leafCount, address indexed submitter);
    event RootAnchoredWithLedgerHead(
        bytes32 indexed root,
        uint64 leafCount,
        bytes32 ledgerHead,
        address indexed submitter
    );

    function anchorRoot(bytes32 root, uint64 leafCount) external {
        if (root == bytes32(0)) revert EmptyRoot();
        if (leafCount == 0) revert EmptyBatch();
        emit RootAnchored(root, leafCount, msg.sender);
    }

    /// @notice Forward-only anchor format binding the Merkle root to the local
    /// append-only log prefix that existed immediately before batch creation.
    function anchorRootWithLedgerHead(bytes32 root, uint64 leafCount, bytes32 ledgerHead) external {
        if (root == bytes32(0) || ledgerHead == bytes32(0)) revert EmptyRoot();
        if (leafCount == 0) revert EmptyBatch();
        emit RootAnchoredWithLedgerHead(root, leafCount, ledgerHead, msg.sender);
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

    /// @notice Forward v2 verifier with explicit leaf/internal-node domains.
    function verifyLeafV2(
        bytes32 root,
        bytes32 commitment,
        bytes32[] calldata proof,
        uint256 index
    ) external pure returns (bool) {
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0x00), commitment));
        for (uint256 i = 0; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            hash = (index & 1) == 0
                ? keccak256(abi.encodePacked(bytes1(0x01), hash, sibling))
                : keccak256(abi.encodePacked(bytes1(0x01), sibling, hash));
            index >>= 1;
        }
        return hash == root;
    }
}
