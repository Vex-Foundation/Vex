/**
 * `UnitsConvert` — the agent's deterministic unit/percentage calculator.
 *
 * WHY IT EXISTS. Every money mistake this repo has recorded is an arithmetic
 * one the model did in its head: `22518000` wei read as 22.5 gwei instead of
 * 0.0225 (a thousandfold gas-price error), a raw amount read at the wrong
 * decimals, a bps fee estimated rather than computed. The model is not a
 * calculator; this tool is. It is read-only, always available, touches no
 * provider and no wallet, and every answer is exact.
 *
 * ## The contract in one paragraph
 *
 * Every op answers with the SAME amount shape — `{ raw, decimals, human }`,
 * the repo's canonical "raw amounts travel with the decimals needed to read
 * them" pair (`rules/90`), plus `human` already rendered so the model never
 * has to shift a decimal point itself. `remainder` appears ONLY when flooring
 * actually discarded value, and each op's manifest text names what that bare
 * integer is a remainder OF (its source unit, or its numerator/denominator) —
 * an undocumented residue would be one more number to misread.
 *
 * ## Rules that shaped the implementation
 *
 *  - ALL math is BigInt over scaled integers. No float ever touches a value.
 *  - Rounding is ALWAYS floor, and a floor that discards value must say so.
 *  - Atomic units (`wei`, `lamports`, `raw`) are INTEGER-ONLY: `"1.5"` in a
 *    raw field is refused BY NAME, because it is the signature of a model that
 *    has already confused human and base units.
 *  - Conversions are SAME-FAMILY only. There is no fixed wei↔lamports rate, so
 *    a cross-family request is a category error, not a missing feature.
 *  - Negatives are refused by name everywhere; zero is legal everywhere.
 *
 * ## Deviation from the plan, deliberate (reported to the coordinator)
 *
 * The plan illustrated `remainder` with "1 wei → gwei reports remainder 1",
 * which requires flooring the result to a WHOLE gwei. That is incompatible
 * with the plan's own headline requirement that `22518000 wei` converts to
 * `0.022518 gwei` (whole-gwei flooring would answer `0`), and a converter that
 * answers 0 gwei for a real gas price is worse than no converter. This
 * implementation therefore denominates the result rather than truncating it:
 * a same-family conversion is EXACT, and an input finer than the family's
 * atomic unit is refused by name instead of being silently floored. Value is
 * still never lost silently — it is refused loudly. `remainder` remains
 * required, and is exercised, on the three ops that genuinely floor:
 * `apply_bps`, `usd_to_token_amount`, `token_amount_to_usd`.
 */

import { z } from "zod";

import type { ToolResult } from "../types.js";
import { fail, ok } from "./types.js";
import { dropEmptyModelValues, formatZodIssuesForModel } from "./arg-validation.js";
import { formatRawAmount } from "../protocols/amount-display.js";

// ── Value grammar ────────────────────────────────────────────────

/** uint256 has 78 decimal digits; nothing legitimate in this domain is longer. */
const MAX_VALUE_DIGITS = 78;
const MAX_DECIMALS = 36;

const INTEGER_GRAMMAR = /^[0-9]+$/;
const DECIMAL_GRAMMAR = /^[0-9]+(\.[0-9]+)?$/;

/** A rejection the model can act on, carried out of the pure math layer. */
class UnitsInputError extends Error {}

function refuse(message: string): never {
  throw new UnitsInputError(message);
}

function countDigits(value: string): number {
  let digits = 0;
  for (const char of value) if (char !== ".") digits += 1;
  return digits;
}

/**
 * An ATOMIC value: digits only. The refusal names the decimal point explicitly
 * because that is the actual defect nine times out of ten — a human amount
 * pasted into a base-unit field.
 */
