/**
 * Permit2: the CANONICAL deployment addresses and the v1 ABI subset.
 *
 * Permit2 is a single approval-and-transfer contract that a user grants a
 * blanket ERC-20 allowance to once, after which any of its `permit` /
 * `transferFrom` calls can move that allowance. Decoding it against the wrong
 * address is therefore not a cosmetic error: an arbitrary contract that
 * implements the same selectors would be displayed to the user as "Permit2",
 * which is the whole attack.
 *
 * So the address is an ALLOWLIST keyed by chain id, not a well-known constant
 * assumed to hold everywhere. Permit2 is deployed through the deterministic
 * deployer at the same address on the EVM chains below; zkSync Era is
 * deliberately ABSENT because its native `CREATE2` derivation differs and its
 * deployment lives at a DIFFERENT address, so a chain-agnostic constant would
 * have accepted the wrong contract there. A chain that is not in this table
 * refuses Permit2 calldata rather than guessing.
 */

/** The deterministic-deployer address Permit2 occupies on the listed chains. */
const PERMIT2_DETERMINISTIC = "0x000000000022d473030f116ddee9f6b43ac78ba3";

/**
 * chain id -> canonical Permit2 address, lowercased.
 *
 * Verified members of the deterministic deployment: Ethereum, Optimism, BNB
 * Chain, Polygon, Base, Arbitrum One, Avalanche C-Chain, and their public
 * testnets Sepolia, Base Sepolia and Arbitrum Sepolia. Every other chain, zkSync
 * Era included, is an explicit miss.
 */
export const CANONICAL_PERMIT2_BY_CHAIN_ID: ReadonlyMap<number, string> = new Map([
  [1, PERMIT2_DETERMINISTIC],
  [10, PERMIT2_DETERMINISTIC],
  [56, PERMIT2_DETERMINISTIC],
  [137, PERMIT2_DETERMINISTIC],
  [8453, PERMIT2_DETERMINISTIC],
  [42161, PERMIT2_DETERMINISTIC],
  [43114, PERMIT2_DETERMINISTIC],
  [11155111, PERMIT2_DETERMINISTIC],
  [84532, PERMIT2_DETERMINISTIC],
  [421614, PERMIT2_DETERMINISTIC],
]);

export function canonicalPermit2Address(chainId: number): string | undefined {
  return CANONICAL_PERMIT2_BY_CHAIN_ID.get(chainId);
}

/**
 * The v1 Permit2 decode set: `approve`, `permit` (single) and `transferFrom`.
 *
 * `permitBatch` and the batched `transferFrom` overload are NOT here. They are
 * not harder to decode; they are harder to DISPLAY honestly, because one
 * approval card would have to carry N spender/amount/expiry triples and the
 * user would approve them as one line. That is its own product decision.
 */
export const PERMIT2_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "permit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      {
        name: "permitSingle",
        type: "tuple",
        components: [
          {
            name: "details",
            type: "tuple",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint160" },
              { name: "expiration", type: "uint48" },
              { name: "nonce", type: "uint48" },
            ],
          },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "token", type: "address" },
    ],
    outputs: [],
  },
] as const;

/** `type(uint160).max`: Permit2's own "unlimited" sentinel, distinct from uint256 max. */
export const UINT160_MAX = (1n << 160n) - 1n;
