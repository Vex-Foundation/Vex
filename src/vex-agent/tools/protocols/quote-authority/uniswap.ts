/**
 * The Uniswap execution snapshot: what the human approved on a
 * `uniswap__swap_quote`, stored so the execute is bound to it.
 *
 * ## Why this venue's snapshot is not the KyberSwap one
 *
 * KyberSwap hands back an opaque `routeSummary` that the build must be POSTed
 * verbatim, so its snapshot stores provider BYTES and digests them. Uniswap has
 * no such object: the route is discovered by on-chain quoting and the calldata
 * is built locally. What must be frozen here is therefore not a provider blob
 * but the ROUTER INPUT and the FLOOR:
 *
 *   - `totalInRaw`   - what the user is debited in total,
 *   - `swapAmountRaw`- what the router is actually called with, i.e. the total
 *                      AFTER `resolveUniswapFeeCharge`,
 *   - the fee disposition and the exact disclosure sentence shown alongside it,
 *   - `approvedAmountOutRaw` and `approvedMinOutRaw`, the quoted output and the
 *     floor derived from it once, at quote time.
 *
 * FRESH PATHING IS ALLOWED at execute. Uniswap's pool set moves and re-quoting
 * the best route is how a swap keeps working; what may NOT move is the amount
 * the router receives, the fee the human authorized, and the floor written into
 * the calldata. A fresh route that cannot reach the approved floor is a typed
 * refusal, not a quietly lowered floor - lowering it is precisely the
 * 2026-08-27 incident on the sibling venue (quote 313,879.7, fill 1,190.145,
 * no revert, because the floor was rederived from the fresher route).
 *
 * There is NO zero-tolerance price comparison here. Market movement inside the
 * approved slippage passes by construction: the floor comes from the approved
 * quote, so a fresh route priced anywhere at or above it executes normally.
 */

import { createHash } from "node:crypto";

import { formatUnits } from "viem";
import { z } from "zod";

import {
  boundDebitPlanSchema,
  canonicalizeDebitPlan,
  type BoundDebitPlan,
} from "./debit-plan.js";
import {
  UNISWAP_FRESH_QUOTE_TOOL,
  snapshotRefusal,
  type SnapshotRefusal,
} from "./refusal.js";

/**
 * Snapshot wire version. Bumped when the stored shape changes meaning.
 *
 * v2 (WP2-B) added the bound `debitPlan`, so a v1 row is refused by name rather
 * than executed against a leg set nobody approved. The 15-minute prequote TTL
 * clears the window on its own; nothing migrates.
 */
export const UNISWAP_SNAPSHOT_VERSION = 2;

/**
 * The version tag of the Uniswap quote-binding line on an approval card.
 *
 * It rides INSIDE the rendered card value, so a card written by an older build
 * and one written by this build are textually different and the whole-card
 * comparison at confirm time refuses the mismatch. An in-flight proposal from
 * an older build therefore expires cleanly instead of being confirmed against a
 * line whose meaning changed underneath the human.
 */
export const UNISWAP_QUOTE_BINDING_CARD_VERSION = "uniswap-quote-v1";

/** Whether the Vex fee applied to this trade, as resolved at QUOTE time. */
export type UniswapFeeDisposition = "charged" | "not_charged";

/**
 * The fee exactly as the human was told about it.
 *
 * `disclosureText` is part of the snapshot, not a display nicety: it is the
 * sentence the quote showed, so an execute whose fee resolution produces a
 * different sentence is proposing a different trade even when the amounts
 * happen to round the same way.
 */
export interface UniswapSnapshotFee {
  readonly disposition: UniswapFeeDisposition;
  /** Raw atomic units of the input token, or `null` when nothing is charged. */
  readonly amountRaw: string | null;
  readonly disclosureText: string;
}

