/**
 * The Virtuals bonding-curve execution snapshot: what the human approved on a
 * `virtuals__agent_trade_quote`, sealed so the execute is bound to it.
 *
 * ## Why this venue needs its own snapshot
 *
 * The Uniswap snapshot binds a router input, a fee and a floor. A curve trade
 * has THREE more things a signature must be held to, and none of them fits that
 * shape:
 *
 *  - THE IMPLEMENTATION BEHIND THE PROXY. BondingV5 and FRouterV3 are
 *    upgradeable. An upgrade changes what `buy` and `sell` DO without changing
 *    the address the signature commits to, so the implementation is bound here
 *    and re-read from the EIP-1967 slot before signing.
 *  - THE TAXES. The curve removes a protocol tax and possibly an anti-sniper tax
 *    INSIDE the transaction. They decide what the wallet receives, they are read
 *    from the chain, and a trade signed under different taxes than the ones
 *    disclosed is a different trade.
 *  - THE ANTI-SNIPER BOUND THE CALLER ACCEPTED. `acceptAntiSniperTaxPct` is
 *    consent to a maximum, not to a value; the bound is bound, and the execute
 *    refuses when the pre-sign percent exceeds it.
 *
 * ## The two sides bind different floors, and the difference is the point
 *
 * BUY - `contractFloorRaw` is `amountOutMin_` and the chain compares it against
 * the tokens the wallet RECEIVES, so it is a floor on delivery.
 *
 * SELL - `contractFloorRaw` is `amountOutMin_` and the chain compares it against
 * the router's GROSS output BEFORE the curve's taxes (`BondingV5.sell` :687).
 * `walletNetMinRaw` is therefore an ESTIMATE of the wallet's net at that floor
 * and is labelled as one wherever it is shown. It is bound anyway, because it is
 * a figure the human read; what it must never be called is a floor.
 *
 * ## What may move between the quote and the execute
 *
 * The curve price may move: the floor already carries the tolerance the caller
 * authorized, so any fill at or above it executes normally. What may NOT move is
 * the pair, the side, the amount, the fee, the taxes, the implementation or the
 * accepted anti-sniper bound - each is refused BY NAME, and none of them is ever
 * quietly re-derived to make the trade fit.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import { VIRTUALS_FRESH_QUOTE_TOOL, snapshotRefusal, type SnapshotRefusal } from "./refusal.js";

/**
 * Snapshot wire version. Bumped when the stored shape changes meaning; an older
 * row is then refused by name rather than executed against a different contract.
 */
export const VIRTUALS_SNAPSHOT_VERSION = 1;

export type VirtualsTradeSide = "buy" | "sell";

/** The Vex fee exactly as the quote stated it, per side. */
export type VirtualsSnapshotFee =
  | {
      /** BUY: an exact amount, deducted from the committed VIRTUAL. */
      readonly disposition: "charged_on_input";
      readonly amountRaw: string;
      readonly receiver: string;
      readonly bps: number;
      readonly disclosureText: string;
    }
  | {
      /** BUY at a dust size: nothing is taken and no leg is planned. */
      readonly disposition: "not_charged";
      readonly amountRaw: null;
      readonly receiver: string;
      readonly bps: 0;
      readonly disclosureText: string;
    }
  | {
      /** SELL: a rate on the proven proceeds; the amount exists after settlement. */
      readonly disposition: "charged_on_settled_output";
      /** The ESTIMATE the quote showed, never a charge. */
      readonly amountRaw: string;
      readonly receiver: string;
      readonly bps: number;
      readonly disclosureText: string;
    };

/** The taxes the curve itself will take, as read at the quote's block. */
export interface VirtualsSnapshotTaxes {
  /** `FFactoryV2.buyTax()` / `.sellTax()` for the traded side, integer percent. */
  readonly protocolTaxPct: number;
  /** The anti-sniper percent on the traded side AFTER the router's 99 clamp. */
  readonly effectiveAntiSniperPct: number;
  /** The type the chain reports, echoed so a refusal can name it. */
  readonly antiSniperType: number;
  /**
   * The maximum anti-sniper percent the CALLER accepted for this side, or null
   * when they accepted none (the default, which refuses any active window).
   */
  readonly acceptedAntiSniperPct: number | null;
}

