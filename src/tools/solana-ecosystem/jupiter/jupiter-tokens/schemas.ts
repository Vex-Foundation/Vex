/**
 * Zod response schemas for the Jupiter Tokens API V2 (/search, /tag,
 * /{category}/{interval}, /recent) — codex-002.
 *
 * Every endpoint returns `JupiterMintInformation[]`. These gate the SHAPE of
 * token metadata at the HTTP boundary. The only financially-load-bearing field
 * is the mint identity `id`: `jupiterMintInformationToMetadata` maps it to
 * `TokenMetadata.address` and the service matches it against the requested mint
 * (`token.id === mint`), so a resolved token's identity flows downstream into
 * swap inputs. `id` is therefore validated firmly as a base58 Solana pubkey.
 * The remaining audit/display fields (names, social URLs, stats, optional
 * authority/pool addresses) are never fed to signing, so they mirror the wire
 * interface permissively. Every object `.passthrough()` unknown keys because
 * the service forwards the raw upstream response and Jupiter adds fields.
 *
 * Zod gates shape only; it cannot prove a token is economically safe.
 *
 * The schemas are intentionally NOT the type source of truth — the wire
 * interfaces in `types.ts` remain canonical, and each client function's
 * declared return type (`JupiterMintInformation[]`) makes `tsc` verify the
 * inferred schema output is assignable to that interface.
 */

import { z } from "zod";
import { solanaPubkey } from "../../shared/schemas.js";

/**
 * LIVE-GATE FIX 1 (2026-07-24): `jupEarn` is absent (empty `apy: {}`) for the
 * large majority of live `/tokens/v2/search` results — only tokens with a
 * Jupiter Lend Earn market populate it. Confirmed live: `query=SOL` returned
 * 20 tokens, 19 with `apy: {}` and only the SOL entry itself carrying
 * `jupEarn`. Display-only (never fed to signing), so optional per the
 * tolerant-reader doctrine rather than a required financial field.
 */
const jupiterTokenApySchema = z
  .object({
    jupEarn: z.number().optional(),
  })
  .passthrough();

const jupiterTokenSwapStatsSchema = z
  .object({
    priceChange: z.number().nullable().optional(),
    holderChange: z.number().nullable().optional(),
    liquidityChange: z.number().nullable().optional(),
    volumeChange: z.number().nullable().optional(),
    buyVolume: z.number().nullable().optional(),
    sellVolume: z.number().nullable().optional(),
    buyOrganicVolume: z.number().nullable().optional(),
    sellOrganicVolume: z.number().nullable().optional(),
    numBuys: z.number().nullable().optional(),
    numSells: z.number().nullable().optional(),
    numTraders: z.number().nullable().optional(),
    numOrganicBuyers: z.number().nullable().optional(),
    numNetBuyers: z.number().nullable().optional(),
  })
  .passthrough();

const jupiterTokenFirstPoolSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
  })
  .passthrough();

const jupiterTokenAuditSchema = z
  .object({
    isSus: z.boolean().nullable().optional(),
    mintAuthorityDisabled: z.boolean().nullable().optional(),
    freezeAuthorityDisabled: z.boolean().nullable().optional(),
    topHoldersPercentage: z.number().nullable().optional(),
    devBalancePercentage: z.number().nullable().optional(),
    devMints: z.number().nullable().optional(),
  })
  .passthrough();

/**
 * `JupiterMintInformation` — a single token's metadata. `id` is the on-chain
 * mint address that becomes the resolved token's identity (and a swap input),
 * so it is validated as a base58 Solana pubkey; everything else is display /
 * audit metadata mirrored from the wire interface.
 */
export const jupiterMintInformationSchema = z
  .object({
    id: solanaPubkey,
    name: z.string(),
    symbol: z.string(),
    icon: z.string().nullable().optional(),
    decimals: z.number(),
    tokenProgram: z.string().optional(),
    createdAt: z.string().optional(),
    twitter: z.string().nullable().optional(),
    telegram: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
    discord: z.string().nullable().optional(),
    instagram: z.string().nullable().optional(),
    tiktok: z.string().nullable().optional(),
    otherUrl: z.string().nullable().optional(),
    dev: z.string().nullable().optional(),
    mintAuthority: z.string().nullable().optional(),
    freezeAuthority: z.string().nullable().optional(),
    circSupply: z.number().nullable().optional(),
    totalSupply: z.number().nullable().optional(),
    launchpad: z.string().nullable().optional(),
    partnerConfig: z.string().nullable().optional(),
    graduatedPool: z.string().nullable().optional(),
    graduatedAt: z.string().nullable().optional(),
    holderCount: z.number().nullable().optional(),
    fdv: z.number().nullable().optional(),
    mcap: z.number().nullable().optional(),
    usdPrice: z.number().nullable().optional(),
    priceBlockId: z.number().nullable().optional(),
    liquidity: z.number().nullable().optional(),
    apy: jupiterTokenApySchema.nullable().optional(),
    stats5m: jupiterTokenSwapStatsSchema.nullable().optional(),
    stats1h: jupiterTokenSwapStatsSchema.nullable().optional(),
    stats6h: jupiterTokenSwapStatsSchema.nullable().optional(),
    stats24h: jupiterTokenSwapStatsSchema.nullable().optional(),
    firstPool: jupiterTokenFirstPoolSchema.nullable().optional(),
    audit: jupiterTokenAuditSchema.nullable().optional(),
    organicScore: z.number().optional(),
    organicScoreLabel: z.string().optional(),
    isVerified: z.boolean().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

/** Every Jupiter Tokens V2 endpoint returns an array of mint information. */
export const jupiterMintInformationListSchema = z.array(jupiterMintInformationSchema);
