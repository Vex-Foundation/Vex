/**
 * Morpho CONTRACT ADDRESSES per chain, and the keyless RPC each chain is read
 * through.
 *
 * PROVENANCE, because a wrong address here is a false safety signal on a money
 * path rather than a cosmetic bug. Every contract address below was extracted on
 * 2026-08-14 from the pinned official registry package
 * `@morpho-org/morpho-ts@2.9.0` (`lib/cjs/addresses.js`, `addressesRegistry`
 * keyed by chain id), not transcribed from documentation and not recalled.
 *
 * CROSS-CHECKED against the addresses independently recorded in
 * `morpho-integration.plan.md` ("Contract surface per chain") before use:
 * Morpho Blue `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` on both Ethereum and
 * Base, Bundler3 `0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245` on Ethereum and
 * `0x6BFd8137e702540E7A42B74178A4a49Ba43920C4` on Base, and the canonical Permit2
 * `0x000000000022D473030F116dDEE9F6B43aC78BA3`. All four matched exactly.
 *
 * PERMIT2 IS GENUINELY ABSENT ON TWO CHAINS. The registry has no Permit2 entry
 * for Monad (143) or HyperEVM (999). That absence is carried here as `null` and
 * refused BY NAME at the read boundary. It is never filled in with the canonical
 * address on the reasoning that Permit2 is "the same everywhere": an allowance
 * read against a contract that is not deployed answers zero, and reporting "no
 * Permit2 approval" for a contract the user could never have approved is a lie
 * that reads as safety.
 *
 * The table is deliberately EXPLICIT rather than imported from the package at
 * runtime. Vex does not depend on `@morpho-org/morpho-ts`, and a registry that
 * silently changed under a transitive upgrade would move a security-relevant
 * spender set with no review. Re-extraction is a deliberate, dated edit here.
 *
 * WHAT EACH SPENDER MEANS, because the roles are what make an allowance readable:
 *
 *   morphoBlue      - the core lending protocol. Approving it lets it pull the
 *                     asset for a direct supply, repay, or collateral deposit.
 *   bundler3        - the multicall entry point that batches a Morpho action into
 *                     one transaction. It holds no funds between calls.
 *   generalAdapter1 - the adapter Bundler3 delegates token movement to. THIS is
 *                     the contract that actually pulls the user's tokens in a
 *                     bundled flow, which is why a standing unlimited approval to
 *                     it is the one most worth naming when reporting.
 *   permit2         - Uniswap's canonical signature-based approval contract,
 *                     reused by Morpho's flows. An approval here is a standing
 *                     grant that a signature can then draw against.
 */

import type { Address } from "viem";

/** The Morpho contracts whose allowance a wallet read reports, in role order. */
export const MORPHO_SPENDER_ROLES = ["morphoBlue", "bundler3", "generalAdapter1", "permit2"] as const;

export type MorphoSpenderRole = (typeof MORPHO_SPENDER_ROLES)[number];

/** A spender address per role; `null` where the pinned registry has no entry. */
export type MorphoChainContracts = Readonly<Record<MorphoSpenderRole, Address | null>>;

/**
 * Per-chain contract addresses, keyed by chain id, for the nine chains in
 * `./chains.ts`. Extracted from `@morpho-org/morpho-ts@2.9.0` on 2026-08-14.
 */
