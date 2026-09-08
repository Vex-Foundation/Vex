/**
 * Reading and refusing the curve trade's parameters, BEFORE any chain read, any
 * session lookup and any key.
 *
 * Everything here is pure and cheap on purpose: a caller whose tolerance is out
 * of range, whose fee override is present, or whose chain has no curve must
 * learn that from a sentence, not from an RPC round trip - and no such call may
 * reach a durable row or a signing key.
 *
 * THE ONE RULE THAT IS NOT ABOUT CONVENIENCE. `checkForbiddenTradeParams`
 * rejects a caller-supplied fee rate or receiver BY NAME rather than dropping
 * it. A silent drop hides an attempted overcharge instead of surfacing it
 * (rule 90); the rate and the receiver are product constants in
 * `@tools/virtuals/curve/fee.js` and can never come from model input.
 */

import { isAddress, getAddress, parseUnits, type Address } from "viem";

import {
  VIRTUALS_CURVE_CHAIN_KEYS,
  virtualsCurveDeployment,
  type VirtualsCurveDeployment,
} from "@tools/virtuals/curve/index.js";
import { checkSlippageBps, VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

import { num, str } from "../../../handler-helpers.js";
import { resolveVirtualsChain, virtualsChainSlug } from "../../chain-param.js";
import type { VirtualsTradeSide } from "@vex-agent/tools/protocols/quote-authority/virtuals.js";

/**
 * Fee parameters Vex derives itself and MUST NOT accept from a caller or model.
 *
 * The list is wider than the sibling venues' because a launchpad surface invites
 * more spellings: `vexFee*` and `feeRecipient` are named explicitly so a model
 * that reaches for them gets the fact rather than "unknown parameter".
 */
const FORBIDDEN_FEE_PARAMS = [
  "fee",
  "feeBps",
  "feeReceiver",
  "feeRecipient",
  "feeAmount",
  "vexFee",
  "vexFeeBps",
  "vexFeeReceiver",
] as const;

/**
 * The rejection reason for the first caller-supplied fee param, else null.
 *
 * PRESENCE of the key is the violation, whatever it carries: an empty string,
 * `null`, or an explicit `undefined` is still an attempted override.
 */
export function checkForbiddenTradeParams(params: Readonly<Record<string, unknown>>): string | null {
  for (const key of FORBIDDEN_FEE_PARAMS) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      return `Parameter "${key}" is not accepted - Vex's curve trade fee rate and receiver are fixed product constants; remove it and retry.`;
    }
  }
  return null;
}

/** A chain Virtuals runs on that has no bonding curve Vex can sign against. */
export interface TradeChainHandoff {
  readonly kind: "handoff";
  /** The canonical slug the caller passed, echoed. */
  readonly chain: string;
  /** Agent-facing sentence naming the tool that CAN do this. */
  readonly reason: string;
  /** The tool family to use instead, or null when nothing can. */
  readonly useInstead: string | null;
}

export type TradeChainResolution =
  | { readonly kind: "curve"; readonly deployment: VirtualsCurveDeployment }
  | TradeChainHandoff
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Resolve the `chain` parameter to a curve deployment, or to the typed hand-off
 * for a chain Virtuals runs on without one Vex can trade.
 *
 * SOLANA IS NOT AN ERROR. Virtuals launches real agents there; their curve is a
 * Meteora dynamic bonding-curve pool routed by Jupiter, which Vex already trades
 * through its own namespace. Answering "unsupported chain" would send an agent
 * looking for a workaround for a path that exists.
 */
