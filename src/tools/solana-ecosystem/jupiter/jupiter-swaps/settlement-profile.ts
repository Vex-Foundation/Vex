/**
 * The SETTLEMENT PROFILE a fee-bearing Jupiter swap persists at intent time so
 * the K3 Solana sweep can later decode what actually settled (design
 * `solana-settlement-profile-design.md` D1).
 *
 * WHY THIS EXISTS: a landed `/build` swap always contains wallet-sourced
 * `system` transfers — the landing tip, and (for a native-SOL input) the wrap
 * funding transfer into the wallet's own WSOL account. Structure alone cannot
 * tell those apart from an unrelated payment, so the generic balance decoder
 * (`vex-agent/sync/solana-settlement-decoders.ts`) correctly DECLINES and every
 * native-SOL swap stayed `pending` forever. This profile is the missing
 * protocol contract: a bounded, versioned record of the economics Vex itself
 * approved and `assertBuildResponseSafeToSign` already PROVED about the exact
 * bytes that were signed.
 *
 * ONE OWNER, BOTH DIRECTIONS. The swap handler writes it
 * (`buildSolanaSettlementRouteProvenance`) and the sweep reads it
 * (`parseSolanaSettlementProfile`); the `route_provenance` envelope key lives
 * here once so neither side can drift. It is deliberately a plain, scalar-only
 * JSONB shape: no provider text, no instruction bytes, nothing secret.
 *
 * NEVER A GUESS. The profile is written ONLY when every field can be stated
 * honestly. An approved tip whose recipient was not certified yields NO profile
 * at all rather than a profile claiming there was no tip — the sweep then falls
 * back to the generic decoder and the row stays `pending`, which is always the
 * safe answer (migration 044's "never confirm with inaccurate `executed_*`"
 * doctrine).
 *
 * ADDING A KIND: add a schema, add it to `parseSolanaSettlementProfile`'s
 * result union, and add a dispatch arm in
 * `vex-agent/sync/solana-settlement-dispatch.ts`. Bump `v` only when an
 * EXISTING kind's field meanings change — a reader that cannot validate a
 * profile declines to use it, which is why the version is checked strictly.
 */

import { z } from "zod";

import type { CertifiedJupiterTip } from "./submit-tip-proof.js";

/** Current profile version. A reader that does not recognise it ignores the profile entirely. */
export const SOLANA_SETTLEMENT_PROFILE_VERSION = 1;

/** The one profile kind that exists today: an ExactIn, fee-bearing `/build` swap signed by Vex. */
export const JUPITER_FEE_SWAP_SETTLEMENT_KIND = "jupiter_fee_swap_exact_in";

/**
 * `route_provenance` is a shared JSONB bag (kyberswap stores `routeID`/
 * `checksum`, uniswap stores its path) — the profile lives under its own key so
 * it can never collide with another protocol's provenance.
 */
const ROUTE_PROVENANCE_SETTLEMENT_KEY = "settlement";

/** Atomic base units, u64-safe: a decimal integer STRING, never a JS number (u64 exceeds `Number.MAX_SAFE_INTEGER`). */
const positiveAtomicAmount = z.string().regex(/^[1-9]\d*$/);

/** A base58 account address. Length-bounded only — the decoder compares it verbatim against transaction data, never derives authority from it. */
const solanaAddress = z.string().min(32).max(44);

export const jupiterFeeSwapSettlementProfileSchema = z
  .object({
    v: z.literal(SOLANA_SETTLEMENT_PROFILE_VERSION),
    kind: z.literal(JUPITER_FEE_SWAP_SETTLEMENT_KIND),
    inputMint: solanaAddress,
    outputMint: solanaAddress,
    /** The approved ExactIn amount, atomic units of the input mint. */
    inputAmountRaw: positiveAtomicAmount,
    /** `null` iff no tip instruction exists in the signed transaction. */
    tipRecipient: solanaAddress.nullable(),
    /** Lamports, bounded far below `Number.MAX_SAFE_INTEGER` by the owner tip cap (`JUPITER_SWAP_TIP_MAX_LAMPORTS`). */
    tipLamports: z.number().int().min(0),
    /** The knob actually sent to `/build`: `true` means a native-SOL leg is wrapped/unwrapped inside this transaction. */
    wrapAndUnwrapSol: z.boolean(),
  })
  .strict()
  .refine((profile) => (profile.tipRecipient === null) === (profile.tipLamports === 0), {
    message: "tipRecipient and tipLamports must both describe a tip, or both describe its absence",
  });