/** The pair the quote was answered for. Address identity plus the native flag. */
export interface UniswapSnapshotToken {
  readonly address: string;
  readonly isNative: boolean;
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * The stored snapshot, exactly as it lives in `swap_prequotes.route_ref`.
 *
 * Every field except `digest` is bound; `digest` is sha256 over the canonical
 * serialization of the bound fields, so a durable row edited underneath us
 * fails to restore rather than authorizing a different trade.
 */
export interface UniswapExecutionSnapshot {
  readonly v: typeof UNISWAP_SNAPSHOT_VERSION;
  readonly provider: "uniswap";
  readonly chainId: number;
  readonly tokenIn: UniswapSnapshotToken;
  readonly tokenOut: UniswapSnapshotToken;
  /** What the user is debited in total, raw atomic units of the input token. */
  readonly totalInRaw: string;
  /** The router input: `totalInRaw` minus the fee. Raw atomic units. */
  readonly swapAmountRaw: string;
  readonly fee: UniswapSnapshotFee;
  /** The route's quoted output at quote time - the base the floor derives from. */
  readonly approvedAmountOutRaw: string;
  /** `applySlippage(approvedAmountOutRaw, slippageBps)`, raw atomic units. */
  readonly approvedMinOutRaw: string;
  /** The same two amounts in the output token's human units, for the card. */
  readonly approvedAmountOutHuman: string;
  readonly approvedMinOutHuman: string;
  readonly slippageBps: number;
  readonly expiresAt: string;
  /**
   * The transactions this quote authorizes and the per-gas ceiling each is
   * signed under (`./debit-plan.ts`). The execute takes its ceiling FROM here
   * rather than reading a fresh one, and refuses a leg set that is not this one.
   */
  readonly debitPlan: BoundDebitPlan;
  readonly digest: string;
}

/** The bound fields, without the digest that covers them. */
export type UniswapSnapshotFields = Omit<UniswapExecutionSnapshot, "digest">;

/**
 * The field separator of the canonical serialization below: U+0000, written as
 * an ESCAPE.
 *
 * It is NUL because no bound field can contain one - a disclosure text, a
 * symbol or a decimal string that embedded the separator could otherwise shift
 * a value across a field boundary and collide two different snapshots on one
 * digest. Written `"\u0000"` rather than as a literal control byte so the file
 * stays text to git and to every reviewer's diff; the string, and therefore
 * every digest, is byte-identical either way.
 */
const FIELD_SEPARATOR = "\u0000";

/**
 * Canonical serialization of the bound fields.
 *
 * Written out key by key rather than by `JSON.stringify` over the object: the
 * object arrives from durable JSONB on the read side, where Postgres owns key
 * order, so a digest taken over an implicit ordering would fail for reasons
 * that have nothing to do with tampering.
 */
function canonicalizeSnapshotFields(f: UniswapSnapshotFields): string {
  const token = (t: UniswapSnapshotToken): string =>
    `${t.address.toLowerCase()}|${t.isNative ? "native" : "erc20"}|${t.symbol}|${t.decimals}`;
  return [
    f.v,
    f.provider,
    f.chainId,
    token(f.tokenIn),
    token(f.tokenOut),
    f.totalInRaw,
    f.swapAmountRaw,
    f.fee.disposition,
    f.fee.amountRaw ?? "",
    f.fee.disclosureText,
    f.approvedAmountOutRaw,
    f.approvedMinOutRaw,
    f.approvedAmountOutHuman,
    f.approvedMinOutHuman,
    f.slippageBps,
    f.expiresAt,
    // Contains no U+0000 by construction (`canonicalizeDebitPlan` states why),
    // so it occupies exactly one field of this serialization.
    canonicalizeDebitPlan(f.debitPlan),
  ].join(FIELD_SEPARATOR);
}

/** sha256 hex over the canonical serialization of the bound fields. */
export function digestUniswapSnapshot(fields: UniswapSnapshotFields): string {
  return createHash("sha256").update(canonicalizeSnapshotFields(fields), "utf8").digest("hex");
}

/** Seal the bound fields with their digest. */
export function sealUniswapSnapshot(fields: UniswapSnapshotFields): UniswapExecutionSnapshot {
  return { ...fields, digest: digestUniswapSnapshot(fields) };
}

const TokenSchema = z.object({
  address: z.string().min(1),
  isNative: z.boolean(),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(255),
});

const UniswapSnapshotSchema = z.object({
  v: z.literal(UNISWAP_SNAPSHOT_VERSION),
  provider: z.literal("uniswap"),
  chainId: z.number().int().positive(),
  tokenIn: TokenSchema,
  tokenOut: TokenSchema,
  totalInRaw: z.string().regex(/^\d+$/),
  swapAmountRaw: z.string().regex(/^\d+$/),
  fee: z.object({
    disposition: z.union([z.literal("charged"), z.literal("not_charged")]),
    amountRaw: z.union([z.string().regex(/^\d+$/), z.null()]),
    disclosureText: z.string().min(1),
  }),
  approvedAmountOutRaw: z.string().regex(/^\d+$/),
  approvedMinOutRaw: z.string().regex(/^\d+$/),
  approvedAmountOutHuman: z.string().min(1),
  approvedMinOutHuman: z.string().min(1),
  slippageBps: z.number().int().min(0).max(10_000),
  expiresAt: z.string().min(1),
  debitPlan: boundDebitPlanSchema,
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * The version tag alone, read before the full shape - see the sibling codec's
 * note. A row from an older format is refused by NAME, because it bound a price
 * and nothing about the transactions the swap would send.
 */
const UniswapSnapshotVersionSchema = z.object({ v: z.number().int() });

export type RestoredUniswapSnapshot =
  | { readonly ok: true; readonly snapshot: UniswapExecutionSnapshot }
  | { readonly ok: false; readonly refusal: SnapshotRefusal };

/** True when a durable `route_ref` claims to be a Uniswap snapshot at all. */
export function isUniswapRouteRef(routeRef: unknown): boolean {
  return typeof routeRef === "object"
    && routeRef !== null
    && (routeRef as { provider?: unknown }).provider === "uniswap";
}

/**
 * Validate a stored `route_ref` and re-check its digest.
 *
 * The shape is re-asserted rather than assumed even though this build wrote it:
 * the data has crossed durable storage since, and a router input and a calldata
 * floor are derived from it (rule 04).
 */
export function restoreUniswapSnapshot(routeRef: unknown): RestoredUniswapSnapshot {
  if (routeRef === null || routeRef === undefined) {
    return { ok: false, refusal: snapshotRefusal("missing_snapshot", UNISWAP_FRESH_QUOTE_TOOL) };
  }
  const version = UniswapSnapshotVersionSchema.safeParse(routeRef);
  if (version.success && version.data.v !== UNISWAP_SNAPSHOT_VERSION) {
    return {
      ok: false,
      refusal: snapshotRefusal("snapshot_version_unsupported", UNISWAP_FRESH_QUOTE_TOOL),
    };
  }
  const parsed = UniswapSnapshotSchema.safeParse(routeRef);
  if (!parsed.success) {
    return { ok: false, refusal: snapshotRefusal("snapshot_unreadable", UNISWAP_FRESH_QUOTE_TOOL) };
  }
  const { digest, ...fields } = parsed.data;
  if (digestUniswapSnapshot(fields) !== digest) {
    return { ok: false, refusal: snapshotRefusal("digest_mismatch", UNISWAP_FRESH_QUOTE_TOOL) };
  }
  return { ok: true, snapshot: parsed.data };
}

// ── Execute-time drift ──────────────────────────────────────────────────

/**
 * What the execute re-resolved, to be held against the snapshot.
 *
 * Deliberately the same field names as the snapshot: the comparison is a field
 * walk, and a rename on one side that is not made on the other should not
 * compile.
 */
export interface UniswapExecutionInputs {
  readonly chainId: number;
  readonly tokenIn: UniswapSnapshotToken;
  readonly tokenOut: UniswapSnapshotToken;
  readonly totalInRaw: string;
  readonly swapAmountRaw: string;
  readonly fee: UniswapSnapshotFee;
}

/** Why an execute may not build against the snapshot it just claimed. */
export type UniswapDriftKind = "pair_changed" | "router_input_changed" | "fee_changed";

/**
 * Split into `message` and `hint` because that is how the agent-facing renderer
 * bounds a refusal: a `VexError`'s hint leads the rendered line and the pair is
 * capped TOGETHER, so the way out must be the hint or a long message would push
 * it past the bound (`utils/error-summary/render.ts`).
 */
export interface UniswapDriftRefusal {
  readonly kind: UniswapDriftKind;
  readonly message: string;
  readonly hint: string;
}

const DRIFT_HINT =
  `Nothing was signed; the amount and fee you approved were not altered to make the swap fit. `
  + `Get a fresh ${UNISWAP_FRESH_QUOTE_TOOL}.`;

function driftRefusal(kind: UniswapDriftKind, what: string): UniswapDriftRefusal {
  return { kind, message: `Refused before signing: ${what}.`, hint: DRIFT_HINT };
}

function sameToken(a: UniswapSnapshotToken, b: UniswapSnapshotToken): boolean {
  return a.address.toLowerCase() === b.address.toLowerCase()
    && a.isNative === b.isNative
    && a.decimals === b.decimals;
}

/**
 * Hold the execute's freshly resolved inputs against the approved snapshot.
 *
 * The three checks are the three ways an execute could silently spend or charge
 * something the human did not authorize: a different pair, a different amount
 * reaching the router, or a different fee. Each is named in the refusal,
 * including the direction of the change, because "re-quote" is only actionable
 * when the agent knows what moved.
 */
export function compareUniswapExecutionInputs(
  snapshot: UniswapExecutionSnapshot,
  fresh: UniswapExecutionInputs,
): UniswapDriftRefusal | null {
  if (
    snapshot.chainId !== fresh.chainId
    || !sameToken(snapshot.tokenIn, fresh.tokenIn)
    || !sameToken(snapshot.tokenOut, fresh.tokenOut)
  ) {
    return driftRefusal(
      "pair_changed",
      "the pair this execute resolved is not the pair the approved quote was answered for",
    );
  }
  if (snapshot.totalInRaw !== fresh.totalInRaw || snapshot.swapAmountRaw !== fresh.swapAmountRaw) {
    return driftRefusal(
      "router_input_changed",
      `the amount that would reach the router changed since the quote `
        + `(approved ${snapshot.swapAmountRaw} raw units, now ${fresh.swapAmountRaw})`,
    );
  }
  if (
    snapshot.fee.disposition !== fresh.fee.disposition
    || snapshot.fee.amountRaw !== fresh.fee.amountRaw
    || snapshot.fee.disclosureText !== fresh.fee.disclosureText
  ) {
    const moved = snapshot.fee.disposition === fresh.fee.disposition
      ? `the Vex fee resolved differently than at quote time (approved ${snapshot.fee.amountRaw ?? "none"} raw units, now ${fresh.fee.amountRaw ?? "none"})`
      : snapshot.fee.disposition === "not_charged"
        ? "a Vex fee now applies to this trade and the approved quote was answered with none"
        : "the Vex fee the approved quote disclosed no longer applies to this trade";
    return driftRefusal("fee_changed", moved);
  }
  return null;
}

/**
 * The refusal for a fresh route that cannot reach the approved floor.
 *
 * This is the ONLY price-shaped refusal on the lane, and it is not a
 * zero-tolerance comparison: the floor already carries the full approved
 * slippage, so everything inside the tolerance the human authorized passes. It
 * fires when the market moved further than that.
 */
export function floorUnreachableRefusal(
  snapshot: UniswapExecutionSnapshot,
  freshAmountOutRaw: bigint,
): { readonly message: string; readonly hint: string } {
  return {
    // Human units, and no raw duplicate: message and hint are capped TOGETHER
    // at 320 characters by the agent-facing renderer, and a raw base-unit
    // integer costs ~25 of them to restate what the human figure already says.
    // The raw pair is on the durable failure row.
    message:
      `Refused before signing: no current Uniswap route reaches the approved floor of `
      + `${snapshot.approvedMinOutHuman} ${snapshot.tokenOut.symbol}; the best is worth about `
      + `${formatUnits(freshAmountOutRaw, snapshot.tokenOut.decimals)}.`,
    hint:
      `The market moved past the ${snapshot.slippageBps} bps you approved. Nothing was signed and the floor `
      + `was not lowered. Get a fresh ${UNISWAP_FRESH_QUOTE_TOOL}.`,
  };
}
