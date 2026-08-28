/**
 * The wrapped-native CAPABILITY registry: the chains on which Vex will build a
 * native <-> wrapped-native conversion, and the contract identity it will build
 * it against.
 *
 * This is not a fourth address lookup table. Three already exist and each
 * answers a different question with a different failure policy:
 * `kyberswap/wrapped-native.ts` classifies a leg as economically native for
 * RECORDING, `dexscreener/evm-chain-quote-policy.ts` picks a PRICING quote
 * asset, `uniswap/deployments.ts` carries a router-verified execution constant.
 * This one answers "may Vex send this user's funds to this contract", so its
 * entry carries the evidence for that answer and nothing else.
 *
 * FROZEN AND VERIFIED. An entry exists only where the contract was probed live,
 * read-only, and answered: `symbol()`, `decimals()`, `deposit()`, `withdraw(0)`,
 * and a `withdraw(2^255)` that reverts on the balance requirement while an
 * unknown control selector does not (or, on the strict aeWETH dispatcher, an
 * unknown selector that reverts while both real selectors do not). Method,
 * per-chain raw request/response archives and the reason each of v1 and v2 was
 * discarded: `src/__tests__/fixtures/evm-chains/wrapped-native/<chainId>.json`
 * and the table test that enumerates every row against them.
 *
 * A chain WITHOUT an entry is refused BY NAME. It is never guessed from another
 * table: those tables answer other questions, and a wrong address here is the
 * user's funds sent to a contract that will not give them back.
 *
 * `symbol` is the value the contract returned, not a convention. Polygon
 * answers WPOL, BSC WBNB, Avalanche WAVAX. Nothing user-facing may call this
 * "WETH9".
 */

import { getAddress } from "viem";

export interface WrappedNativeContract {
  readonly chainId: number;
  /** Lowercase label, matching this repository's chain-slug vocabulary. */
  readonly slug: string;
  /** Checksummed. The identity a wrap is built against and bound to. */
  readonly address: `0x${string}`;
  /** As returned by `symbol()` on the live contract, never a convention. */
  readonly symbol: string;
  /** As returned by `decimals()` on the live contract. */
  readonly decimals: number;
  /** UTC date of the read-only live probe that admitted this row. */
  readonly verifiedAt: string;
}

const VERIFIED_AT = "2026-08-28" as const;

const CONTRACTS: readonly WrappedNativeContract[] = [
  {
    chainId: 1,
    slug: "ethereum",
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    symbol: "WETH",
    decimals: 18,
    verifiedAt: VERIFIED_AT,
  },
  {
    chainId: 10,
    slug: "optimism",
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    decimals: 18,
    verifiedAt: VERIFIED_AT,
  },
  {
    chainId: 56,
    slug: "bsc",
    address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    symbol: "WBNB",
    decimals: 18,
    verifiedAt: VERIFIED_AT,
  },
  {
    chainId: 137,
    slug: "polygon",
    address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    symbol: "WPOL",
    decimals: 18,
    verifiedAt: VERIFIED_AT,
  },
  {
    chainId: 4663,
    slug: "robinhood",
    address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    symbol: "WETH",
    decimals: 18,
    verifiedAt: VERIFIED_AT,
  },
  {
    chainId: 8453,
    slug: "base",
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    decimals: 18,
    verifiedAt: VERIFIED_AT,
  },
  {
    chainId: 42161,
    slug: "arbitrum",
    address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    symbol: "WETH",
    decimals: 18,
    verifiedAt: VERIFIED_AT,
  },
  {
    chainId: 43114,
    slug: "avalanche",
    address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
    symbol: "WAVAX",
    decimals: 18,
    verifiedAt: VERIFIED_AT,
  },
];

const BY_CHAIN_ID: ReadonlyMap<number, WrappedNativeContract> = new Map(
  CONTRACTS.map((entry) => [entry.chainId, entry]),
);

/**
 * The verified contract for a chain, or `undefined` when Vex has not verified
 * one. `undefined` means "not proven", never "not present on this chain" - the
 * caller must refuse and name the chain, not fall back to another table.
 */
export function getWrappedNativeContract(chainId: number): WrappedNativeContract | undefined {
  return BY_CHAIN_ID.get(chainId);
}

/** Every verified entry. Exists so the table test can enumerate the registry. */
export function listWrappedNativeContracts(): readonly WrappedNativeContract[] {
  return CONTRACTS;
}

/** The chain slugs a wrap can be built on today, for a refusal that names the set. */
export function listWrappedNativeChainSlugs(): readonly string[] {
  return CONTRACTS.map((entry) => entry.slug);
}

/**
 * True when `address` is the verified wrapped-native contract for `chainId`.
 * Address identity, never symbol: two contracts can share a symbol and only one
 * of them holds the user's deposit.
 */
export function isWrappedNativeContract(chainId: number, address: string): boolean {
  const entry = BY_CHAIN_ID.get(chainId);
  if (!entry) return false;
  try {
    return getAddress(address) === entry.address;
  } catch {
    return false;
  }
}