export function resolveTradeChain(raw: string): TradeChainResolution {
  const chain = resolveVirtualsChain(raw);
  if (chain === null) {
    return {
      kind: "invalid",
      reason:
        `"${raw}" is not a Virtuals chain. Use one of: ${VIRTUALS_CURVE_CHAIN_KEYS.join(", ")} for curve trades, `
        + "or solana / ethereum to be told which tool handles them.",
    };
  }
  const slug = virtualsChainSlug(chain);
  const deployment = virtualsCurveDeployment(slug);
  if (deployment !== undefined) return { kind: "curve", deployment };

  if (slug === "solana") {
    return {
      kind: "handoff",
      chain: slug,
      useInstead: "solana__swap_quote / solana__swap_execute",
      reason:
        "Virtuals agents on Solana do not use the BondingV5 curve Vex signs against: their bonding curve is a "
        + "Meteora dynamic-bonding-curve pool, and Jupiter routes it like any other Solana pool. Trade it with the "
        + "Solana swap tools, using the agent's mint from virtuals__agent_get.",
    };
  }
  return {
    kind: "handoff",
    chain: slug,
    useInstead: null,
    reason:
      "Virtuals runs no bonding curve on Ethereum: agent tokens there are already-graduated ERC-20s. There is "
      + "nothing to trade on a curve, and an ordinary swap venue prices the token if a pool exists.",
  };
}

export interface TradeParams {
  readonly deployment: VirtualsCurveDeployment;
  readonly chainSlug: string;
  readonly token: Address;
  readonly side: VirtualsTradeSide;
  /** The caller's own decimal string, echoed and bound into the prequote hash. */
  readonly amountInHuman: string;
  /** BUY: total VIRTUAL committed. SELL: agent tokens sold. Raw atomic units. */
  readonly amountInRaw: bigint;
  readonly slippageBps: number;
  /**
   * The maximum anti-sniper tax percent the caller accepts on the traded side,
   * or null when they accepted none. NULL IS THE DEFAULT AND IT REFUSES: an
   * active window can tax up to 99 percent, and consenting to that by omission
   * is not consent.
   */
  readonly acceptAntiSniperTaxPct: number | null;
  /** True when the caller asked for the plan without signing anything. */
  readonly simulateOnly: boolean;
}

/** Everything except the parsed amount, which needs the token's own decimals. */
export type PartialTradeParams = Omit<TradeParams, "amountInRaw">;

/**
 * The pure half of parameter validation. A `handoff` is a REFUSAL that names the
 * tool which can do the job, so the caller renders it as an answer rather than
 * as an error.
 */
export type TradeParamsResult =
  | { readonly ok: true; readonly params: PartialTradeParams }
  | { readonly ok: false; readonly reason: string; readonly handoff?: TradeChainHandoff };

/**
 * Validate the whole parameter set for either tool.
 *
 * The AMOUNT is deliberately left unparsed here: a SELL amount is denominated in
 * the AGENT TOKEN, whose decimals are a chain fact nothing has read yet. The
 * caller reads the state, then parses once through `parseTradeAmount` - at that
 * one boundary, from the raw string, and never through a float.
 */
export function readTradeParams(p: Record<string, unknown>, toolId: string): TradeParamsResult {
  const forbidden = checkForbiddenTradeParams(p);
  if (forbidden) return { ok: false, reason: forbidden };

  const chainRaw = str(p, "chain");
  const tokenRaw = str(p, "token");
  const sideRaw = str(p, "side");
  const amountInHuman = str(p, "amountIn").trim();
  if (!chainRaw || !tokenRaw || !sideRaw || !amountInHuman) {
    return { ok: false, reason: "Missing required: chain, token, side, amountIn." };
  }

  const chain = resolveTradeChain(chainRaw);
  if (chain.kind === "invalid") return { ok: false, reason: chain.reason };
  if (chain.kind === "handoff") return { ok: false, reason: chain.reason, handoff: chain };

  if (!isAddress(tokenRaw)) {
    return {
      ok: false,
      reason:
        `"${tokenRaw}" is not a contract address. Pass the agent's token address - virtuals__agents_discover and `
        + "virtuals__agent_get return it as `preToken` for a bonding agent and `tokenAddress` once it has graduated.",
    };
  }
  if (sideRaw !== "buy" && sideRaw !== "sell") {
    return { ok: false, reason: `Parameter "side" must be "buy" or "sell" (got "${sideRaw}").` };
  }

  const slippageRaw = num(p, "slippageBps");
  const slippageBps = slippageRaw ?? VEX_DEFAULT_SLIPPAGE_BPS;
  const violation = checkSlippageBps(`Parameter "slippageBps" for ${toolId}`, slippageBps);
  if (violation) return { ok: false, reason: violation };

  const accept = readAcceptAntiSniper(p);
  if (!accept.ok) return { ok: false, reason: accept.reason };

  const simulateOnly = p.simulateOnly === true;

  return {
    ok: true,
    params: {
      deployment: chain.deployment,
      chainSlug: chain.deployment.key,
      token: getAddress(tokenRaw),
      side: sideRaw,
      amountInHuman,
      slippageBps,
      acceptAntiSniperTaxPct: accept.value,
      simulateOnly,
    },
  };
}