/** The token pair a curve trade is answered for. */
export interface VirtualsSnapshotToken {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
}

export interface VirtualsExecutionSnapshot {
  readonly v: typeof VIRTUALS_SNAPSHOT_VERSION;
  readonly provider: "virtuals";
  readonly chainId: number;
  readonly side: VirtualsTradeSide;
  /** The agent token. */
  readonly token: VirtualsSnapshotToken;
  /** The curve's quote asset on this chain. */
  readonly virtual: VirtualsSnapshotToken;
  /** The curve pair the quote was taken against. */
  readonly pair: string;
  /** The proxy implementations the approval is bound to. */
  readonly bondingV5Implementation: string;
  readonly frouterV3Implementation: string;
  /** What leaves the wallet in total: VIRTUAL on a buy, agent tokens on a sell. */
  readonly totalInRaw: string;
  /**
   * BUY: `totalInRaw - vexFee`, the `amountIn_` the curve call carries.
   * SELL: identical to `totalInRaw` - the Vex fee is taken from the output.
   */
  readonly curveAmountRaw: string;
  readonly fee: VirtualsSnapshotFee;
  readonly taxes: VirtualsSnapshotTaxes;
  /** BUY: quoted tokens out. SELL: the router's quoted GROSS VIRTUAL. */
  readonly quotedOutRaw: string;
  /** The `amountOutMin_` argument. Enforced by the contract on both sides. */
  readonly contractFloorRaw: string;
  /** SELL only: the labelled ESTIMATE of the wallet's net at the floor. */
  readonly walletNetMinRaw: string | null;
  readonly slippageBps: number;
  readonly expiresAt: string;
  readonly digest: string;
}

export type VirtualsSnapshotFields = Omit<VirtualsExecutionSnapshot, "digest">;

/**
 * The field separator of the canonical serialization: U+0000, written as an
 * ESCAPE.
 *
 * It is NUL because no bound field can contain one - a disclosure text, a symbol
 * or a decimal string that embedded the separator could otherwise shift a value
 * across a field boundary and collide two different snapshots on one digest.
 * Written `"\u0000"` rather than as a literal control byte so the file stays
 * text to git and to every reviewer's diff; the string, and therefore every
 * digest, is byte-identical either way.
 */
const FIELD_SEPARATOR = "\u0000";

function token(t: VirtualsSnapshotToken): string {
  return `${t.address.toLowerCase()}|${t.symbol}|${t.decimals}`;
}

/**
 * Canonical serialization, key by key rather than by `JSON.stringify`: the
 * object comes back from JSONB where Postgres owns key order, so a digest over
 * an implicit ordering would fail for reasons unrelated to tampering.
 */
function canonicalizeSnapshotFields(f: VirtualsSnapshotFields): string {
  return [
    f.v,
    f.provider,
    f.chainId,
    f.side,
    token(f.token),
    token(f.virtual),
    f.pair.toLowerCase(),
    f.bondingV5Implementation.toLowerCase(),
    f.frouterV3Implementation.toLowerCase(),
    f.totalInRaw,
    f.curveAmountRaw,
    f.fee.disposition,
    f.fee.amountRaw ?? "",
    f.fee.receiver.toLowerCase(),
    f.fee.bps,
    f.fee.disclosureText,
    f.taxes.protocolTaxPct,
    f.taxes.effectiveAntiSniperPct,
    f.taxes.antiSniperType,
    f.taxes.acceptedAntiSniperPct ?? "",
    f.quotedOutRaw,
    f.contractFloorRaw,
    f.walletNetMinRaw ?? "",
    f.slippageBps,
    f.expiresAt,
  ].join(FIELD_SEPARATOR);
}

