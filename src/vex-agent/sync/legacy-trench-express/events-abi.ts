/**
 * The three Diamond EVENTS the legacy decoders read, and nothing else.
 *
 * The retired tool surface carried the full Diamond ABI (create, buy, sell,
 * quote, tokenInfo, fakepool_stats, the ERC-20 fragments). None of that can be
 * called any more, so none of it is kept: this fragment holds only what a
 * confirmed historical receipt is decoded WITH. Every input is unindexed on the
 * Blockscout-verified facet, which is why the decoders read `data` and match on
 * topic0.
 *
 * The positional names `a`, `b`, `v1`, `v2`, `v3` are the verified ABI's own.
 * Their meaning was proven by a funded probe and is asserted by the decoders'
 * cross-checks, never by the names.
 */

export const LEGACY_TRENCH_EVENT_ABI = [
  {
    type: "event",
    name: "TokenCreated",
    inputs: [
      { name: "token", type: "address", indexed: false },
      { name: "creator", type: "address", indexed: false },
      { name: "strategy", type: "uint8", indexed: false },
      { name: "dex", type: "uint8", indexed: false },
      { name: "data", type: "bytes", indexed: false },
      { name: "price", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Bought",
    inputs: [
      { name: "a", type: "address", indexed: false },
      { name: "b", type: "address", indexed: false },
      { name: "v1", type: "uint256", indexed: false },
      { name: "v2", type: "uint256", indexed: false },
      { name: "v3", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Sold",
    inputs: [
      { name: "a", type: "address", indexed: false },
      { name: "b", type: "address", indexed: false },
      { name: "v1", type: "uint256", indexed: false },
      { name: "v2", type: "uint256", indexed: false },
      { name: "v3", type: "uint256", indexed: false },
    ],
  },
] as const;
