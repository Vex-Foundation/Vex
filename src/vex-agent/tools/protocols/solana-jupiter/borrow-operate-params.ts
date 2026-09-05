/**
 * Jupiter Lend Borrow `/operate` agent-param → signed-delta resolution
 * (Agent Scan Phase 3 Batch 5, card B1).
 *
 * The provider models the FULL Borrow lifecycle (create/deposit/withdraw/
 * borrow/repay) through ONE endpoint via the sign of two deltas
 * (`colAmount`, `debtAmount` - see `../../../../tools/solana-ecosystem/
 * jupiter/jupiter-lend/borrow-api/JupiterLendBorrowApi.md`). Exposing THAT
 * raw signed-delta shape directly as agent params would fail the cold-start
 * standard (an agent would have to know the MIN_I128 sentinel by heart to
 * withdraw everything) - this module owns the translation from six
 * intent-labeled, mutually-exclusive params
 * (depositAmountRaw/withdrawAmountRaw/withdrawAll for collateral,
 * borrowAmountRaw/repayAmountRaw/repayAll for debt) to the provider's signed
 * strings, shared verbatim by BOTH the mutation handler
 * (`handlers/lend-borrow.ts`) and the pre-approval risk-preview evaluator
 * (`borrow-risk-preview.ts`) so the two never drift.
 *
 * `agent_activity`'s `tokenIn`/`tokenOut` legs (one slot each, per-row -
 * same shape a swap uses) can record AT MOST one incoming and one outgoing
 * leg per operate call. The provider's docs' own combo matrix only
 * demonstrates one true two-leg combo ("Deposit + borrow": collateral IN +
 * debt OUT) - a same-direction combo (deposit+repay, or withdraw+borrow)
 * would need TWO "in" or TWO "out" slots, which the ledger cannot represent
 * faithfully. `resolveBorrowOperateRequest` REJECTS that combination with a
 * clear error (reject-not-clamp) rather than silently recording only one leg.
 */

import {
  JUPITER_LEND_BORROW_CLOSE_ALL_SENTINEL,
  JUPITER_LEND_BORROW_DEFAULT_MARKET,
  JUPITER_LEND_BORROW_MARKETS,
  JUPITER_LEND_BORROW_NEW_POSITION_ID,
  type JupiterLendBorrowMarket,
} from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/types.js";

import type { ToolResult } from "../../types.js";
import { str, num, bool, fail } from "../handler-helpers.js";

// ── Resolved shape ────────────────────────────────────────────────

/** One leg's effect on the position, direction relative to the WALLET (matches `AgentActivityLegInput`'s tokenIn=wallet-sends / tokenOut=wallet-receives convention). */
export interface BorrowOperateLeg {
  readonly direction: "in" | "out";
  /** Exact atomic-unit magnitude requested. `null` for a close-all sentinel (the true magnitude is provider-computed, unknown to us in advance). */
  readonly amountRaw: string | null;
  readonly closeAll: boolean;
}

export interface BorrowOperateResolvedRequest {
  readonly vaultId: number;
  readonly positionId: number;
  readonly market: JupiterLendBorrowMarket;
  /** Signed integer string (or the MIN_I128 sentinel) for the provider's `colAmount`. */
  readonly colAmount: string;
  /** Signed integer string (or the MIN_I128 sentinel) for the provider's `debtAmount`. */
  readonly debtAmount: string;
  readonly collateralLeg: BorrowOperateLeg | null;
  readonly debtLeg: BorrowOperateLeg | null;
}

export type BorrowOperateParamResolution =
  | { readonly ok: true; readonly request: BorrowOperateResolvedRequest }
  | { readonly ok: false; readonly result: ToolResult };

// ── Versioned intent-params effects payload ────────────────────────
//
// w5-design.md §1: "the /operate delta shape lives in intent_params, not in
// the role vocabulary" - `lend_borrow_operate` is ONE role covering many
// distinct delta shapes (deposit/withdraw/borrow/repay/combos/close-alls),
// so the intent-params record - not a new role per shape - is the durable,
// audit-facing description of what a specific call actually did. `effects`
// is deliberately a NORMALIZED array (one entry per touched leg, never the
// raw provider-signed strings) so a future consumer (K7's feed, an
// operator, a migration) can read "collateral in 30000000" without having
// to reverse-engineer which of the six raw agent params were set or decode
// a signed-delta string. `effectsVersion` is bumped on any breaking shape
// change; existing rows keep their own persisted version forever.

export const BORROW_OPERATE_EFFECTS_VERSION = 1;

export interface BorrowOperateEffect {
  readonly leg: "collateral" | "debt";
  readonly direction: "in" | "out";
  /** `null` for a close-all sentinel - see `BorrowOperateLeg.amountRaw`. */
  readonly amountRaw: string | null;
  readonly closeAll: boolean;
}