export const MORPHO_CONTRACTS: Readonly<Record<number, MorphoChainContracts>> = {
  1: {
    morphoBlue: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    bundler3: "0x6566194141eefa99Af43Bb5Aa71460Ca2Dc90245",
    generalAdapter1: "0x4A6c312ec70E8747a587EE860a0353cd42Be0aE0",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
  10: {
    morphoBlue: "0xce95AfbB8EA029495c66020883F87aaE8864AF92",
    bundler3: "0xFBCd3C258feB131D8E038F2A3a670A7bE0507C05",
    generalAdapter1: "0x79481C87f24A3C4332442A2E9faaf675e5F141f0",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
  130: {
    morphoBlue: "0x8f5ae9CddB9f68de460C77730b018Ae7E04a140A",
    bundler3: "0x7DD85759182495AF7F6757DA75036d24A9B58bc3",
    generalAdapter1: "0xC11329d19C2275c9E759867e879ECFcEeD7e30A0",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
  137: {
    morphoBlue: "0x1bF0c2541F820E775182832f06c0B7Fc27A25f67",
    bundler3: "0x2d9C3A9E67c966C711208cc78b34fB9E9f8db589",
    generalAdapter1: "0xB261B51938A9767406ef83bbFbaAFE16691b7047",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
  143: {
    morphoBlue: "0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee",
    bundler3: "0x82b684483e844422FD339df0b67b3B111F02c66E",
    generalAdapter1: "0x725AB8CAd931BCb80Fdbf10955a806765cCe00e5",
    // No Permit2 in the pinned registry for Monad. Refused by name, never guessed.
    permit2: null,
  },
  999: {
    morphoBlue: "0x68e37dE8d93d3496ae143F2E900490f6280C57cD",
    bundler3: "0xa3F50477AfA601C771874260A3B34B40e244Fa0e",
    generalAdapter1: "0xD7F48aDE56613E8605863832B7B8A1985B934aE4",
    // No Permit2 in the pinned registry for HyperEVM. Refused by name, never guessed.
    permit2: null,
  },
  4663: {
    morphoBlue: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
    bundler3: "0x6478e9393d4C5bB4d53ee881d1DE78786A0344a6",
    generalAdapter1: "0xc5E188541D107e8B79e43478bDE365F1406665D6",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
  8453: {
    morphoBlue: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    bundler3: "0x6BFd8137e702540E7A42B74178A4a49Ba43920C4",
    generalAdapter1: "0xb98c948CFA24072e58935BC004a8A7b376AE746A",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
  42161: {
    morphoBlue: "0x6c247b1F6182318877311737BaC0844bAa518F5e",
    bundler3: "0x1FA4431bC113D308beE1d46B0e98Cb805FB48C13",
    generalAdapter1: "0x9954aFB60BB5A222714c478ac86990F221788B88",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
} as const;

/**
 * Human label per role, for a report a person can read without knowing which
 * Morpho contract does what.
 */
export const MORPHO_SPENDER_LABELS: Readonly<Record<MorphoSpenderRole, string>> = {
  morphoBlue: "Morpho Blue core protocol",
  bundler3: "Bundler3 batch entry point",
  generalAdapter1: "GeneralAdapter1, the contract that moves tokens in a bundled Morpho action",
  permit2: "Permit2 signature-based approvals",
};

/**
 * `type(uint256).max`, the 78-digit value an "unlimited" approval is set to.
 *
 * Compared EXACTLY rather than by a threshold. An allowance is either the
 * unbounded grant or a bounded number, and a "close enough to max" heuristic
 * would label a large but finite approval as unlimited, which is the wrong way
 * round for a risk signal.
 */
export const UINT256_MAX = (2n ** 256n - 1n).toString();

/**
 * The threshold above which an allowance is EFFECTIVELY unbounded even though it
 * is no longer the exact maximum.
 *
 * This exists because of a live capture on 2026-08-14. A Base wallet's USDC
 * approval to Morpho Blue read
 * `115792089237316195423570985008687907853269984665640564039457584007911329639935`
 * against a true maximum ending `913129639935` - the approval had been set to
 * the maximum and 1,800 USDC had since been drawn from it. Exact matching alone
 * correctly reported `unlimited: false`, and that reading UNDER-WARNS: the
 * remaining allowance is still around 1.1e71 USDC, which is unbounded in every
 * sense that matters to the person holding the wallet.
 *
 * So both facts are reported. `unlimited` stays an EXACT match, because "is it
 * still pristine" is a real and checkable question. `effectivelyUnlimited` uses
 * 2^255, a number no honest token supply approaches, so nothing but a max-style
 * approval can reach it. A percentage-of-max heuristic was rejected: it would
 * scale with the value and blur the two questions into one fuzzy answer.
 */
export const EFFECTIVELY_UNLIMITED_THRESHOLD = 2n ** 255n;

/**
 * Keyless default RPC per Morpho chain, aligned with the endpoints already
 * shipped in `src/tools/kyberswap/evm/config.ts` and
 * `src/tools/evm-chains/registry.ts` so a Morpho read and a swap quote reach the
 * same node for the same chain.
 *
 * BASE AND ARBITRUM ARE NOT PUBLICNODE, AND THAT IS THE POINT (funded live
 * probe, 2026-08-17). `base-rpc.publicnode.com` and
 * `arbitrum-one-rpc.publicnode.com` REFUSE `eth_getTransactionReceipt` at the
 * METHOD level with -32602 "Archive requests require a personal token", for a
 * transaction in the CURRENT HEAD BLOCK, while answering `eth_call`,
 * `eth_estimateGas` and `eth_getTransactionByHash` normally. A money path pinned
 * to such a node can broadcast but can never CONFIRM: the probe's real approval
 * landed in block 50090123 and still ended `unproven`. The publicnode endpoints
 * for Ethereum, Optimism and Polygon answered normally on the same day and are
 * left alone.
 *
 * WHY BASE IS drpc AND NOT THE OFFICIAL `mainnet.base.org`. The official
 * endpoint DOES serve receipts, and it was the obvious replacement, but it rate
 * limits at about five requests: a 12-request burst measured 5x 200 then 7x 429,
 * and it failed one of this repository's own live-RPC tests on the first run.
 * One Morpho execution makes many more reads than that, and a 429 in the middle
 * of one is the same ambiguity this whole change exists to remove.
 * `base.drpc.org` served a receipt for a transaction from its own latest block
 * and took 30 consecutive requests with no throttling. `arb1.arbitrum.io/rpc`
 * was measured the same way and passed both checks, so Arbitrum stays official.
 */
export const MORPHO_DEFAULT_RPC: Readonly<Record<number, string>> = {
  1: "https://ethereum-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  130: "https://mainnet.unichain.org",
  137: "https://polygon-bor-rpc.publicnode.com",
  143: "https://rpc.monad.xyz",
  999: "https://rpc.hyperliquid.xyz/evm",
  4663: "https://rpc.mainnet.chain.robinhood.com",
  8453: "https://base.drpc.org",
  42161: "https://arb1.arbitrum.io/rpc",
};

/**
 * Multicall3, live-verified by `eth_getCode` on 2026-08-14 at this canonical
 * address on every Morpho chain including the two the repository had never
 * proven it on, Monad (143) and HyperEVM (999): both returned 7,618 bytes of
 * code, byte-identical in length to Base's.
 */
export const MORPHO_MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** Native currency symbol per chain, for a native balance that names itself. */
export const MORPHO_NATIVE_SYMBOL: Readonly<Record<number, string>> = {
  1: "ETH",
  10: "ETH",
  130: "ETH",
  137: "POL",
  143: "MON",
  999: "HYPE",
  4663: "ETH",
  8453: "ETH",
  42161: "ETH",
};
