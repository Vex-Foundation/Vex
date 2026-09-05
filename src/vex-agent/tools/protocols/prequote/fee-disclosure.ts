/**
 * The Vex fee statement a quote makes, carried from the quote to the signature.
 *
 * ## Why this module exists
 *
 * The fee a human approved used to be RECOMPUTED at render time from tool
 * arguments (`engine/core/approval-vex-fee.ts`), while the executor decided the
 * real disposition later: it skips the fee on dust, on a fee-on-transfer origin
 * token and on a honeypot, and on the Uniswap lane the card multiplied a human
 * decimal without the token's decimals. Two independent derivations of one
 * money figure is two figures, and the stronger of Vex's two revalidations
 * (Studio's whole-card rebuild) could not detect the divergence because it
 * recomputed the same wrong number.
 *
 * So the fee becomes DATA ON THE QUOTE. This is the shape MetaMask's bridge
 * controller uses - `feeData[metabridge]` is a validated member of the quote
 * object itself (`FeeDataSchema` = atomic `amount` + a `BridgeAsset` that
 * carries the decimals needed to read it), never a client-side recomputation of
 * the request - and it is the shape our own Jupiter lane already ships
 * (`jupiterFeePreviewSchema`, persisted in `safety_detail`, re-parsed by
 * `feePreviewFromSafetyDetail`, digested by `PrequoteDisclosure`).
 *
 * ## The lifecycle
 *
 * 1. A fee-bearing QUOTE tool emits its venue disclosure in `result.data.vexFee`.
 * 2. The recorder projects it onto {@link vexFeePreviewSchema} and stores it in
 *    the row's bounded `safety_detail`. It is VALIDATED BEFORE IT IS STORED, and
 *    a fee-bearing quote whose block will not parse records NO ROW at all: an
 *    authority without its fee statement authorizes nothing.
 * 3. The gate reads it back through the SAME schema (the value has crossed
 *    JSONB since), puts it in the row-disclosure digest, and carries it on the
 *    typed `ToolResult.prequote.vexFee` channel into the approval card.
 * 4. The executor re-derives its disposition and refuses on divergence (round 2).
 *
 * ## What is deliberately NOT on the block
 *
 * The venues' USD estimate and their prose `note` are dropped. The card states
 * exact figures; an estimate beside them reads as one of them. Nothing is
 * truncated or rounded on the way through: a figure that is not known is `null`
 * and the card says so in words.
 *
 * ## What can never come from the payload
 *
 * `collection` - WHEN the fee is taken - is looked up from
 * {@link VEX_FEE_COLLECTION_BY_QUOTE_TOOL}, keyed by the quote tool that
 * produced the disclosure. It is a fact about the venue's integration, not a
 * field a payload may state, and a payload that stated it would be stating when
 * Vex takes its own money.
 */

import { z } from "zod";

/** Digits only, no sign, no separators - a raw atomic amount as a string. */
const digitString = z.string().regex(/^\d+$/, "must be a non-negative integer in raw atomic units");

/**
 * WHEN the fee leaves the wallet, relative to the operation it charges for.
 *
 * `inside_route` - the venue's router keeps the fee inside the swap
 * transaction itself (KyberSwap: `_FEE_IN_BPS` on the source token, pinned by
 * the calldata guard). `separate_transfer_after_success` - a distinct transfer
 * that is signed only after the swap or the bridge deposit confirms, so an
 * operation that does not happen is never charged.
 */
export const VEX_FEE_COLLECTIONS = ["inside_route", "separate_transfer_after_success"] as const;
export type VexFeeCollection = (typeof VEX_FEE_COLLECTIONS)[number];

/**
 * A skip reason is a plain-language sentence the venue wrote (dust floor,
 * fee-on-transfer origin token, honeypot). It is bounded so the persisted row,
 * the digest preimage and the approval card all stay bounded, and the bound
 * REFUSES rather than cuts: a longer reason makes the block unparseable, which
 * skips the row and asks for a fresh quote. The venues' own reasons are ~120
 * characters, so the bound is headroom, not a squeeze.
 */
export const VEX_FEE_SKIP_REASON_MAX_CHARS = 512;

/** Preimage version of the persisted block. A different version reads as absent. */
export const VEX_FEE_PREVIEW_VERSION = "vex-fee-v1";

