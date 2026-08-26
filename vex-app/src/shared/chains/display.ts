/**
 * Chain display metadata — serializable, framework-free so BOTH trust zones
 * can import it: the main process (portfolio-db family derivation) and the
 * renderer (ChainIcon / the POSITION switcher). It deliberately holds NO React
 * or `@thesvg/react` imports — icon COMPONENTS live in the renderer's
 * `ChainIcon.tsx`; this module only names WHICH icon source a chain uses (a
 * verified `@thesvg` key, or a local public-dir asset path for chains the
 * package has no icon for, e.g. Arbitrum).
 *
 * `chain_id` here is the value stored in `proj_balances.chain_id` (BIGINT):
 * canonical EVM chain ids plus Khalani's synthetic Solana id. The map is a
 * small hardcoded allow-list; unknown ids fall back to a neutral display so
 * the UI never blanks.
 */

export type ChainFamily = "evm" | "solana";

/** Khalani's synthetic Solana chain id as it appears in `proj_balances`. */
export const SOLANA_CHAIN_ID = 20011000000;

/** Canonical EVM chain ids referenced by the deposit view / quick switcher. */
export const ETHEREUM_CHAIN_ID = 1;
export const BASE_CHAIN_ID = 8453;
export const ARBITRUM_CHAIN_ID = 42161;
export const ROBINHOOD_CHAIN_ID = 4663;

/**
 * Family a chain id belongs to. The single Solana id is the only non-EVM
 * value in `proj_balances`; everything else is an EVM chain. Kept here so the
 * main-process breakdown query and the renderer agree on one derivation.
 */
export function familyForChainId(chainId: number): ChainFamily {
  return chainId === SOLANA_CHAIN_ID ? "solana" : "evm";
}

/** `@thesvg/react` icon keys VERIFIED present in the installed package. */
export type ChainSvgKey =
  | "ethereum"
  | "solana"
  | "robinhood"
  | "polygon"
  | "optimism"
  | "bnb-chain";

/**
 * Where a chain's icon comes from:
 *  - `thesvg` — a key resolved to a `@thesvg/react` component in ChainIcon;
 *  - `asset`  — a path under the renderer publicDir (Arbitrum: `@thesvg` has
 *    no arbitrum icon, so a local SVG is shipped instead);
 *  - `fallback` — unknown chain → ChainIcon draws a neutral monogram.
 */
export type ChainIconSource =
  | { readonly kind: "thesvg"; readonly key: ChainSvgKey }
  | { readonly kind: "asset"; readonly src: string }
  | { readonly kind: "fallback" };

export interface ChainDisplay {
  readonly chainId: number;
  readonly name: string;
  readonly family: ChainFamily;
  readonly icon: ChainIconSource;
}

const CHAIN_DISPLAY: Readonly<Record<number, ChainDisplay>> = {
  [ETHEREUM_CHAIN_ID]: {
    chainId: ETHEREUM_CHAIN_ID,
    name: "Ethereum",
    family: "evm",
    icon: { kind: "thesvg", key: "ethereum" },
  },
  [ROBINHOOD_CHAIN_ID]: {
    chainId: ROBINHOOD_CHAIN_ID,
    name: "Robinhood",
    family: "evm",
    icon: { kind: "thesvg", key: "robinhood" },
  },
  [BASE_CHAIN_ID]: {
    chainId: BASE_CHAIN_ID,
    name: "Base",
    family: "evm",
    // The `@thesvg` base icon proved unreliable across versions (2.1.x paints
    // nothing; 3.x is currentColor-keyed) — ship the official mark as a local
    // asset with a hardcoded brand fill, like Arbitrum.
    icon: { kind: "asset", src: "/logo/base.svg" },
  },
  [ARBITRUM_CHAIN_ID]: {
    chainId: ARBITRUM_CHAIN_ID,
    name: "Arbitrum",
    family: "evm",
    // No `@thesvg` arbitrum icon — ship the mark as a local public asset.
    icon: { kind: "asset", src: "/logo/arbitrum.svg" },
  },
  137: {
    chainId: 137,
    name: "Polygon",
    family: "evm",
    icon: { kind: "thesvg", key: "polygon" },
  },
  10: {
    chainId: 10,
    name: "Optimism",
    family: "evm",
    icon: { kind: "thesvg", key: "optimism" },
  },
  56: {
    chainId: 56,
    name: "BNB Chain",
    family: "evm",
    icon: { kind: "thesvg", key: "bnb-chain" },
  },
  [SOLANA_CHAIN_ID]: {
    chainId: SOLANA_CHAIN_ID,
    name: "Solana",
    family: "solana",
    icon: { kind: "thesvg", key: "solana" },
  },
};

