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

import { DEFAULT_RPC as KYBERSWAP_DEFAULT_RPC } from "../kyberswap/evm/config.js";

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
 * The two contracts that decide whether a Blue MARKET is one Vex will operate
 * on at all, per chain.
 *
 * WHY A MARKET NEEDS VOUCHING AND A VAULT DID NOT. Morpho Blue is
 * permissionless: a market is created by naming five parameters, and its id is
 * simply their hash. Anybody can deploy an oracle that reports any price they
 * like, an IRM that charges any rate they like, and open a market around them.
 * Entering such a market by id is entering a contract whose price feed nobody
 * vouched for, and the price feed is what decides when the position is
 * liquidated. So the two parameters that carry that authority are pinned here.
 *
 *   adaptiveCurveIrm       - the ONLY interest rate model Vex will borrow
 *                            against. It is Morpho's own audited curve, and the
 *                            equality check is exact.
 *   chainlinkOracleFactory - the factory that MINTED a market's oracle. It
 *                            answers `isMorphoChainlinkOracleV2(address)`
 *                            on-chain.
 *
 * WHAT THE FACTORY ANSWER IS AND IS NOT. A `true` here proves the oracle's
 * IMPLEMENTATION is Morpho's audited `MorphoChainlinkOracleV2` bytecode. It does
 * NOT make the oracle acceptable, and this comment used to say it did. The
 * factory's `createMorphoChainlinkOracleV2` has no access control of any kind
 * (verified source, Base, 2026-08-17), so any caller can mint a `true` oracle
 * over price feeds of their own choosing. Acceptability needs the second half:
 * the oracle's own immutable feed and vault legs, read on chain and checked
 * against the verified sets in `./oracle-allowlist.ts`.
 *
 * PROVENANCE. Both extracted on 2026-08-17 from `@morpho-org/blue-sdk`'s
 * `getChainAddresses(chainId)` for the nine chains in `./chains.ts`, and pinned
 * EXPLICITLY here for the same reason the table above is explicit: these are
 * security-relevant addresses, and a transitive dependency upgrade must not be
 * able to move them without review. Re-extraction is a deliberate, dated edit.
 * Cross-checked live on Base 2026-08-17: the pinned IRM matches the IRM of the
 * cbBTC/USDC market read from Morpho's own API, and the pinned factory answered
 * `true` for that market's oracle and `false` for GeneralAdapter1.
 */
export interface MorphoMarketPolicyContracts {
  readonly adaptiveCurveIrm: Address;
  /** `null` would mean the chain has no factory to ask, and every market on it
   *  would fall through to the (empty) manual oracle allowlist. No chain in the
   *  table is in that state today; the field is nullable so a future chain
   *  without a factory is refused by name instead of crashing. */
  readonly chainlinkOracleFactory: Address | null;
}

export const MORPHO_MARKET_POLICY_CONTRACTS: Readonly<Record<number, MorphoMarketPolicyContracts>> = {
  1: {
    adaptiveCurveIrm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
    chainlinkOracleFactory: "0x3A7bB36Ee3f3eE32A60e9f2b33c1e5f2E83ad766",
  },
  10: {
    adaptiveCurveIrm: "0x8cD70A8F399428456b29546BC5dBe10ab6a06ef6",
    chainlinkOracleFactory: "0x1ec408D4131686f727F3Fd6245CF85Bc5c9DAD70",
  },
  130: {
    adaptiveCurveIrm: "0x9a6061d51743B31D2c3Be75D83781Fa423f53F0E",
    chainlinkOracleFactory: "0x43269546e1D586a1f7200a0AC07e26f9631f7539",
  },
  137: {
    adaptiveCurveIrm: "0xe675A2161D4a6E2de2eeD70ac98EEBf257FBF0B0",
    chainlinkOracleFactory: "0x1ff7895Eb842794c5d07C4c547b6730e61295215",
  },
  143: {
    adaptiveCurveIrm: "0x09475a3D6eA8c314c592b1a3799bDE044E2F400F",
    chainlinkOracleFactory: "0xC8659Bcd5279DB664Be973aEFd752a5326653739",
  },
  999: {
    adaptiveCurveIrm: "0xD4a426F010986dCad727e8dd6eed44cA4A9b7483",
    chainlinkOracleFactory: "0xeb476f124FaD625178759d13557A72394A6f9aF5",
  },
  4663: {
    adaptiveCurveIrm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
    chainlinkOracleFactory: "0xB7c16F6F8cF531447Bf27Ca7220f981E79C9cdF2",
  },
  8453: {
    adaptiveCurveIrm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    chainlinkOracleFactory: "0x2DC205F24BCb6B311E5cdf0745B0741648Aebd3d",
  },
  42161: {
    adaptiveCurveIrm: "0x66F30587FB8D4206918deb78ecA7d5eBbafD06DA",
    chainlinkOracleFactory: "0x98Ce5D183DC0c176f54D37162F87e7eD7f2E41b5",
  },
} as const;

