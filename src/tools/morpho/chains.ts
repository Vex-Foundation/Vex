/**
 * Morpho chain registry - the INTERSECTION of Morpho's chains and Vex's own.
 *
 * The rule, decided by the owner on 2026-08-14 and applied here: Vex reads
 * Morpho only on chains it already operates on. A market on a chain Vex cannot
 * resolve, price, or ever transact on is not a useful answer - it is a row the
 * agent would have to be told to ignore.
 *
 * The two Vex-side sources are `src/tools/kyberswap/chains.ts` (the broadest
 * slug table in the tree, and the table `protocols/conventions.ts` derives the
 * canonical agent-facing chain vocabulary from) and
 * `src/tools/evm-chains/registry.ts` (the direct-RPC local chains). Slugs below
 * are the KyberSwap slugs verbatim, so a chain named to a Morpho tool is spelled
 * exactly as it is to every other EVM tool in the tree.
 *
 * Live-probed 2026-08-14, `POST https://api.morpho.org/graphql` `{chains{id
 * network currency blockTimeMs}}`. Morpho listed FOURTEEN chains:
 *
 *   1 Ethereum, 10 OP Mainnet, 130 Unichain, 137 Polygon, 143 Monad,
 *   480 World Chain, 988 Stable, 999 HyperEVM, 4217 Tempo Mainnet,
 *   4663 Robinhood Chain, 5042 Arc, 8453 Base, 42161 Arbitrum One,
 *   747474 Katana
 *
 * NINE of those are in a Vex registry and are supported here. FIVE are not, and
 * are deliberately absent: 480 (World Chain), 988 (Stable), 4217 (Tempo),
 * 5042 (Arc) and 747474 (Katana). A caller naming one of them is refused BY
 * NAME with the supported list - "Vex does not read Katana" and "Morpho has no
 * markets on Katana" are different answers and must never be conflated.
 *
 * When a chain is added to the KyberSwap or local registry, re-run the probe
 * above and add the row here. This table is deliberately explicit rather than
 * computed at load: the intersection is a PRODUCT decision about where Vex
 * operates, and a silent widening the day a swap registry grows is exactly the
 * kind of unreviewed surface change rules/00 stops.
 */

import { VexError, ErrorCodes } from "../../errors.js";

export interface MorphoChain {
  /** KyberSwap-registry slug. The agent-facing spelling. */
  readonly slug: string;
  readonly chainId: number;
  /** Morpho's own `Chain.network` label, as returned by the live probe. */
  readonly morphoNetwork: string;
}

/** The nine supported chains, in ascending chain-id order. */
export const MORPHO_CHAINS: readonly MorphoChain[] = [
  { slug: "ethereum",  chainId: 1,     morphoNetwork: "Ethereum" },
  { slug: "optimism",  chainId: 10,    morphoNetwork: "OP Mainnet" },
  { slug: "unichain",  chainId: 130,   morphoNetwork: "Unichain" },
  { slug: "polygon",   chainId: 137,   morphoNetwork: "Polygon" },
  { slug: "monad",     chainId: 143,   morphoNetwork: "Monad" },
  { slug: "hyperevm",  chainId: 999,   morphoNetwork: "HyperEVM" },
  { slug: "robinhood", chainId: 4663,  morphoNetwork: "Robinhood Chain" },
  { slug: "base",      chainId: 8453,  morphoNetwork: "Base" },
  { slug: "arbitrum",  chainId: 42161, morphoNetwork: "Arbitrum One" },
] as const;

/**
 * Chains Morpho serves that Vex deliberately does not read, kept so a refusal
 * can say "Morpho has markets there, Vex does not cover the chain" rather than
 * the misleading "Morpho does not support that chain".
 */
export const MORPHO_CHAINS_OUTSIDE_VEX: readonly { chainId: number; morphoNetwork: string }[] = [
  { chainId: 480,    morphoNetwork: "World Chain" },
  { chainId: 988,    morphoNetwork: "Stable" },
  { chainId: 4217,   morphoNetwork: "Tempo Mainnet" },
  { chainId: 5042,   morphoNetwork: "Arc" },
  { chainId: 747474, morphoNetwork: "Katana" },
] as const;

export const MORPHO_SUPPORTED_CHAIN_IDS: readonly number[] = MORPHO_CHAINS.map((c) => c.chainId);
export const MORPHO_SUPPORTED_CHAIN_SLUGS: readonly string[] = MORPHO_CHAINS.map((c) => c.slug);

const BY_SLUG = new Map(MORPHO_CHAINS.map((c) => [c.slug, c]));
const BY_ID = new Map(MORPHO_CHAINS.map((c) => [c.chainId, c]));
const OUTSIDE_BY_ID = new Map(MORPHO_CHAINS_OUTSIDE_VEX.map((c) => [c.chainId, c]));

/** Slug for a chain id, or `undefined` when Vex does not read that chain. */
export function morphoChainSlug(chainId: number): string | undefined {
  return BY_ID.get(chainId)?.slug;
}

/**
 * Resolve a slug or a decimal chain-id string to a supported chain id.
 * Returns `undefined` rather than throwing so a caller can phrase its own
 * rejection with its own param name.
 */
export function resolveMorphoChainId(input: string): number | undefined {
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  const bySlug = BY_SLUG.get(normalized);
  if (bySlug) return bySlug.chainId;
  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && BY_ID.has(numeric)) return numeric;
  return undefined;
}

/**
 * Human reason a chain input was refused, naming the Morpho-serves-it-but-we-do-
 * not case explicitly so the agent does not report a coverage gap as an absence
 * of markets.
 */
export function describeUnsupportedChain(input: string): string {
  const numeric = Number(input.trim());
  const outside = Number.isInteger(numeric) ? OUTSIDE_BY_ID.get(numeric) : undefined;
  if (outside) {
    return `Morpho serves ${outside.morphoNetwork} (${outside.chainId}), but Vex does not operate on that chain, `
      + `so it is not readable here. Supported: ${MORPHO_SUPPORTED_CHAIN_SLUGS.join(", ")}.`;
  }
  return `"${input}" is not a Morpho chain Vex reads. Supported: ${MORPHO_SUPPORTED_CHAIN_SLUGS.join(", ")}.`;
}

/** Resolve a chain input or throw a coded, remediation-carrying refusal. */
export function requireMorphoChainId(input: string): number {
  const chainId = resolveMorphoChainId(input);
  if (chainId === undefined) {
    throw new VexError(
      ErrorCodes.MORPHO_UNSUPPORTED_CHAIN,
      `Morpho: ${describeUnsupportedChain(input)}`,
      "Name one of the supported chain slugs, or its numeric chain id.",
    );
  }
  return chainId;
}