export type JupiterFeeSwapSettlementProfile = z.infer<typeof jupiterFeeSwapSettlementProfileSchema>;

export interface JupiterFeeSwapSettlementProfileSource {
  readonly inputMint: string;
  readonly outputMint: string;
  /** Vex's OWN requested ExactIn amount — not the provider echo (which `assertBuildResponseMatchesRequest` has already proven equal to it). */
  readonly inputAmountRaw: string;
  /** The tip Vex approved and sent to `/build` as `tipAmount`. */
  readonly approvedTipLamports: number;
  /** `assertBuildResponseSafeToSign`'s certified tip evidence, or `null` when the signed transaction carries no certifiable tip. */
  readonly certifiedTip: CertifiedJupiterTip | null;
  readonly wrapAndUnwrapSol: boolean;
}

/**
 * Build the `route_provenance` value for a fee-bearing swap's intent row, or
 * `undefined` when the swap's economics cannot be described honestly:
 *
 * - a tip was approved but no certified evidence exists (an agent-chosen tip
 *   below Jupiter's `/submit` minimum decodes fine but is never certified) —
 *   the signed transaction DOES contain a tip transfer this profile could not
 *   name, so no profile is written at all;
 * - the certified amount disagrees with the approved amount (defensive: the
 *   build-response guard already proves they are equal);
 * - the assembled shape fails its own schema (defensive: never persist a
 *   profile a reader would have to reject).
 *
 * `undefined` is a first-class outcome, not an error: the sweep falls through
 * to the generic decoder, which declines rather than guessing.
 */
export function buildSolanaSettlementRouteProvenance(
  source: JupiterFeeSwapSettlementProfileSource,
): Record<string, unknown> | undefined {
  if (source.approvedTipLamports > 0 && source.certifiedTip === null) return undefined;
  if (source.certifiedTip !== null && source.certifiedTip.tipLamports !== source.approvedTipLamports) return undefined;

  const parsed = jupiterFeeSwapSettlementProfileSchema.safeParse({
    v: SOLANA_SETTLEMENT_PROFILE_VERSION,
    kind: JUPITER_FEE_SWAP_SETTLEMENT_KIND,
    inputMint: source.inputMint,
    outputMint: source.outputMint,
    inputAmountRaw: source.inputAmountRaw,
    tipRecipient: source.certifiedTip?.tipReceiver ?? null,
    tipLamports: source.certifiedTip?.tipLamports ?? 0,
    wrapAndUnwrapSol: source.wrapAndUnwrapSol,
  } satisfies Record<keyof JupiterFeeSwapSettlementProfile, unknown>);
  if (!parsed.success) return undefined;

  return { [ROUTE_PROVENANCE_SETTLEMENT_KEY]: parsed.data };
}

/**
 * Read a persisted profile out of an `agent_activity` row's `route_provenance`.
 * The stored JSONB is UNTRUSTED input (it round-tripped through the database
 * and may predate the current contract), so it is validated in full; anything
 * absent, foreign, or invalid yields `null` and the caller must fall back to
 * the generic decoder rather than assume a shape.
 */
export function parseSolanaSettlementProfile(
  routeProvenance: Record<string, unknown> | null | undefined,
): JupiterFeeSwapSettlementProfile | null {
  if (!routeProvenance) return null;
  const candidate = routeProvenance[ROUTE_PROVENANCE_SETTLEMENT_KEY];
  if (candidate === undefined) return null;
  const parsed = jupiterFeeSwapSettlementProfileSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