const chargedArm = z.object({
  v: z.literal(VEX_FEE_PREVIEW_VERSION),
  charged: z.literal(true),
  bps: z.number().int().positive(),
  /** Always the token the user sends; the fee is never taken on the output. */
  chargedOn: z.literal("currency_in"),
  tokenAddress: z.string().min(1),
  /** `null` when the venue could not state a symbol - never a guessed one. */
  tokenSymbol: z.string().min(1).nullable(),
  /** `null` when the venue could not read decimals - never a guessed scale. */
  tokenDecimals: z.number().int().min(0).max(36).nullable(),
  /** Debited from the wallet and delivered to the treasury, exact, atomic. */
  feeAmountRaw: digitString,
  /** Exact decimal at the token's own decimals, or `null` when unreadable. */
  feeAmountDecimal: z.string().min(1).nullable(),
  /** Treasury address credited. Venue constant, never model input. */
  receiver: z.string().min(1),
  /** What leaves the wallet in total (the amount the human asked for). */
  totalDebitedRaw: digitString,
  /** What the venue is quoted for and actually swaps or bridges. */
  netAmountRaw: digitString,
  collection: z.enum(VEX_FEE_COLLECTIONS),
});

const skippedArm = z.object({
  v: z.literal(VEX_FEE_PREVIEW_VERSION),
  charged: z.literal(false),
  bps: z.literal(0),
  reason: z.string().min(1).max(VEX_FEE_SKIP_REASON_MAX_CHARS),
  totalDebitedRaw: digitString,
  netAmountRaw: digitString,
  collection: z.enum(VEX_FEE_COLLECTIONS),
});

/**
 * The persisted, digest-covered Vex fee statement.
 *
 * The arithmetic invariant is part of the SCHEMA, not only of its tests: a
 * statement whose parts do not add up describes no real split, and a block that
 * cannot be believed must not become the authority a person consents to. On the
 * charged arm `feeAmountRaw + netAmountRaw === totalDebitedRaw`; on the skipped
 * arm nothing is taken, so `netAmountRaw === totalDebitedRaw`.
 *
 * ## THE FEE LEG PINS THIS STATEMENT (fixed decision, 2026-09-04 round 2)
 *
 * A reviewer proposed re-running authoritative fee eligibility a second time,
 * inside each venue's late fee leg, because that leg signs AFTER the parent
 * transaction confirms and eligibility is a live oracle read. That was REJECTED
 * as a behaviour change, and the rejection is the contract every venue is tested
 * against:
 *
 *   THE APPROVED STATEMENT IS THE AUTHORITY FOR THE FEE LEG. Its amount and its
 *   receiver are fixed at the pre-sign comparison, before anything is signed,
 *   and the fee leg signs exactly those. Eligibility flipping between the parent
 *   confirmation and the fee transfer changes NOTHING about what is signed.
 *
 * Three reasons, in the order they decide it:
 *
 *   1. Re-deriving late can only move the fee AWAY from what a person approved.
 *      Upward it charges more than was consented to; downward it charges less
 *      than the card stated on a bridge or swap that already happened. Both are
 *      a fee nobody agreed to, which is the same defect the pre-sign comparison
 *      exists to prevent (rule 90: revalidate against the approval, never
 *      re-derive a new authority).
 *   2. The parent operation has already confirmed by then. There is no refusal
 *      available that undoes it, so a late "no" is not a safety outcome - it is
 *      only missed revenue on an operation the user already received.
 *   3. The amount and the receiver are already unable to rise: the amount is the
 *      atomic figure the split fixed and the receiver is a build constant, so
 *      nothing on that path can raise the fee above the statement.
 *
 * What each venue actually signs, pinned by a test per venue:
 *   Uniswap  - `planUniswapFeeLeg` builds the transfer once from the compared
 *              `UniswapFeeCharge`; the receiver is `UNISWAP_FEE_RECEIVER_EVM`.
 *   KyberSwap- no separate leg at all: the fee is inside the router calldata the
 *              pre-sign guard accepted (`collection: inside_route`).
 *   Relay    - `runRelayVexFeeLeg` is handed `legs.feeSplit.feeRaw` and the
 *              origin currency; the receiver is `BRIDGE_FEE_RECEIVER_EVM`.
 *   Khalani  - the fee leg is a staged leg built with the rest of the plan; the
 *              runner signs `stagedLegs[feeLegIndex]` and derives nothing.
 */
export const vexFeePreviewSchema = z
  .discriminatedUnion("charged", [chargedArm, skippedArm])
  .refine(amountsSumToTotal, {
    message: "fee and net amounts must sum to the total debited amount",
  });