function parseIntegerValue(field: string, value: string, unitNote: string): bigint {
  if (value.startsWith("-")) {
    refuse(`${field} must not be negative — this tool works on non-negative amounts only.`);
  }
  if (!INTEGER_GRAMMAR.test(value)) {
    refuse(
      `${field} must be digits only, with no decimal point, no sign and no separators (${unitNote}).`,
    );
  }
  if (countDigits(value) > MAX_VALUE_DIGITS) {
    refuse(`${field} has more than ${MAX_VALUE_DIGITS} digits, which is past the uint256 ceiling.`);
  }
  return BigInt(value);
}

/** A decimal value, kept exactly as `digits × 10^-scale`. Never a float. */
interface ScaledDecimal {
  readonly digits: bigint;
  readonly scale: number;
}

function parseDecimalValue(field: string, value: string): ScaledDecimal {
  if (value.startsWith("-")) {
    refuse(`${field} must not be negative — this tool works on non-negative amounts only.`);
  }
  if (!DECIMAL_GRAMMAR.test(value)) {
    refuse(
      `${field} must be a plain decimal number as a string, e.g. "0.0225" — no sign, no exponent, no separators, and a digit before the point.`,
    );
  }
  if (countDigits(value) > MAX_VALUE_DIGITS) {
    refuse(`${field} has more than ${MAX_VALUE_DIGITS} digits, which is past the uint256 ceiling.`);
  }
  const point = value.indexOf(".");
  if (point < 0) return { digits: BigInt(value), scale: 0 };
  const fraction = value.slice(point + 1);
  return { digits: BigInt(value.slice(0, point) + fraction), scale: fraction.length };
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

// ── The one output shape ─────────────────────────────────────────

/**
 * The uniform amount every op answers with. `raw` and `decimals` are the
 * machine pair; `human` is the same number already rendered. `remainder` is
 * present ONLY when a floor discarded value.
 */
export interface UnitsAmount {
  readonly raw: string;
  readonly decimals: number;
  readonly human: string;
  readonly remainder?: string;
}

function amount(raw: bigint, decimals: number, remainder?: bigint): UnitsAmount {
  const human = formatRawAmount(raw, decimals);
  if (human === null) {
    // Unreachable for a bigint + validated decimals. Named rather than
    // defaulted: a silently wrong human figure is the failure this tool exists
    // to prevent, so an impossible render is a refusal, never a fallback.
    refuse(`internal: could not render the result at ${decimals} decimals.`);
  }
  return remainder !== undefined && remainder !== 0n
    ? { raw: raw.toString(), decimals, human, remainder: remainder.toString() }
    : { raw: raw.toString(), decimals, human };
}

// ── Unit families ────────────────────────────────────────────────

const UNIT_NAMES = ["wei", "gwei", "eth", "lamports", "sol", "raw", "human"] as const;
type UnitName = (typeof UNIT_NAMES)[number];

type UnitFamily = "evm" | "solana" | "token";

const FAMILY_LABEL: Record<UnitFamily, string> = {
  evm: "EVM native (wei/gwei/eth)",
  solana: "Solana native (lamports/sol)",
  token: "token base units (raw/human)",
};

interface UnitSpec {
  readonly family: UnitFamily;
  /** Decimals between this unit and its family's atomic unit. `null` → the caller's `decimals`. */
  readonly exponent: number | null;
}

const UNITS: Record<UnitName, UnitSpec> = {
  wei: { family: "evm", exponent: 0 },
  gwei: { family: "evm", exponent: 9 },
  eth: { family: "evm", exponent: 18 },
  lamports: { family: "solana", exponent: 0 },
  sol: { family: "solana", exponent: 9 },
  raw: { family: "token", exponent: 0 },
  human: { family: "token", exponent: null },
};

/** The atomic unit of each family — the one a value cannot be finer than. */
const ATOM_LABEL: Record<UnitFamily, string> = {
  evm: "1 wei",
  solana: "1 lamport",
  token: "1 raw base unit",
};

function unitExponent(unit: UnitName, decimals: number | undefined): number {
  const spec = UNITS[unit];
  if (spec.exponent !== null) return spec.exponent;
  if (decimals === undefined) {
    refuse(
      `decimals is required when \`from\` or \`to\` is "human" or "raw" — a raw token amount is unreadable without the token's decimals (get them from TokenFind).`,
    );
  }
  return decimals;
}

// ── Ops ──────────────────────────────────────────────────────────

function runUnitConvert(args: {
  value: string;
  from: UnitName;
  to: UnitName;
  decimals?: number;
}): UnitsAmount {
  const fromSpec = UNITS[args.from];
  const toSpec = UNITS[args.to];
  if (fromSpec.family !== toSpec.family) {
    refuse(
      `cannot convert "${args.from}" (${FAMILY_LABEL[fromSpec.family]}) to "${args.to}" (${FAMILY_LABEL[toSpec.family]}) — these are different unit families and no fixed rate exists between them. Convert within one family; for a value across chains use a price instead (usd_to_token_amount / token_amount_to_usd).`,
    );
  }

  const fromExponent = unitExponent(args.from, args.decimals);
  const toExponent = unitExponent(args.to, args.decimals);

  if (fromExponent === 0) {
    // An atomic unit is integer-only. Accepting "1.5 wei" would mean inventing
    // a rounding policy for a value that cannot exist.
    const atoms = parseIntegerValue(
      "value",
      args.value,
      `"${args.from}" is an atomic unit, so it counts whole units`,
    );
    return amount(atoms, toExponent);
  }

  const parsed = parseDecimalValue("value", args.value);
  if (parsed.scale > fromExponent) {
    refuse(
      `value is finer than ${ATOM_LABEL[fromSpec.family]}: "${args.from}" carries at most ${fromExponent} decimal places and ${parsed.scale} were supplied. Restate the amount in the atomic unit rather than letting a fraction of it be dropped.`,
    );
  }
  return amount(parsed.digits * pow10(fromExponent - parsed.scale), toExponent);
}

function runGasCost(args: { gasUnits: string; gasPriceWei: string }): {
  wei: UnitsAmount;
  gwei: UnitsAmount;
  eth: UnitsAmount;
} {
  const units = parseIntegerValue("gasUnits", args.gasUnits, "a gas count is unitless and whole");
  const price = parseIntegerValue("gasPriceWei", args.gasPriceWei, "wei is an atomic unit");
  const costWei = units * price;
  return {
    wei: amount(costWei, 0),
    gwei: amount(costWei, 9),
    eth: amount(costWei, 18),
  };
}

const BPS_DENOMINATOR = 10_000n;

function runApplyBps(args: { amountRaw: string; bps: number; decimals: number }): {
  fee: UnitsAmount;
  net: UnitsAmount;
} {
  const total = parseIntegerValue("amountRaw", args.amountRaw, "a base-unit amount is whole");
  const product = total * BigInt(args.bps);
  const feeRaw = product / BPS_DENOMINATOR;
  // The fee is floored, so the fraction of one base unit that the floor threw
  // away is reported as ten-thousandths of a base unit.
  const discarded = product % BPS_DENOMINATOR;
  return {
    fee: amount(feeRaw, args.decimals, discarded),
    net: amount(total - feeRaw, args.decimals),
  };
}

function requirePositivePrice(price: ScaledDecimal): void {
  if (price.digits === 0n) {
    refuse("priceUsd must be greater than zero — a zero price cannot value an amount.");
  }
}

function runUsdToTokenAmount(args: {
  usd: string;
  priceUsd: string;
  decimals: number;
}): UnitsAmount {
  const usd = parseDecimalValue("usd", args.usd);
  const price = parseDecimalValue("priceUsd", args.priceUsd);
  requirePositivePrice(price);

  // raw = floor(usd / priceUsd × 10^decimals), all of it in integers:
  //   numerator   = usdDigits × 10^priceScale × 10^decimals
  //   denominator = priceDigits × 10^usdScale
  const numerator = usd.digits * pow10(price.scale) * pow10(args.decimals);
  const denominator = price.digits * pow10(usd.scale);
  return amount(numerator / denominator, args.decimals, numerator % denominator);
}

/** USD is reported to 6 fractional digits — a micro-dollar, the smallest figure worth quoting. */
const USD_PRECISION = 6;

function runTokenAmountToUsd(args: {
  amountRaw: string;
  priceUsd: string;
  decimals: number;
}): { usd: string; usdPrecision: number; remainder: string } {
  const raw = parseIntegerValue("amountRaw", args.amountRaw, "a base-unit amount is whole");
  const price = parseDecimalValue("priceUsd", args.priceUsd);
  requirePositivePrice(price);

  // usdMicros = floor(amountRaw × priceUsd / 10^decimals × 10^6)
  const numerator = raw * price.digits * pow10(USD_PRECISION);
  const denominator = pow10(price.scale + args.decimals);
  const micros = numerator / denominator;
  const rendered = formatRawAmount(micros, USD_PRECISION);
  if (rendered === null) refuse("internal: could not render the USD result.");
  return {
    usd: rendered,
    usdPrecision: USD_PRECISION,
    remainder: (numerator % denominator).toString(),
  };
}

// ── Argument schema ──────────────────────────────────────────────

const decimalsField = z
  .number()
  .int({ message: "decimals must be a whole number" })
  .min(0, { message: "decimals must be between 0 and 36" })
  .max(MAX_DECIMALS, { message: `decimals must be between 0 and ${MAX_DECIMALS}` });

const stringField = (name: string) =>
  z.string({ error: `${name} must be a string, so no precision is lost before the tool sees it` });

const UnitsConvertArgs = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("unit_convert"),
    value: stringField("value"),
    from: z.enum(UNIT_NAMES),
    to: z.enum(UNIT_NAMES),
    decimals: decimalsField.optional(),
  }).strict(),
  z.object({
    op: z.literal("gas_cost"),
    gasUnits: stringField("gasUnits"),
    gasPriceWei: stringField("gasPriceWei"),
  }).strict(),
  z.object({
    op: z.literal("apply_bps"),
    amountRaw: stringField("amountRaw"),
    bps: z
      .number()
      .int({ message: "bps must be a whole number of basis points (1 bps = 0.01%)" })
      .min(0, { message: "bps must be between 0 and 10000 (1 bps = 0.01%)" })
      .max(10_000, { message: "bps must be between 0 and 10000 (1 bps = 0.01%)" }),
    decimals: decimalsField,
  }).strict(),
  z.object({
    op: z.literal("usd_to_token_amount"),
    usd: stringField("usd"),
    priceUsd: stringField("priceUsd"),
    decimals: decimalsField,
  }).strict(),
  z.object({
    op: z.literal("token_amount_to_usd"),
    amountRaw: stringField("amountRaw"),
    priceUsd: stringField("priceUsd"),
    decimals: decimalsField,
  }).strict(),
]);

