/**
 * Trench Express Diamond trading ABI — verified fragments.
 *
 * Recovered from the Blockscout-verified Broker facet bundle and confirmed live
 * via loupe + 4 real funded transactions on RBC 4663 (see
 * `agents_dm/trench-live/trench-probe.ts`, `DIAMOND_ABI`). This is shared infra:
 * P2 (`trade_quote`/`trade_execute`) and P3 (`launch_*`) import these fragments
 * rather than re-declaring them, so a single verified source backs every
 * money-path call.
 *
 * NOTE: a `TokenLaunched` event was named in the P1 brief but is NOT present in
 * the verified probe bundle, so it is intentionally omitted rather than
 * hand-written — an unverified event fragment must not enter a money path
 * (rule 90). The verified events are `TokenCreated`, `Bought`, `Sold`.
 */

/** Diamond trading facet: create / buy / sell / quote / tokenInfo / fakepool_stats + events. */
export const TRENCH_DIAMOND_ABI = [
  {
    type: "function",
    name: "create",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "description", type: "string" },
      { name: "image", type: "bytes" },
      { name: "links", type: "string[]" },
      { name: "data", type: "bytes" },
      { name: "strategy", type: "uint8" },
      { name: "dex", type: "uint8" },
      { name: "initialBuy", type: "uint256" },
    ],
    outputs: [{ name: "token", type: "address" }],
  },
  {
    type: "function",
    name: "buy",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "min", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sell",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "min", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "ethOut", type: "bool" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenInfo",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "creator", type: "address" },
          { name: "strategy", type: "uint8" },
          { name: "dex", type: "uint8" },
          { name: "pair", type: "address" },
          { name: "launched", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "fakepool_stats",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "ethReserve", type: "uint256" },
      { name: "tokenReserve", type: "uint256" },
      { name: "fakeEth", type: "uint256" },
      { name: "price", type: "uint256" },
    ],
  },
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

/** Minimal ERC-20 fragments the sell path needs (approve → sell). Shared infra for P2. */
export const TRENCH_ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "o", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "s", type: "address" },
      { name: "v", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "o", type: "address" },
      { name: "s", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;