/** sha256 hex over the canonical serialization of the bound fields. */
export function digestVirtualsSnapshot(fields: VirtualsSnapshotFields): string {
  return createHash("sha256").update(canonicalizeSnapshotFields(fields), "utf8").digest("hex");
}

/** Seal the bound fields with their digest. */
export function sealVirtualsSnapshot(fields: VirtualsSnapshotFields): VirtualsExecutionSnapshot {
  return { ...fields, digest: digestVirtualsSnapshot(fields) };
}

const digits = z.string().regex(/^\d+$/);
const TokenSchema = z.object({
  address: z.string().min(1),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(255),
});

const FeeSchema = z.union([
  z.object({
    disposition: z.literal("charged_on_input"),
    amountRaw: digits,
    receiver: z.string().min(1),
    bps: z.number().int().positive(),
    disclosureText: z.string().min(1),
  }),
  z.object({
    disposition: z.literal("not_charged"),
    amountRaw: z.null(),
    receiver: z.string().min(1),
    bps: z.literal(0),
    disclosureText: z.string().min(1),
  }),
  z.object({
    disposition: z.literal("charged_on_settled_output"),
    amountRaw: digits,
    receiver: z.string().min(1),
    bps: z.number().int().positive(),
    disclosureText: z.string().min(1),
  }),
]);

