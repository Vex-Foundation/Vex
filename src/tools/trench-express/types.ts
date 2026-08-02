/**
 * Trench Express REST API type definitions.
 *
 * Every field here is grounded in real captured bytes (funded live probe +
 * REST probe recon, 2026-07-31), NOT in provider docs (there are none). The
 * tolerant-reader split (rule 90) is encoded in the optionality: fields a money
 * decision would read are required; display/telemetry fields are nullable.
 *
 * TRAPS proven live and baked into these types:
 * - `launched` in a RESPONSE is a ms TIMESTAMP (number), present ONLY on
 *   graduated tokens. The request PARAM of the same name is a boolean. They are
 *   different things; a naive shared type is fatal.
 * - `price`/`supply` are JS floats in human units with NO decimals metadata and
 *   NO quote-asset identifier pre-graduation → DISPLAY-GRADE only. On-chain is
 *   the financial truth (deferred to P2). See rule 90 thousandfold-error trap.
 * - There is NO `priceUsd`, NO `verified`, NO `reserveAsset` field. They do not
 *   exist on any endpoint; do not invent them.
 * - `links` is a 0-4 element string array (empty strings when unset; our own
 *   create sent `[]`).
 * - `holders`/`stats24h` were 0 on every token observed, including actively
 *   traded ones → treat as unpopulated telemetry, never a decision input.
 */

// ── Sub-shapes ──────────────────────────────────────────────────────

/** Per-token 24h stats. Zero on every token observed live — display-only telemetry. */
export interface TrenchStats24h {
  volume: number | null;
  txns: number | null;
  priceChangePct: number | null;
}

/**
 * The graduated block — present as an all-or-nothing unit iff the token has
 * graduated off the bonding curve into a pool. Keyed on `poolId` presence on
 * the wire; the validator lifts the five top-level fields into this one object
 * so a partially-present block is impossible to represent.
 *
 * `launched` is a ms epoch TIMESTAMP (the graduation moment), NOT a boolean.
 * Currencies follow Uniswap-v4 address-sort order, so the token may be
 * `currency0` OR `currency1` — never assume which. `pair` is a singleton
 * PoolManager address, not a per-token LP address.
 */
export interface TrenchGraduation {
  launched: number;
  pair: string;
  currency0: string;
  currency1: string;
  poolId: string;
}

// ── Token (core row, shared across tokens/token/search) ─────────────

/** Fields common to every token row, regardless of graduation state. */
export interface TrenchTokenBase {
  /** Token contract address. Financial identity — required. */
  token: string;
  /** Curve/spot price as a human-units float. DISPLAY-GRADE (no decimals/quote asset). */
  price: number;
  /** Total supply in human units (not raw/wei). Required but display-grade. */
  supply: number;
  /** Creation time, ms epoch. Required. */
  time: number;
  /** Creator address. Public, display-tolerant. */
  creator: string | null;
  name: string | null;
  symbol: string | null;
  description: string | null;
  /** 64-hex CID; resolve to a URL via `trenchImageUrl`. Never computed locally. */
  imageCid: string | null;
  /** 0-4 social links; empty strings when unset. */
  links: string[];
  /** On-curve holder count. 0/unpopulated on every token observed. */
  holders: number | null;
  stats24h: TrenchStats24h | null;
  /** Present (testnet) when the backend flagged the token as a likely rug. */
  ruggedFlagged: boolean | null;
  /** `/api/search` only: first 12 bytes of the token address, lowercase hex. */
  _id: string | null;
}

/** A token still on the bonding curve (no graduated block). */
export interface TrenchTokenBonding extends TrenchTokenBase {
  graduated: false;
}

/** A token that has graduated into a pool (graduated block present and complete). */
export interface TrenchTokenGraduated extends TrenchTokenBase {
  graduated: true;
  graduation: TrenchGraduation;
}

/** Discriminated on `graduated`; the graduated block is all-or-nothing. */
export type TrenchToken = TrenchTokenBonding | TrenchTokenGraduated;

// ── Trade (per-token tape, /api/trades) ─────────────────────────────

/**
 * One trade from `/api/trades` (undocumented endpoint; `page` is REQUIRED — the
 * API returns HTTP 500 without it). Items carry NO `token` field — the token is
 * the query parameter, not part of the row. `type` is `1` (buy) or `-1` (sell);
 * `vol` is USD (the backend has an ETH/USD rate even though token endpoints omit
 * `priceUsd`). `in`/`out`/`price` are human-units floats — display-grade.
 */
export interface TrenchTrade {
  /** `1` = buy, `-1` = sell. Financially meaningful direction — required. */
  type: number;
  /** ETH/token in-amount, human units, display-grade. */
  in: number;
  /** token/ETH out-amount, human units, display-grade. */
  out: number;
  /** USD volume of the trade. */
  vol: number;
  price: number;
  /** Transaction hash. Required — the on-chain anchor. */
  tx: string;
  time: number;
  /** Mongo ObjectId of the trade row. Display-only. */
  _id: string | null;
  /** Trader address. Public, display-tolerant. */
  maker: string | null;
}

// ── Wallet stats (/api/stats — gamification layer) ──────────────────

/**
 * Per-wallet stats from `/api/stats`. An undocumented XP/faction gamification
 * layer the brief never mentioned; every field is display-grade telemetry.
 */
export interface TrenchWalletStats {
  volume: number | null;
  trades: number | null;
  xp: number | null;
  faction: string | null;
  factionXp: number | null;
  factionLocked: boolean | null;
}

// ── Request param types ─────────────────────────────────────────────

import type { TrenchSortKey } from "./constants.js";

/** `status`→ the API's boolean `launched` param. `all` omits the filter. */
export type TrenchTokensStatus = "curve" | "launched" | "all";

/** Params for `/api/tokens`. `limit` is clamped to the server cap (30) by the client. */
export interface TrenchTokensParams {
  page: number;
  limit?: number;
  status?: TrenchTokensStatus;
  sort?: TrenchSortKey;
}

/** Single-token lookup: by address OR by symbol (exactly one). */
export type TrenchTokenQuery = { token: string } | { symbol: string };

/** Params for `/api/search`. */
export interface TrenchSearchParams {
  search: string;
  limit?: number;
}

/** Params for `/api/trades`. `page` is REQUIRED by the provider. */
export interface TrenchTradesParams {
  token: string;
  page: number;
  limit?: number;
}
