export const forecastRootRegistryAbi = [
  {
    type: "function",
    name: "anchorRoot",
    stateMutability: "nonpayable",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "leafCount", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "verifyLeaf",
    stateMutability: "view",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "leaf", type: "bytes32" },
      { name: "proof", type: "bytes32[]" },
      { name: "index", type: "uint256" },
      { name: "expiryNs", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "anchors",
    stateMutability: "view",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [
      { name: "blockNumber", type: "uint64" },
      { name: "blockTimestamp", type: "uint64" },
      { name: "leafCount", type: "uint64" },
    ],
  },
] as const;
