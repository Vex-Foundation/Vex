/**
 * Strict input checks for the three Vex Inference tools.
 *
 * EVERY key is named. A key outside a tool's declared set is refused by name
 * rather than dropped, and the keys that could redirect funds (a destination,
 * a token, a chain, a sender other than the wallet scope, a fee receiver) get
 * their own sentence saying why they do not exist (rule 90): the destination
 * is the deposit address pinned in this build, the token is VEX and the chain
 * is Robinhood Chain (4663). A silent drop would hide an attempted redirect.
 */

import type { AgentDepositAmount } from "./host.js";

export type ParamCheck<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** Keys that would redirect or re-denominate a deposit. Refused BY NAME, never dropped. */
export const FORBIDDEN_DEPOSIT_KEYS: readonly string[] = [
  "to",
  "destination",
  "recipient",
  "depositAddress",
  "deposit_address",
  "receiver",
  "token",
  "tokenAddress",
  "asset",
  "chain",
  "chainId",
  "network",
  "from",
  "feeReceiver",
  "fee",
  "rate",
  "split",
];

const FORBIDDEN_SENTENCE =
  "Vex Inference deposits have no such parameter: the destination is the deposit address pinned in this "
  + "Vex build (checked against the Vex Inference backend before signing), the token is VEX (18 decimals) "
  + "and the chain is Robinhood Chain (4663). None of these can be set, redirected or changed by a tool call.";

function unknownKeys(params: Record<string, unknown>, allowed: readonly string[]): ParamCheck<null> {
  const forbidden = Object.keys(params).filter((key) => FORBIDDEN_DEPOSIT_KEYS.includes(key));
  if (forbidden.length > 0) {
    return { ok: false, message: `Refused: ${forbidden.map((key) => `\`${key}\``).join(", ")}. ${FORBIDDEN_SENTENCE} Nothing was prepared or sent.` };
  }
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `Refused: unknown parameter${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => `\`${key}\``).join(", ")}. This tool takes only ${allowed.map((key) => `\`${key}\``).join(", ")}. Nothing was read or sent.`,
    };
  }
  return { ok: true, value: null };
}

// ── status ───────────────────────────────────────────────────────────────

export const STATUS_DEFAULT_LIMIT = 10;
export const STATUS_MAX_LIMIT = 50;

export function checkStatusParams(params: Record<string, unknown>): ParamCheck<{ readonly limit: number; readonly cursor: string | null }> {
  const keys = unknownKeys(params, ["limit", "cursor"]);
  if (!keys.ok) return keys;
  let limit = STATUS_DEFAULT_LIMIT;
  if (params.limit !== undefined) {
    if (typeof params.limit !== "number" || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > STATUS_MAX_LIMIT) {
      return { ok: false, message: `Refused: \`limit\` must be a whole number from 1 to ${STATUS_MAX_LIMIT} (default ${STATUS_DEFAULT_LIMIT}); it is never clamped. Nothing was read.` };
    }
    limit = params.limit;
  }
  let cursor: string | null = null;
  if (params.cursor !== undefined) {
    if (typeof params.cursor !== "string" || params.cursor.length === 0 || params.cursor.length > 512) {
      return { ok: false, message: "Refused: `cursor` must be the exact `usage.nextCursor` string a previous call returned. Nothing was read." };
    }
    cursor = params.cursor;
  }
  return { ok: true, value: { limit, cursor } };
}

// ── deposit prepare ──────────────────────────────────────────────────────

const VEX_DECIMAL = /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,18})?$/;
const USD_DECIMAL = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function checkDepositPrepareParams(
  params: Record<string, unknown>,
): ParamCheck<{ readonly amount: AgentDepositAmount; readonly walletAddress: string | null }> {
  const keys = unknownKeys(params, ["amountIn", "denomination", "walletAddress"]);
  if (!keys.ok) return keys;
  const unit = params.denomination ?? "VEX";
  if (unit !== "VEX" && unit !== "USD") {
    return { ok: false, message: "Refused: `denomination` must be \"VEX\" (the default) or \"USD\". Nothing was prepared." };
  }
  const raw = params.amountIn;
  if (typeof raw !== "string") {
    return {
      ok: false,
      message: `Refused: \`amountIn\` must be a STRING decimal amount (for example "125.5"), never a number${raw === undefined ? ", and it is required" : ""}. Nothing was prepared.`,
    };
  }
  const pattern = unit === "VEX" ? VEX_DECIMAL : USD_DECIMAL;
  if (!pattern.test(raw)) {
    return {
      ok: false,
      message: unit === "VEX"
        ? "Refused: `amountIn` in VEX must be digits with at most one point and at most 18 decimals, without separators or an exponent. Nothing was prepared."
        : "Refused: `amountIn` in USD must be digits with at most one point and at most 6 decimals, without a currency sign, separators or an exponent. Nothing was prepared.",
    };
  }
  if (!/[1-9]/.test(raw)) return { ok: false, message: "Refused: `amountIn` must be above zero. Nothing was prepared." };
  let walletAddress: string | null = null;
  if (params.walletAddress !== undefined) {
    if (typeof params.walletAddress !== "string" || !EVM_ADDRESS.test(params.walletAddress)) {
      return { ok: false, message: "Refused: `walletAddress` must be a 0x-prefixed 20-byte EVM address of the wallet selected for this session. Nothing was prepared." };
    }
    walletAddress = params.walletAddress;
  }
  return { ok: true, value: { amount: { unit, value: raw }, walletAddress } };
}

// ── deposit confirm ──────────────────────────────────────────────────────

export const AGENT_DEPOSIT_INTENT_ID = /^vxdep-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function checkDepositConfirmParams(params: Record<string, unknown>): ParamCheck<{ readonly intentId: string }> {
  const keys = unknownKeys(params, ["intentId"]);
  if (!keys.ok) return keys;
  if (typeof params.intentId !== "string" || !AGENT_DEPOSIT_INTENT_ID.test(params.intentId)) {
    return { ok: false, message: "Refused: `intentId` must be the exact id VexInferenceDepositPrepare returned (it starts with `vxdep-`). Nothing was signed." };
  }
  return { ok: true, value: { intentId: params.intentId } };
}