const VirtualsSnapshotSchema = z.object({
  v: z.literal(VIRTUALS_SNAPSHOT_VERSION),
  provider: z.literal("virtuals"),
  chainId: z.number().int().positive(),
  side: z.union([z.literal("buy"), z.literal("sell")]),
  token: TokenSchema,
  virtual: TokenSchema,
  pair: z.string().min(1),
  bondingV5Implementation: z.string().min(1),
  frouterV3Implementation: z.string().min(1),
  totalInRaw: digits,
  curveAmountRaw: digits,
  fee: FeeSchema,
  taxes: z.object({
    protocolTaxPct: z.number().int().min(0).max(100),
    effectiveAntiSniperPct: z.number().int().min(0).max(100),
    antiSniperType: z.number().int().min(0).max(255),
    acceptedAntiSniperPct: z.number().int().min(0).max(100).nullable(),
  }),
  quotedOutRaw: digits,
  contractFloorRaw: digits,
  walletNetMinRaw: digits.nullable(),
  slippageBps: z.number().int().min(0).max(10_000),
  expiresAt: z.string().min(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

const VirtualsSnapshotVersionSchema = z.object({ v: z.number().int() });

export type RestoredVirtualsSnapshot =
  | { readonly ok: true; readonly snapshot: VirtualsExecutionSnapshot }
  | { readonly ok: false; readonly refusal: SnapshotRefusal };

/** True when a durable `route_ref` claims to be a Virtuals snapshot at all. */
export function isVirtualsRouteRef(routeRef: unknown): boolean {
  return typeof routeRef === "object"
    && routeRef !== null
    && (routeRef as { provider?: unknown }).provider === "virtuals";
}

/**
 * Validate a stored `route_ref` and re-check its digest.
 *
 * The shape is re-asserted rather than assumed even though this build wrote it:
 * the data has crossed durable storage since, and a calldata floor, a fee and a
 * contract implementation are derived from it (rule 04).
 */
export function restoreVirtualsSnapshot(routeRef: unknown): RestoredVirtualsSnapshot {
  if (routeRef === null || routeRef === undefined) {
    return { ok: false, refusal: snapshotRefusal("missing_snapshot", VIRTUALS_FRESH_QUOTE_TOOL) };
  }
  const version = VirtualsSnapshotVersionSchema.safeParse(routeRef);
  if (version.success && version.data.v !== VIRTUALS_SNAPSHOT_VERSION) {
    return { ok: false, refusal: snapshotRefusal("snapshot_version_unsupported", VIRTUALS_FRESH_QUOTE_TOOL) };
  }
  const parsed = VirtualsSnapshotSchema.safeParse(routeRef);
  if (!parsed.success) {
    return { ok: false, refusal: snapshotRefusal("snapshot_unreadable", VIRTUALS_FRESH_QUOTE_TOOL) };
  }
  const { digest, ...fields } = parsed.data;
  if (digestVirtualsSnapshot(fields) !== digest) {
    return { ok: false, refusal: snapshotRefusal("digest_mismatch", VIRTUALS_FRESH_QUOTE_TOOL) };
  }
  return { ok: true, snapshot: parsed.data };
}

// -- Execute-time drift ---------------------------------------------------

/**
 * What the execute re-resolved, held against the snapshot.
 *
 * Deliberately the same field names as the snapshot: the comparison is a field
 * walk, and a rename on one side that is not made on the other should not
 * compile.
 */
export interface VirtualsExecutionInputs {
  readonly chainId: number;
  readonly side: VirtualsTradeSide;
  readonly token: VirtualsSnapshotToken;
  readonly virtual: VirtualsSnapshotToken;
  readonly pair: string;
  readonly bondingV5Implementation: string;
  readonly frouterV3Implementation: string;
  readonly totalInRaw: string;
  readonly curveAmountRaw: string;
  readonly fee: VirtualsSnapshotFee;
  readonly taxes: VirtualsSnapshotTaxes;
}

export type VirtualsDriftKind =
  | "pair_changed"
  | "side_changed"
  | "implementation_changed"
  | "amount_changed"
  | "fee_changed"
  | "tax_changed"
  | "anti_sniper_bound_changed";

export interface VirtualsDriftRefusal {
  readonly kind: VirtualsDriftKind;
  readonly message: string;
  readonly hint: string;
}

const DRIFT_HINT =
  "Nothing was signed; the amount, the fee and the taxes you approved were not altered to make the trade fit. "
  + `Get a fresh ${VIRTUALS_FRESH_QUOTE_TOOL}.`;

function driftRefusal(kind: VirtualsDriftKind, what: string): VirtualsDriftRefusal {
  return { kind, message: `Refused before signing: ${what}.`, hint: DRIFT_HINT };
}

function sameToken(a: VirtualsSnapshotToken, b: VirtualsSnapshotToken): boolean {
  return a.address.toLowerCase() === b.address.toLowerCase() && a.decimals === b.decimals;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Hold the execute's freshly read state against the approved snapshot.
 *
 * The checks are ordered by how badly each one would surprise a person: a
 * different contract first, then a different market, then a different amount,
 * then a different fee, then different taxes. Every refusal names what moved,
 * because "re-quote" is only actionable when the agent knows which figure did.
 */
export function compareVirtualsExecutionInputs(
  snapshot: VirtualsExecutionSnapshot,
  fresh: VirtualsExecutionInputs,
): VirtualsDriftRefusal | null {
  if (
    !sameAddress(snapshot.bondingV5Implementation, fresh.bondingV5Implementation)
    || !sameAddress(snapshot.frouterV3Implementation, fresh.frouterV3Implementation)
  ) {
    return driftRefusal(
      "implementation_changed",
      "the BondingV5 or FRouterV3 proxy has been upgraded since the quote, so the contract that would run this trade is not the one the quote was answered against",
    );
  }
  if (snapshot.side !== fresh.side) {
    return driftRefusal("side_changed", "this execute is for the other side of the trade than the approved quote");
  }
  if (
    snapshot.chainId !== fresh.chainId
    || !sameToken(snapshot.token, fresh.token)
    || !sameToken(snapshot.virtual, fresh.virtual)
    || !sameAddress(snapshot.pair, fresh.pair)
  ) {
    return driftRefusal(
      "pair_changed",
      "the curve pair this execute resolved is not the pair the approved quote was answered for",
    );
  }
  if (snapshot.totalInRaw !== fresh.totalInRaw || snapshot.curveAmountRaw !== fresh.curveAmountRaw) {
    return driftRefusal(
      "amount_changed",
      `the amount that would reach the curve changed since the quote (approved ${snapshot.curveAmountRaw} raw units, now ${fresh.curveAmountRaw})`,
    );
  }
  if (
    snapshot.fee.disposition !== fresh.fee.disposition
    || snapshot.fee.amountRaw !== fresh.fee.amountRaw
    || snapshot.fee.bps !== fresh.fee.bps
    || !sameAddress(snapshot.fee.receiver, fresh.fee.receiver)
    || snapshot.fee.disclosureText !== fresh.fee.disclosureText
  ) {
    return driftRefusal(
      "fee_changed",
      `the Vex fee resolved differently than at quote time (approved ${snapshot.fee.amountRaw ?? "none"} raw units, now ${fresh.fee.amountRaw ?? "none"})`,
    );
  }
  if (snapshot.taxes.acceptedAntiSniperPct !== fresh.taxes.acceptedAntiSniperPct) {
    return driftRefusal(
      "anti_sniper_bound_changed",
      "this execute states a different anti-sniper tax bound than the one the approved quote was answered under",
    );
  }
  if (
    snapshot.taxes.protocolTaxPct !== fresh.taxes.protocolTaxPct
    || snapshot.taxes.antiSniperType !== fresh.taxes.antiSniperType
  ) {
    return driftRefusal(
      "tax_changed",
      `the curve's tax setup changed since the quote (protocol tax approved ${snapshot.taxes.protocolTaxPct}%, now ${fresh.taxes.protocolTaxPct}%;`
      + ` anti-sniper type approved ${snapshot.taxes.antiSniperType}, now ${fresh.taxes.antiSniperType})`,
    );
  }
  return null;
}

/**
 * The refusal for an anti-sniper percent that rose above what the caller
 * accepted.
 *
 * SEPARATE from `compareVirtualsExecutionInputs` because it is not drift: the
 * anti-sniper tax is EXPECTED to move between the quote and the execute (it
 * decays every second), and the question is not whether it changed but whether
 * it is still inside the bound the caller consented to. A rise can only happen
 * when the window's clock moved, which is a real and refusable event.
 */
export function antiSniperBoundExceededRefusal(input: {
  readonly approvedPct: number | null;
  readonly currentPct: number;
  readonly side: VirtualsTradeSide;
  readonly remainingSeconds: number;
}): { readonly message: string; readonly hint: string } {
  const bound = input.approvedPct === null
    ? "you accepted no anti-sniper tax at all"
    : `you accepted at most ${input.approvedPct}%`;
  return {
    message:
      `Refused before signing: the anti-sniper tax on this ${input.side} is ${input.currentPct}% right now and ${bound}.`,
    hint:
      `The window has about ${input.remainingSeconds}s left; it decays to zero on its own. Nothing was signed. `
      + `Wait for it to expire, or get a fresh ${VIRTUALS_FRESH_QUOTE_TOOL} and accept the higher bound deliberately.`,
  };
}

/** The refusal for a fresh quote that can no longer reach the approved floor. */
export function floorUnreachableRefusal(input: {
  readonly snapshot: VirtualsExecutionSnapshot;
  readonly outSymbol: string;
  readonly outHuman: string;
  readonly floorHuman: string;
}): { readonly message: string; readonly hint: string } {
  return {
    message:
      `Refused before signing: the curve no longer reaches the approved floor of `
      + `${input.floorHuman} ${input.outSymbol}; it is now worth about ${input.outHuman}.`,
    hint:
      `The market moved past the ${input.snapshot.slippageBps} bps you approved. Nothing was signed and the floor `
      + `was not lowered. Get a fresh ${VIRTUALS_FRESH_QUOTE_TOOL}.`,
  };
}

// -- Approval-card facts -------------------------------------------------

/**
 * The version tag of the Virtuals quote-binding line on an approval card.
 *
 * It rides INSIDE the rendered card value, so a card written by an older build
 * and one written by this build are textually different and the whole-card
 * comparison at confirm time refuses the mismatch. An in-flight proposal from an
 * older build therefore expires cleanly instead of being confirmed against a
 * line whose meaning changed underneath the human.
 */
export const VIRTUALS_QUOTE_BINDING_CARD_VERSION = "virtuals-quote-v1";

export interface VirtualsCardFacts {
  readonly quotedOutHuman: string;
  readonly contractFloorHuman: string;
  readonly outSymbol: string;
  /** The venue sentences the card appends after the shared price line. */
  readonly lines: readonly string[];
}

/**
 * What a person must read to consent to a curve trade, beyond the price and the
 * floor.
 *
 * Every line is derived from the SEALED snapshot and from nothing else, so the
 * card cannot state a fact the execute is not held to. The sell arm says in
 * words that the enforced floor bounds the router's GROSS output and that the
 * wallet figure is an estimate - the single most misreadable number on this
 * venue, and the reason `walletNetMin` is never called a floor anywhere.
 */
export function virtualsCardFacts(snapshot: VirtualsExecutionSnapshot): VirtualsCardFacts {
  const out = snapshot.side === "buy" ? snapshot.token : snapshot.virtual;
  const inToken = snapshot.side === "buy" ? snapshot.virtual : snapshot.token;
  const lines: string[] = [
    `${snapshot.side} on the Virtuals bonding curve`,
    `spends ${formatAmount(snapshot.totalInRaw, inToken.decimals)} ${inToken.symbol} in total`,
    snapshot.side === "buy"
      ? `floor is enforced by BondingV5 on the tokens delivered`
      : `floor is enforced by BondingV5 on the router's GROSS ${out.symbol}, BEFORE the curve's taxes`,
    `curve protocol tax ${snapshot.taxes.protocolTaxPct}%`,
    snapshot.taxes.effectiveAntiSniperPct > 0
      ? `anti-sniper tax ${snapshot.taxes.effectiveAntiSniperPct}% (type ${snapshot.taxes.antiSniperType}), accepted bound ${snapshot.taxes.acceptedAntiSniperPct ?? "none"}%`
      : `no anti-sniper tax on this side (type ${snapshot.taxes.antiSniperType})`,
    `BondingV5 implementation ${snapshot.bondingV5Implementation}`,
    `FRouterV3 implementation ${snapshot.frouterV3Implementation}`,
    feeLine(snapshot),
  ];
  if (snapshot.walletNetMinRaw !== null) {
    lines.push(
      `estimated wallet net at that floor ${formatAmount(snapshot.walletNetMinRaw, out.decimals)} ${out.symbol}`
      + " (ESTIMATE at the current tax, not enforced by the contract)",
    );
  }
  return {
    quotedOutHuman: formatAmount(snapshot.quotedOutRaw, out.decimals),
    contractFloorHuman: formatAmount(snapshot.contractFloorRaw, out.decimals),
    outSymbol: out.symbol,
    lines,
  };
}

function feeLine(snapshot: VirtualsExecutionSnapshot): string {
  const fee = snapshot.fee;
  if (fee.disposition === "not_charged") {
    return `Vex fee: none on this trade (${fee.disclosureText})`;
  }
  const amount = `${formatAmount(fee.amountRaw, snapshot.virtual.decimals)} ${snapshot.virtual.symbol} | ${fee.amountRaw} raw units`;
  return fee.disposition === "charged_on_input"
    ? `Vex fee ${fee.bps} bps: ${amount}, taken from the VIRTUAL you commit and transferred to ${fee.receiver} only after the trade confirms`
    : `Vex fee ${fee.bps} bps of the VIRTUAL you receive, paid to ${fee.receiver} after the sale settles; about ${amount} at this quote, exact amount decided by the receipt`;
}

/**
 * Exact decimal rendering of a raw atomic amount. No `Number`, no rounding: a
 * card figure that lost precision is a figure the person did not consent to.
 */
function formatAmount(raw: string, decimals: number): string {
  const digits = raw.padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}