/**
 * The arithmetic check, written so it can never THROW.
 *
 * Zod runs a wrapper-level refinement even when the inner shape already
 * reported issues, so a field that failed the digit-string regex still arrives
 * here - and `BigInt("25.00")` throws a `SyntaxError`, which would turn every
 * tolerant reader in this module into a thrower. A non-digit field is left to
 * the regex that already rejected it, and this check passes it through rather
 * than adding a second, less specific complaint about the same value.
 */
function amountsSumToTotal(block: {
  readonly charged: boolean;
  readonly feeAmountRaw?: string;
  readonly netAmountRaw: string;
  readonly totalDebitedRaw: string;
}): boolean {
  const fee = block.charged ? block.feeAmountRaw : "0";
  if (fee === undefined) return true;
  for (const value of [fee, block.netAmountRaw, block.totalDebitedRaw]) {
    if (!/^\d+$/.test(value)) return true;
  }
  return BigInt(fee) + BigInt(block.netAmountRaw) === BigInt(block.totalDebitedRaw);
}

export type VexFeePreview = z.infer<typeof vexFeePreviewSchema>;

/**
 * WHEN each fee-bearing quote tool's venue collects the fee. The key is the
 * QUOTE tool, because the quote is what states the disclosure; the value is a
 * property of the integration, never of the payload.
 *
 * Jupiter (`solana.swap.quote`) is absent on purpose: it carries its own richer
 * `feePreview` channel (fee + tip + ATA rent) and a second, poorer line beside
 * it would contradict it. Pendle and Morpho carry no Vex fee at all.
 */
export const VEX_FEE_COLLECTION_BY_QUOTE_TOOL: Readonly<Record<string, VexFeeCollection>> = {
  "kyberswap.swap.quote": "inside_route",
  "uniswap.swap.quote": "separate_transfer_after_success",
  "relay.quote.get": "separate_transfer_after_success",
  "khalani.quote.get": "separate_transfer_after_success",
};

/** The quote tools whose row MUST carry a readable fee block to authorize anything. */
export const FEE_BEARING_QUOTE_TOOLS: ReadonlySet<string> = new Set(
  Object.keys(VEX_FEE_COLLECTION_BY_QUOTE_TOOL),
);

export function isFeeBearingQuoteTool(toolId: string): boolean {
  return FEE_BEARING_QUOTE_TOOLS.has(toolId);
}

/**
 * The gated EXECUTE tools whose matched row must carry a fee block, and the
 * noun the card uses for the operation being charged for.
 *
 * The ALIAS names are here beside the resolved venue ids because the name that
 * reaches the approval card is the name the MODEL called (`approval-stop.ts`
 * enqueues `toolCall.name`), which over MCP is the alias. That is exactly why
 * `SwapExecute` had no fee line at all: the old switch keyed on a name the
 * router had already resolved past. The gate, by contrast, only ever sees the
 * resolved venue id - see {@link isFeeBearingGatedExecute}.
 */
const VEX_FEE_EXECUTE_OPERATION: Readonly<Record<string, "swap" | "bridge">> = {
  "kyberswap.swap.execute": "swap",
  "uniswap.swap.execute": "swap",
  "relay.bridge": "bridge",
  "khalani.bridge": "bridge",
  SwapExecute: "swap",
  SwapExecuteUniswap: "swap",
  BridgeExecute: "bridge",
  BridgeExecuteRelay: "bridge",
};

/** The RESOLVED gated executes the gate refuses without a fee block. */
const FEE_BEARING_GATED_EXECUTES: ReadonlySet<string> = new Set([
  "kyberswap.swap.execute",
  "uniswap.swap.execute",
  "relay.bridge",
  "khalani.bridge",
]);

/**
 * Does this gated execute charge a Vex fee its matched quote must have stated?
 *
 * Keyed on the RESOLVED venue id, which is what `EXECUTE_GATE_TOOLS` registers
 * and what the gate is called with. `solana.swap.execute` is excluded (Jupiter's
 * own `feePreview` is its statement); Pendle and Morpho carry no Vex fee on this
 * channel.
 */
export function isFeeBearingGatedExecute(toolId: string): boolean {
  return FEE_BEARING_GATED_EXECUTES.has(toolId);
}

/**
 * The noun the fee line uses for the operation, from the EXECUTE TOOL ID - never
 * from the payload. `undefined` for a name this table does not know, which the
 * card renders with a neutral noun rather than dropping the disclosure.
 */