/**
 * A `type` alias, deliberately NOT an `interface`. TypeScript gives an object
 * type alias an implicit index signature but withholds one from an interface,
 * so this shape is assignable to the `Record<string, unknown>` that the
 * `intentParams` boundary takes - without the `as unknown as` cast the call
 * site used to need. Same fields, same strictness, one fewer escape hatch on a
 * money path.
 */
export type BorrowOperateIntentParams = {
  readonly effectsVersion: typeof BORROW_OPERATE_EFFECTS_VERSION;
  readonly vaultId: number;
  readonly positionId: number;
  readonly market: JupiterLendBorrowMarket;
  readonly effects: readonly BorrowOperateEffect[];
};

function toEffect(leg: BorrowOperateLeg, kind: BorrowOperateEffect["leg"]): BorrowOperateEffect {
  return { leg: kind, direction: leg.direction, amountRaw: leg.amountRaw, closeAll: leg.closeAll };
}

/**
 * The strict, versioned `intent_params` payload for a resolved
 * `/operate` request - the durable record of "what this call actually did"
 * (see the module note above). Used for BOTH the intent-creation and the
 * pre-broadcast-failure recording call, so a rejected request's audit trail
 * shows the SAME normalized shape a succeeded one would have recorded.
 */
export function buildBorrowOperateIntentParams(
  resolved: BorrowOperateResolvedRequest,
): BorrowOperateIntentParams {
  const effects: BorrowOperateEffect[] = [];
  if (resolved.collateralLeg) effects.push(toEffect(resolved.collateralLeg, "collateral"));
  if (resolved.debtLeg) effects.push(toEffect(resolved.debtLeg, "debt"));
  return {
    effectsVersion: BORROW_OPERATE_EFFECTS_VERSION,
    vaultId: resolved.vaultId,
    positionId: resolved.positionId,
    market: resolved.market,
    effects,
  };
}

// ── Amount validation ──────────────────────────────────────────────

function assertPositiveIntegerAmount(name: string, value: string): bigint | ToolResult {
  if (!/^\d+$/.test(value)) {
    return fail(`Invalid ${name}: ${value}. ${name} must be a base-10 integer string in smallest units.`);
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) {
    return fail(`Invalid ${name}: ${value}. ${name} must be greater than 0.`);
  }
  return parsed;
}

// ── One leg (collateral or debt) ───────────────────────────────────
//
// The delta's SIGN (which param produces a positive vs. negative provider
// delta) and its WALLET-relative DIRECTION (in = wallet sends, out = wallet
// receives - `AgentActivityLegInput`'s tokenIn/tokenOut convention) are two
// INDEPENDENT axes that happen to align for collateral (deposit > 0 = in;
// withdraw < 0 = out) but INVERT for debt (borrow > 0 = OUT - the wallet
// RECEIVES the borrowed token; repay < 0 = IN - the wallet SENDS the
// repayment). Each param name is paired explicitly with its own direction
// below rather than assumed from a generic "in/out" naming.

interface LegParamNames {
  /** Param that produces a POSITIVE provider delta (depositAmountRaw | borrowAmountRaw). */
  readonly positiveName: string;
  readonly positiveDirection: "in" | "out";
  /** Param that produces a NEGATIVE provider delta (withdrawAmountRaw | repayAmountRaw). */
  readonly negativeName: string;
  readonly negativeDirection: "in" | "out";
  /** Boolean sentinel param (withdrawAll | repayAll) - always the MOST NEGATIVE delta, so shares `negativeDirection`. */
  readonly closeAllName: string;
}

type LegResolution =
  | { readonly ok: true; readonly leg: BorrowOperateLeg | null; readonly signedAmount: string }
  | { readonly ok: false; readonly result: ToolResult };

