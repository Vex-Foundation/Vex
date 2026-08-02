/**
 * Trench Express launchpad — fixed provider facts.
 *
 * Trench Express is a bonding-curve token launchpad on RBC (chainId 4663).
 * These values are proven by the funded live probe (see
 * `agents_dm/trench-live/`) and the REST probe recon. Base URLs live in config
 * (`services.trenchExpressApiUrl` / `…TestnetApiUrl`) because they are
 * environment endpoints, not secrets; the addresses/chain here are protocol
 * constants that never move without a contract migration.
 */

/** Default mainnet REST base (also the `services.trenchExpressApiUrl` default). */
export const TRENCH_MAINNET_API_URL = "https://api.trench.express";

/** Default testnet REST base (also the `services.trenchExpressTestnetApiUrl` default). */
export const TRENCH_TESTNET_API_URL = "https://api-testnet.trench.express";

/** The verified Diamond (trading facet) address on RBC 4663. Shared infra for P2/P3. */
export const TRENCH_DIAMOND_ADDRESS = "0x3857c6c4FE93Abb40945dfc8B9d690384cBae014";

/** RBC chain id the launchpad runs on. */
export const TRENCH_CHAIN_ID = 4663;

/**
 * Cloudflare R2 base that serves launchpad token images as webp
 * (`<base>/tokens/<imageCid>.webp`). See `image-serving.ts` — the CID is
 * READ from the API, never computed locally (derivation is unknown).
 */
export const TRENCH_IMAGE_R2_BASE = "https://pub-fa6ea11426f34350acc5dd6edc476b11.r2.dev";

/**
 * Server-side page-size cap. The API caps `limit` at 30; requesting more is
 * silently clamped. The client clamps to this before sending so the caller's
 * page math matches what the provider actually returns.
 */
export const TRENCH_LIMIT_CAP = 30;

/** REST endpoint paths (all keyless public GET, params as URL-encoded JSON). */
export const TRENCH_ENDPOINTS = {
  tokens: "/api/tokens",
  token: "/api/token",
  search: "/api/search",
  trades: "/api/trades",
  stats: "/api/stats",
} as const;

/** Server sort keys accepted by `/api/tokens` (unknown values are silently ignored by the API). */
export const TRENCH_SORT_KEYS = ["time", "price", "bump"] as const;
export type TrenchSortKey = (typeof TRENCH_SORT_KEYS)[number];
