/**
 * Morpho discovery text - the chain list for low-weight lexical recall.
 *
 * Derived from the client-layer registry (`@tools/morpho/chains.ts`) so it can
 * never drift from the chains the tools actually read.
 */

import { MORPHO_SUPPORTED_CHAIN_SLUGS } from "@tools/morpho/chains.js";

export const MORPHO_CHAINS_FOR_DISCOVERY: readonly string[] = MORPHO_SUPPORTED_CHAIN_SLUGS;