export function vexFeeOperationNoun(toolId: string): "swap" | "bridge" | undefined {
  return VEX_FEE_EXECUTE_OPERATION[toolId];
}

/**
 * Project a venue's own `vexFee` disclosure onto the persisted block.
 *
 * TOLERANT BY CONTRACT: every shape failure yields `undefined`, and what an
 * absent block means belongs to the caller (the recorder skips a fee-bearing
 * row; the gate blocks a fee-bearing execute). It never throws and never
 * fabricates a field.
 *
 * The three venue shapes it accepts differ only in the name of the net amount -
 * `bridgedAmountRaw` (`src/tools/bridge-fee/fee-disclosure.ts`),
 * `swappedAmountRaw` (`src/tools/uniswap/fee/disclosure.ts` and the KyberSwap
 * mirror) - so that is the one field read under alternative names. The USD
 * estimate and the prose note are dropped.
 */
export function toVexFeePreview(quoteToolId: string, value: unknown): VexFeePreview | undefined {
  const collection = VEX_FEE_COLLECTION_BY_QUOTE_TOOL[quoteToolId];
  if (collection === undefined) return undefined;
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const netAmountRaw = source.bridgedAmountRaw ?? source.swappedAmountRaw ?? source.netAmountRaw;

  const candidate = source.charged === true
    ? {
        v: VEX_FEE_PREVIEW_VERSION,
        charged: true,
        bps: source.bps,
        chargedOn: source.chargedOn,
        tokenAddress: source.tokenAddress,
        tokenSymbol: source.tokenSymbol ?? null,
        tokenDecimals: source.tokenDecimals ?? null,
        feeAmountRaw: source.feeAmountRaw,
        feeAmountDecimal: source.feeAmountDecimal ?? null,
        receiver: source.receiver,
        totalDebitedRaw: source.totalDebitedRaw,
        netAmountRaw,
        collection,
      }
    : {
        v: VEX_FEE_PREVIEW_VERSION,
        charged: source.charged,
        bps: source.bps,
        reason: source.reason,
        totalDebitedRaw: source.totalDebitedRaw,
        netAmountRaw,
        collection,
      };

  const parsed = vexFeePreviewSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Read the block back out of a matched row's bounded `safetyDetail`.
 *
 * Re-parsed with the SAME schema the recorder validated against, because the
 * value has crossed persistence as JSONB since (rule 04) - the row is
 * `Record<string, unknown>` and every field is untrusted here. A row written by
 * a non-fee-bearing venue, or by a build older than this lane, naturally yields
 * `undefined`; for a fee-bearing execute the gate turns that into a block.
 */
export function vexFeeFromSafetyDetail(
  safetyDetail: Record<string, unknown>,
): VexFeePreview | undefined {
  const parsed = vexFeePreviewSchema.safeParse(safetyDetail.vexFee);
  return parsed.success ? parsed.data : undefined;
}

/** What {@link withVexFee} decided about a quote's fee statement. */
export type VexFeeFold =
  | { readonly kind: "ok"; readonly safetyDetail: Record<string, unknown> }
  | { readonly kind: "skip"; readonly reason: "vex_fee_unreadable" };

/**
 * Fold a quote's fee statement into the row's bounded safety block, beside
 * `withSpendability`.
 *
 * VALIDATED BEFORE IT IS STORED. For a FEE-BEARING quote tool a missing or
 * unparseable statement is fatal to the row: the alternative is a row that
 * authorizes an execute while saying nothing about the money Vex takes from it,
 * and the gate would then have to invent a disclosure or wave the execute
 * through. A non-fee-bearing tool ignores the key entirely, so a venue that
 * happens to echo a `vexFee` field cannot write one into its row.
 *
 * `vexFee` is a RESERVED key of the safety block; the recorder is its one writer.
 */
export function withVexFee(
  quoteToolId: string,
  safetyDetail: Record<string, unknown>,
  vexFee: unknown,
): VexFeeFold {
  if (!isFeeBearingQuoteTool(quoteToolId)) return { kind: "ok", safetyDetail };
  const parsed = toVexFeePreview(quoteToolId, vexFee);
  if (parsed === undefined) return { kind: "skip", reason: "vex_fee_unreadable" };
  return { kind: "ok", safetyDetail: { ...safetyDetail, vexFee: parsed } };
}