/**
 * One oracle the owner vouched for by hand, with the evidence that earned it.
 *
 * THE EVIDENCE IS A FIELD, NOT A COMMENT, because a comment is not something a
 * test can assert on and is not something a future reader can be sure was ever
 * true. Every field below is what a later session needs to RE-VERIFY the entry
 * without re-deriving it: which market it serves, when it was checked, who
 * decided, and what was actually measured.
 */
export interface MorphoVouchedOracle {
  /** The oracle contract, checksummed. */
  readonly oracle: Address;
  /**
   * The Blue market id this oracle prices, lower-cased.
   *
   * PART OF THE MATCH, not a label. The owner vouched for an oracle AS USED BY
   * THIS MARKET, having read that market's collateral, feeds and scale; the same
   * oracle contract reused by another market is a different claim nobody made.
   * Matching on the address alone would have let one approval vouch for every
   * curated market on the chain that happens to reuse the oracle.
   */
  readonly marketId: string;
  /** Human label for that market, so the entry reads without a lookup. */
  readonly market: string;
  /** ISO date the evidence below was measured. */
  readonly verifiedOn: string;
  /** WHO decided. Never a builder or an agent. */
  readonly vouchedBy: string;
  /** What the oracle reads, why the factory does not cover it, what was measured. */
  readonly evidence: string;
}

/**
 * Oracles the OWNER has vouched for by hand, per chain, for markets whose oracle
 * did not come from the pinned factory.
 *
 * WHAT AN ENTRY HERE DOES, EXACTLY: it satisfies LAYER 2 (the implementation
 * check) and NOTHING ELSE. Layer 1 still asks Morpho live whether it curates the
 * market, and layer 3 still reads every price leg off the chain and refuses a
 * dead or stale one. An allowlisted oracle is an oracle whose IMPLEMENTATION a
 * human vouched for; it is not an oracle exempt from being curated or from
 * having to answer. See `./mutations/market-policy.ts`.
 *
 * THE OWNER PATH TO EXTEND IT, so a future session does not invent one: add an
 * entry under its chain id with the evidence fields filled from a real
 * measurement. It is a security-posture change under rules/00, so it needs
 * explicit owner approval and never a builder's judgement. Adding an address
 * here widens the set of markets Vex will put real funds into.
 *
 * A CANDIDATE THAT WAS EXAMINED AND REFUSED, kept because the refusal is the
 * more useful record: USDe/USDC on Base (353.4M USD, market
 * `0x54cf9be5...b7354`, oracle `0xF4b17C79492d68775e22e8Dd0a2Bb22854A39A47`) was
 * checked the same day and NOT added. That address is a 45-byte EIP-1167 clone
 * of Steakhouse's `MetaOracleDeviationTimelock` (impl
 * `0x846e726a1bf5fd5cbe08c179ee491b085b1cac3e`, Sourcify exact match), which
 * SWITCHES between a primary and a backup oracle through permissionless
 * `challenge()`/`acceptChallenge()` calls behind a 16h timelock. Its live
 * primary `0xF243538bC89634B0Abb5686A5b72e21282A54695` is a factory-minted V2
 * with ALL FOUR FEED LEGS ZERO: a HARDCODED 1.000000 USDe/USDC, which no
 * liveness check can ever falsify because there is nothing to read. At a 91.5%
 * LLTV a USDe depeg would be invisible to the price until a human challenged it.
 * The meta-oracle also exposes none of the leg getters layer 3 reads, so it
 * could not pass layer 3 even in principle. Not safe to vouch for.
 */