/**
 * Run the validated op. Exported for the test suite and for any caller that
 * wants the math without the tool envelope.
 */
export function computeUnitsConvert(args: z.infer<typeof UnitsConvertArgs>): Record<string, unknown> {
  switch (args.op) {
    case "unit_convert":
      return { op: args.op, result: runUnitConvert(args) };
    case "gas_cost":
      return { op: args.op, cost: runGasCost(args) };
    case "apply_bps":
      return { op: args.op, ...runApplyBps(args) };
    case "usd_to_token_amount":
      return { op: args.op, result: runUsdToTokenAmount(args) };
    case "token_amount_to_usd":
      return { op: args.op, ...runTokenAmountToUsd(args) };
  }
}

export async function handleUnitsConvert(params: Record<string, unknown>): Promise<ToolResult> {
  // `op` selects the contract, so an empty one must survive normalization: the
  // union's own "invalid op" message names the legal ops, "missing op" does not.
  const parsed = UnitsConvertArgs.safeParse(dropEmptyModelValues(params, { preserveKeys: ["op"] }));
  if (!parsed.success) {
    return fail(`UnitsConvert: ${formatZodIssuesForModel(parsed.error.issues, params)}`);
  }

  try {
    return ok(computeUnitsConvert(parsed.data));
  } catch (error) {
    if (error instanceof UnitsInputError) return fail(`UnitsConvert: ${error.message}`);
    throw error;
  }
}