/**
 * Parse the caller's decimal amount at the right scale.
 *
 * `parseUnits` on the RAW STRING - never a `Number` hop. A token amount that has
 * passed through a float has already lost the precision the chain cares about
 * (rule 90: never use floating point for token amounts).
 */
export function parseTradeAmount(
  partial: PartialTradeParams,
  decimals: number,
): { readonly ok: true; readonly params: TradeParams } | { readonly ok: false; readonly reason: string } {
  if (!/^\d+(\.\d+)?$/.test(partial.amountInHuman)) {
    return {
      ok: false,
      reason: `Parameter "amountIn" must be a plain decimal amount in whole tokens (got "${partial.amountInHuman}").`,
    };
  }
  // THE PRECISION CHECK RUNS BEFORE THE PARSE, and that ordering is the whole
  // point: viem's `parseUnits` does NOT throw on excess decimal places, it
  // SILENTLY TRUNCATES them, so `1.0000001` at 6 decimals becomes `1.000000`
  // and the caller is never told a digit of their amount was dropped. On a money
  // path that is a silent cut, and the answer is to refuse by name.
  const fractionDigits = partial.amountInHuman.includes(".")
    ? partial.amountInHuman.length - partial.amountInHuman.indexOf(".") - 1
    : 0;
  if (fractionDigits > decimals) {
    return {
      ok: false,
      reason:
        `Parameter "amountIn" has ${fractionDigits} decimal places and this token has ${decimals}. `
        + "Vex will not round or truncate an amount for you - restate it with at most "
        + `${decimals} decimal places.`,
    };
  }
  const amountInRaw = parseUnits(partial.amountInHuman, decimals);
  if (amountInRaw <= 0n) {
    return { ok: false, reason: `Parameter "amountIn" must be greater than zero (got "${partial.amountInHuman}").` };
  }
  return { ok: true, params: { ...partial, amountInRaw } };
}

/**
 * `acceptAntiSniperTaxPct` - consent to a MAXIMUM, not to a value.
 *
 * The legal range is 1..98 (owner decision). Zero is refused rather than read as
 * "no window": omitting the parameter already means that, and a caller who wrote
 * `0` was reaching for something the parameter cannot express. 99 is refused
 * because the router clamps the pair of taxes at 99, so accepting 99 on top of a
 * non-zero protocol tax is a bound the contract can never reach and would read
 * as "accept anything".
 */
function readAcceptAntiSniper(
  p: Record<string, unknown>,
): { readonly ok: true; readonly value: number | null } | { readonly ok: false; readonly reason: string } {
  const raw = p.acceptAntiSniperTaxPct;
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return {
      ok: false,
      reason: 'Parameter "acceptAntiSniperTaxPct" must be a whole percent, for example 40 to accept an anti-sniper tax of up to 40%.',
    };
  }
  if (raw < 1 || raw > 98) {
    return {
      ok: false,
      reason:
        `Parameter "acceptAntiSniperTaxPct" must be between 1 and 98 (got ${raw}). Omit it entirely to refuse any `
        + "anti-sniper tax, which is the default.",
    };
  }
  return { ok: true, value: raw };
}