export const MORPHO_MANUAL_ORACLE_ALLOWLIST: Readonly<Record<number, readonly MorphoVouchedOracle[]>> = {
  1: [
    {
      oracle: "0xDddd770BADd886dF3864029e4B377B5F6a2B6b83",
      marketId: "0x3a85e619751152991742810df6ec69ce473daef99e28a64ab2340d7b7ccfee49",
      market: "WBTC/USDC on Ethereum, LLTV 0.86, 118.7M USD supplied",
      verifiedOn: "2026-08-17",
      vouchedBy: "owner",
      evidence:
        "Morpho's own ChainlinkOracle V1 (`src/ChainlinkOracle.sol:ChainlinkOracle`, solc 0.8.21), Sourcify "
        + "exact match on BOTH creation and runtime bytecode. The pinned factory refuses it because the pinned "
        + "factory is the V2 one and this is the PRE-V2 implementation: it has no ERC4626 legs at all, so "
        + "BASE_VAULT/QUOTE_VAULT revert while the four feed getters layer 3 reads all answer. Measured live: "
        + "BASE_FEED_1 WBTC/BTC 0xfdFD9C85aD200c506Cf9e21F1FD8dd01932FBB23 = 1.00041684 (23.5h), BASE_FEED_2 "
        + "BTC/USD 0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c = 64286.09 (0.15h), QUOTE_FEED_1 USDC/USD "
        + "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6 = 0.99983354 (12.6h), QUOTE_FEED_2 unused. price() "
        + "643236030453537912320884934506197901702 at scale 1e34 (36 + 6 loan - 8 collateral decimals) is "
        + "64323.60 USDC per WBTC, 0.13% from the 64238.30 USD Morpho's own API reports for the collateral.",
    },
  ],
};

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
 * Keyless default RPC per Morpho chain, DERIVED from the shared per-slug table
 * in `src/tools/kyberswap/evm/config.ts` (owner ruling 2026-08-17: reuse the
 * shared table, never fork a copy - an endpoint fixed there is fixed for every
 * venue at once). Robinhood (4663) is deliberately absent here: the client
 * resolves it through `src/tools/evm-chains/registry.ts` at build time, which
 * honours the user's RPC override exactly as KyberSwap does. Khalani was
 * considered and measured as a source too: its registry serves the official
 * `mainnet.base.org` for Base, which 429s after ~5 requests under our heavy
 * simulation load, and its metadata is fetched per run from a remote service -
 * neither property suits a confirm-critical money path.
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
 * WHY BASE IS A FALLBACK CHAIN AND NOT ONE PINNED URL. The funded probe reruns
 * (2026-08-17) proved that every keyless Base endpoint meters SOMETHING and
 * each meters it differently: `mainnet.base.org` serves receipts but 429s after
 * ~5 requests; `base.drpc.org` serves receipts and took 30 consecutive light
 * requests, then refused the deposit bundle's HEAVY `eth_call` simulation
 * ("Request timeout on the free plan") after 5 in a row - a COMPUTE budget,
 * not a request count, and once spent even a trivial `allowance()` read was
 * refused. The same-day battery with the real 804-byte deposit bundle measured:
 * `base-mainnet.public.blastapi.io` 8/8 heavy + receipt OK,
 * `1rpc.io/base` 8/8 heavy + receipt OK, drpc 0/8 (budget spent by earlier
 * runs), official 5/8 then 429. No single free endpoint deserves the money
 * path's trust alone, so Base rides a viem `fallback` transport across the
 * verified set (see `MORPHO_RPC_FALLBACKS`); a provider that starts refusing
 * hands the call to the next instead of turning it into an ambiguity.
 * `arb1.arbitrum.io/rpc` was measured serving receipts and sustained load, so
 * Arbitrum stays official and single.
 */
function sharedRpc(slug: string): string {
  const url = KYBERSWAP_DEFAULT_RPC[slug];
  if (url === undefined) {
    throw new Error(
      `Morpho chain table expects slug "${slug}" in the shared kyberswap DEFAULT_RPC table; `
      + "it was removed or renamed there. Fix the shared table, do not fork a copy here.",
    );
  }
  return url;
}

export const MORPHO_DEFAULT_RPC: Readonly<Record<number, string>> = {
  1: sharedRpc("ethereum"),
  10: sharedRpc("optimism"),
  130: sharedRpc("unichain"),
  137: sharedRpc("polygon"),
  143: sharedRpc("monad"),
  999: sharedRpc("hyperevm"),
  8453: sharedRpc("base"),
  42161: sharedRpc("arbitrum"),
};

/**
 * Additional receipt-verified endpoints the transport may fall back to, in
 * order, after `MORPHO_DEFAULT_RPC`. Every entry here was measured on
 * 2026-08-17 with the real deposit bundle's `eth_call` and the probe's real
 * transaction receipt (see the header above for the numbers). The official
 * `mainnet.base.org` is deliberately LAST: it throttles hardest but is the
 * endpoint most likely to still exist unchanged in a year.
 */
export const MORPHO_RPC_FALLBACKS: Readonly<Record<number, readonly string[]>> = {
  8453: ["https://1rpc.io/base", "https://base.drpc.org", "https://mainnet.base.org"],
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
