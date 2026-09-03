/**
 * `UnitsConvert` - the deterministic unit/percentage calculator.
 *
 * Always visible, read-only, no provider and no wallet. It exists because the
 * model doing this arithmetic in its head is how gas prices become thousandfold
 * errors and raw amounts get read at the wrong decimals.
 *
 * The manifest below is the whole model-facing contract, so it carries worked
 * examples rather than prose: an example is the only part of a schema an LLM
 * reliably copies. Handler: `internal/units-convert.ts`.
 */

import type { ToolDef } from "../types.js";
import { READ_ONLY_NO_VEX_FEE } from "../vex-fee-notes.js";

/**
 * The shared answer shape, stated once. Every op answers in it, so the model
 * learns one reading rule instead of five.
 */
const AMOUNT_SHAPE_SENTENCE =
  "It returns every amount as { raw, decimals, human }: `raw` is the exact integer in base units, `decimals` says how to read it, `human` is that same number already rendered. `remainder` appears ONLY when flooring discarded value, and each op below names what its remainder counts.";

const OP_DESCRIPTION = [
  "Which calculation to run.",
  "'unit_convert' - restate one amount in another unit of the SAME family ({wei,gwei,eth} or {lamports,sol} or {raw,human}); exact, never floors, so it returns no remainder.",
  "'gas_cost' - gasUnits x gasPriceWei, answered in wei, gwei and eth at once; exact, no remainder.",
  "'apply_bps' - split an amount into fee and net at a basis-point rate; fee.remainder counts TEN-THOUSANDTHS of one base unit that the floor dropped (numerator over denominator 10000).",
  "'usd_to_token_amount' - how many base units a USD figure buys; remainder is the leftover numerator over the divisor (priceUsd scaled to an integer), always smaller than the cost of one base unit.",
  "'token_amount_to_usd' - what a base-unit amount is worth; usd is floored to 6 decimals (usdPrecision) and remainder is the leftover numerator over 10^(priceUsd decimals + token decimals), i.e. the value below one micro-dollar.",
].join(" ");

const WORKED_EXAMPLES = [
  "Examples.",
  "(1) THE GWEI TRAP: {op:'unit_convert', value:'22518000', from:'wei', to:'gwei'} -> human '0.022518'. A gas price of 22518000 wei is 0.0225 gwei, NOT 22.5 - never read a bare wei figure as gwei.",
  "(2) RAW vs HUMAN: {op:'unit_convert', value:'1047061', from:'raw', to:'human', decimals:6} -> human '1.047061'. The same raw number at decimals 9 is 0.001047061, so always pass the token's real decimals (from TokenFind).",
  "(3) FEE: {op:'apply_bps', amountRaw:'1000000000', bps:25, decimals:9} -> fee.raw '2500000' (human '0.0025'), net.raw '997500000'.",
].join(" ");

export const UNITS_TOOLS: readonly ToolDef[] = [
  {
    name: "UnitsConvert",
    kind: "internal",
    mutating: false,
    pressureSafety: "read_only",
    actionKind: "read",
    description:
      `Exact money math - use it instead of calculating in your head, always. Converts between units of one family (wei/gwei/eth, lamports/SOL, raw/human at a token's decimals), multiplies out a gas cost, applies a basis-point fee, and converts between a USD figure and a token amount at a price. All arithmetic is integer arithmetic, rounding is always DOWN, and no value is ever silently dropped. ${AMOUNT_SHAPE_SENTENCE} Amounts are passed as STRINGS so nothing is lost before the tool sees them; atomic units (wei, lamports, raw) take digits only, and a decimal point in one is refused. ${WORKED_EXAMPLES}`,
    returns: "It returns every amount as { raw, decimals, human }: `raw` is the exact integer in base units, `decimals` says how to read it, `human` is that same number already rendered. `remainder` appears ONLY when flooring discarded value, and each op below names what its remainder counts.",
    vexFee: READ_ONLY_NO_VEX_FEE,
    parameters: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "unit_convert",
            "gas_cost",
            "apply_bps",
            "usd_to_token_amount",
            "token_amount_to_usd",
          ],
          description: OP_DESCRIPTION,
        },
        value: {
          type: "string",
          description:
            "unit_convert only. The amount to restate, as a string. Digits only when `from` is an atomic unit (wei/lamports/raw); a decimal like '0.0225' is allowed for gwei/eth/sol/human, but never finer than one atomic unit.",
        },
        from: {
          type: "string",
          enum: ["wei", "gwei", "eth", "lamports", "sol", "raw", "human"],
          description:
            "unit_convert only. The unit `value` is currently in. Must be in the same family as `to`: {wei,gwei,eth}, {lamports,sol}, or {raw,human}.",
        },
        to: {
          type: "string",
          enum: ["wei", "gwei", "eth", "lamports", "sol", "raw", "human"],
          description:
            "unit_convert only. The unit to restate the amount in. Same family as `from` - there is no fixed rate between wei and lamports, so a cross-family request is refused.",
        },
        decimals: {
          type: "number",
          description:
            "The token's decimals, 0 to 36 (get them from TokenFind - 6 for USDC, 18 for most ERC-20s). Required for apply_bps, usd_to_token_amount and token_amount_to_usd, and for unit_convert whenever `from` or `to` is 'raw' or 'human'.",
        },
        gasUnits: {
          type: "string",
          description:
            "gas_cost only. The gas UNIT count as a digits-only string (a unitless count, e.g. '1634838') - never a gas price.",
        },
        gasPriceWei: {
          type: "string",
          description:
            "gas_cost only. The gas PRICE in wei as a digits-only string (e.g. '22518000', which is 0.022518 gwei).",
        },
        amountRaw: {
          type: "string",
          description:
            "apply_bps / token_amount_to_usd. The amount in BASE units as a digits-only string, read together with `decimals`.",
        },
        bps: {
          type: "number",
          description:
            "apply_bps only. The rate in basis points, 0 to 10000 (1 bps = 0.01%, so 25 bps = 0.25% and 10000 bps = 100%).",
        },
        usd: {
          type: "string",
          description:
            "usd_to_token_amount only. The USD figure as a decimal string, e.g. '250.75'. No currency symbol and no thousands separators.",
        },
        priceUsd: {
          type: "string",
          description:
            "usd_to_token_amount / token_amount_to_usd. The price of ONE whole token in USD, as a decimal string greater than zero, e.g. '0.00031415'.",
        },
      },
      required: ["op"],
    },
  },
];