function resolveLeg(p: Record<string, unknown>, names: LegParamNames): LegResolution {
  const positiveRaw = str(p, names.positiveName);
  const negativeRaw = str(p, names.negativeName);
  const closeAll = bool(p, names.closeAllName) ?? false;

  const provided = [positiveRaw ? 1 : 0, negativeRaw ? 1 : 0, closeAll ? 1 : 0].reduce((a, b) => a + b, 0);
  if (provided > 1) {
    return {
      ok: false,
      result: fail(`Provide at most one of ${names.positiveName}, ${names.negativeName}, ${names.closeAllName}.`),
    };
  }
  if (closeAll) {
    // MIN_I128 on either field means "close that leg entirely" (repay all
    // debt incl. dust / withdraw all collateral) - same sentinel value
    // either way; only the FIELD it is assigned to differs.
    return {
      ok: true,
      leg: { direction: names.negativeDirection, amountRaw: null, closeAll: true },
      signedAmount: JUPITER_LEND_BORROW_CLOSE_ALL_SENTINEL,
    };
  }
  if (positiveRaw) {
    const parsed = assertPositiveIntegerAmount(names.positiveName, positiveRaw);
    if (typeof parsed !== "bigint") return { ok: false, result: parsed };
    return {
      ok: true,
      leg: { direction: names.positiveDirection, amountRaw: positiveRaw, closeAll: false },
      signedAmount: parsed.toString(),
    };
  }
  if (negativeRaw) {
    const parsed = assertPositiveIntegerAmount(names.negativeName, negativeRaw);
    if (typeof parsed !== "bigint") return { ok: false, result: parsed };
    return {
      ok: true,
      leg: { direction: names.negativeDirection, amountRaw: negativeRaw, closeAll: false },
      signedAmount: (-parsed).toString(),
    };
  }
  return { ok: true, leg: null, signedAmount: "0" };
}

// ── Public resolver ─────────────────────────────────────────────

/**
 * Resolve the six intent-labeled params into the provider's `colAmount`/
 * `debtAmount` signed strings + `vaultId`/`positionId`/`market`. Shared by
 * the `solana.lend.borrowOperate` handler and the pre-approval risk-preview
 * evaluator - the ONE place this translation happens.
 */
export function resolveBorrowOperateRequest(p: Record<string, unknown>): BorrowOperateParamResolution {
  const vaultId = num(p, "vaultId");
  if (vaultId == null || !Number.isInteger(vaultId) || vaultId < 0) {
    return { ok: false, result: fail("Missing or invalid required parameter: vaultId (non-negative integer).") };
  }
  const positionIdRaw = num(p, "positionId");
  const positionId = positionIdRaw ?? JUPITER_LEND_BORROW_NEW_POSITION_ID;
  if (!Number.isInteger(positionId) || positionId < 0) {
    return { ok: false, result: fail("Invalid positionId: must be a non-negative integer (0 creates a new position).") };
  }
  const marketRaw = str(p, "market");
  const market = marketRaw || JUPITER_LEND_BORROW_DEFAULT_MARKET;
  if (!(JUPITER_LEND_BORROW_MARKETS as readonly string[]).includes(market)) {
    return {
      ok: false,
      result: fail(`Unknown market "${market}". Valid markets: ${JUPITER_LEND_BORROW_MARKETS.join(", ")}.`),
    };
  }

  // Collateral: deposit (colAmount > 0) = wallet sends = "in"; withdraw
  // (colAmount < 0) = wallet receives = "out".
  const collateral = resolveLeg(p, {
    positiveName: "depositAmountRaw",
    positiveDirection: "in",
    negativeName: "withdrawAmountRaw",
    negativeDirection: "out",
    closeAllName: "withdrawAll",
  });
  if (!collateral.ok) return collateral;
  // Debt: borrow (debtAmount > 0) = wallet RECEIVES the borrowed token =
  // "out"; repay (debtAmount < 0) = wallet SENDS the repayment = "in" - the
  // INVERSE of collateral's sign↔direction pairing (see the module doc above
  // `resolveLeg`).
  const debt = resolveLeg(p, {
    positiveName: "borrowAmountRaw",
    positiveDirection: "out",
    negativeName: "repayAmountRaw",
    negativeDirection: "in",
    closeAllName: "repayAll",
  });
  if (!debt.ok) return debt;

  if (collateral.leg === null && debt.leg === null) {
    return {
      ok: false,
      result: fail(
        "Nothing to do - provide at least one of depositAmountRaw, withdrawAmountRaw, withdrawAll, "
        + "borrowAmountRaw, repayAmountRaw, repayAll.",
      ),
    };
  }
  if (collateral.leg !== null && debt.leg !== null && collateral.leg.direction === debt.leg.direction) {
    return {
      ok: false,
      result: fail(
        `Cannot combine a collateral ${collateral.leg.direction === "in" ? "deposit" : "withdrawal"} with a debt `
        + `${debt.leg.direction === "in" ? "repayment" : "borrow"} in one call - both would move in the same `
        + "direction and the activity ledger records at most one incoming and one outgoing leg per call. "
        + "Call these as two separate solana__lend_borrow_operate calls.",
      ),
    };
  }

  return {
    ok: true,
    request: {
      vaultId,
      positionId,
      market: market as JupiterLendBorrowMarket,
      colAmount: collateral.signedAmount,
      debtAmount: debt.signedAmount,
      collateralLeg: collateral.leg,
      debtLeg: debt.leg,
    },
  };
}