/**
 * Display record for a chain id. Known ids return their curated entry; an
 * unknown id gets a neutral `Chain <id>` label + monogram fallback so the
 * switcher and headers never blank on a chain we haven't catalogued.
 */
export function chainDisplay(chainId: number): ChainDisplay {
  const known = CHAIN_DISPLAY[chainId];
  if (known !== undefined) return known;
  return {
    chainId,
    name: `Chain ${chainId}`,
    family: familyForChainId(chainId),
    icon: { kind: "fallback" },
  };
}

/**
 * EVM quick-switch chips, in render order. Ethereum leads as the always-present
 * default; the rest are the product's promoted networks. Chains with a balance
 * outside this set are reachable through the "see more" dialog.
 */
export const EVM_QUICK_CHAIN_IDS: readonly number[] = [
  ETHEREUM_CHAIN_ID,
  ROBINHOOD_CHAIN_ID,
  BASE_CHAIN_ID,
  ARBITRUM_CHAIN_ID,
];

/** Default EVM selection — ALWAYS Ethereum, even at zero balance. */
export const DEFAULT_EVM_CHAIN_ID = ETHEREUM_CHAIN_ID;

/* ------------------------------------------------------------------ */
/* Provider chain SLUGS (board surfaces)                               */
/* ------------------------------------------------------------------ */

/**
 * DexScreener chain slugs mapped onto the curated chain ids above.
 *
 * WHY A SECOND KEY SPACE. Everything in this file up to here is keyed by the
 * numeric `proj_balances.chain_id`, because that is what the portfolio owns.
 * A board pool is addressed by the PROVIDER's chain slug (`"base"`,
 * `"bsc"`), which never passes through the portfolio and has no chain id on
 * the row it arrives with. Deriving one from the other at the call site would
 * scatter the same table across surfaces, so the bridge lives here, beside
 * the catalogue it bridges to, and stays the same small hardcoded allow-list.
 *
 * Slugs are matched case-insensitively and several are ALIASES for one chain
 * (`bsc` / `bnbchain` / `bnb-chain`), because the provider's own spelling has
 * varied across endpoints. An unlisted slug is not an error: it resolves to a
 * neutral display whose name is the slug itself, so the mark falls back to a
 * monogram ring of the chain the pool is actually on, never to a blank box
 * and never to another chain's logo.
 */
const CHAIN_ID_BY_SLUG: Readonly<Record<string, number>> = {
  ethereum: ETHEREUM_CHAIN_ID,
  eth: ETHEREUM_CHAIN_ID,
  solana: SOLANA_CHAIN_ID,
  sol: SOLANA_CHAIN_ID,
  base: BASE_CHAIN_ID,
  arbitrum: ARBITRUM_CHAIN_ID,
  arbitrumone: ARBITRUM_CHAIN_ID,
  polygon: 137,
  optimism: 10,
  bsc: 56,
  bnbchain: 56,
  "bnb-chain": 56,
  robinhood: ROBINHOOD_CHAIN_ID,
};

/** Normalized lookup key for a provider chain slug. */
function slugKey(slug: string): string {
  return slug.trim().toLowerCase();
}

/**
 * The curated chain id for a provider chain slug, or null when the slug is
 * not in the allow-list. Exported for surfaces that need the id itself (a
 * filter key, an explorer lookup) rather than the display record.
 */
export function chainIdForSlug(slug: string): number | null {
  return CHAIN_ID_BY_SLUG[slugKey(slug)] ?? null;
}

/**
 * Display record for a PROVIDER chain slug.
 *
 * A known slug returns the curated entry, so a board pool on `"base"` wears
 * exactly the mark the portfolio's Base rows wear. An unknown slug returns a
 * neutral record named after the slug itself - `chainId: 0` is a deliberate
 * non-id (no chain claims it) so nothing downstream can mistake the fallback
 * for a catalogued chain, and `icon.kind === "fallback"` draws the monogram
 * ring from the slug's first character.
 */
export function chainDisplayBySlug(slug: string): ChainDisplay {
  const chainId = chainIdForSlug(slug);
  if (chainId !== null) return chainDisplay(chainId);
  const trimmed = slug.trim();
  return {
    chainId: 0,
    name: trimmed === "" ? "Unknown chain" : trimmed,
    family: "evm",
    icon: { kind: "fallback" },
  };
}
