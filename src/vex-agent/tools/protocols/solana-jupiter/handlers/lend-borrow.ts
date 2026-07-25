/**
 * Solana/Jupiter Lend BORROW handlers (Agent Scan Phase 3 Batch 5, card B1).
 *
 * Separate file from `./lend.ts` (Earn) — a distinct program family with its
 * own vault/position/operate vocabulary; see `w5-design.md` §3
 * (`lend_borrow_operate` role) and the owner decisions in the B1 build-factory
 * card (full lifecycle via `/operate`, `/operate-instructions` excluded).
 *
 * `solana.lend.borrowOperate` follows the EXACT same K2 staged-seam write
 * sequence as `./lend.ts`'s `executeStagedLendMutation` (request → intent →
 * sign → persist → submit); the Borrow-specific parts are: (1) agent params
 * resolve to signed `colAmount`/`debtAmount` deltas via
 * `../borrow-operate-params.ts` (shared with the pre-approval risk-preview
 * evaluator, `../borrow-risk-preview.ts`); (2) the vault's `supplyToken`/
 * `borrowToken` must be read first to label the `agent_activity` tokenIn/
 * tokenOut legs (Borrow's `/operate` request carries no token identity of
 * its own — only `vaultId`); (3) the response carries `nftId` (the position,
 * newly assigned when creating), surfaced in the pending output.
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

import {
  getJupiterLendBorrowPositions,
  getJupiterLendBorrowVaults,
  requestJupiterLendBorrowOperateTransaction,
} from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/service.js";
import { getSolanaConnection, prepareVersionedTx, type PreparedSolanaTx } from "@tools/solana-ecosystem/shared/solana-transaction.js";
import {
  deriveAssociatedTokenAccount,
  resolveMintTokenProgramId,
} from "@tools/solana-ecosystem/shared/solana-token-program.js";
import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import { solanaExplorerUrl } from "@tools/solana-ecosystem/shared/solana-validation.js";
import {
  createAgentActivityIntent,
  createAgentActivityPreBroadcastFailure,
  markActivitySolanaBroadcast,
  failActivityEvent,
  type AgentActivityLegInput,
} from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../../constants/solana-chain.js";

import type { ProtocolHandler } from "../../types.js";
import type { ToolResult } from "../../../types.js";
import { strArray, str, ok, fail } from "../../handler-helpers.js";
import { walletAddress, walletSecret } from "./core.js";
import { walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import {
  projectJupiterLendBorrowPositions,
  projectJupiterLendBorrowVaults,
} from "../borrow-projector.js";
import {
  resolveBorrowOperateRequest,
  buildBorrowOperateIntentParams,
  type BorrowOperateLeg,
} from "../borrow-operate-params.js";
import { validateJupiterLendBorrowMarket } from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/validation.js";
import type {
  JupiterLendBorrowToken,
  JupiterLendBorrowVault,
} from "@tools/solana-ecosystem/jupiter/jupiter-lend/borrow-api/types.js";
import { buildActivityTokenLeg } from "../activity-token-leg.js";
import { broadcastStagedSolanaTx } from "../staged-broadcast.js";
import logger from "@utils/logger.js";

const PROTOCOL = "jupiter";
const NAMESPACE = "solana";

/** The ONE entry point for provider-error text reaching an output/log/reason (scrub boundary — mirrors ./lend.ts). */
function borrowFailureMessage(err: unknown): string {
  return summarizeProtocolError(err).message;
}

/**
 * `undefined` when the leg is untouched. A close-all sentinel carries no
 * `amountRaw` (magnitude is provider-computed, unknown to us in advance) and
 * therefore no `amountHuman` either — but the vault's OWN token descriptor
 * still labels the leg with symbol/decimals, so the agent reading its activity
 * feed never sees a bare mint string. That descriptor was already fetched to
 * resolve the vault (`/operate` carries no token identity of its own), so this
 * costs no extra provider call on a funded path.
 */
function legToActivityInput(
  leg: BorrowOperateLeg | null,
  token: JupiterLendBorrowToken,
): AgentActivityLegInput | undefined {
  if (!leg) return undefined;
  return buildActivityTokenLeg({
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
    ...(leg.amountRaw !== null ? { amountRaw: leg.amountRaw } : {}),
  });
}

/**
 * Map the resolved collateral/debt legs onto `agent_activity`'s single
 * tokenIn (wallet sends)/tokenOut (wallet receives) slots. `resolveBorrowOperateRequest`
 * already guarantees at most one leg is "in" and at most one is "out", so
 * this assignment can never collide.
 */
function resolveActivityLegs(
  collateralLeg: BorrowOperateLeg | null,
  debtLeg: BorrowOperateLeg | null,
  supplyToken: JupiterLendBorrowToken,
  borrowToken: JupiterLendBorrowToken,
): { tokenIn: AgentActivityLegInput | undefined; tokenOut: AgentActivityLegInput | undefined } {
  const legs: { tokenIn?: AgentActivityLegInput; tokenOut?: AgentActivityLegInput } = {};
  if (collateralLeg) {
    const key = collateralLeg.direction === "in" ? "tokenIn" : "tokenOut";
    legs[key] = legToActivityInput(collateralLeg, supplyToken);
  }
  if (debtLeg) {
    const key = debtLeg.direction === "in" ? "tokenIn" : "tokenOut";
    legs[key] = legToActivityInput(debtLeg, borrowToken);
  }
  return { tokenIn: legs.tokenIn, tokenOut: legs.tokenOut };
}

/**
 * Jupiter Lend Borrow's `/operate` never wraps/unwraps native SOL (verified
 * live, quoted verbatim: "The API does not wrap or unwrap native SOL" —
 * `developers.jup.ag/docs/lend/borrow/api`, card B3). A leg that PULLS a
 * token FROM the wallet (deposit collateral, repay debt) needs an
 * ALREADY-WRAPPED balance sitting in the wallet's WSOL associated token
 * account when that leg's token is the canonical WSOL mint — native SOL
 * alone is not enough, and the on-chain tx would otherwise fail opaquely
 * after a broadcast. Checked BEFORE requesting the unsigned tx (pre-
 * broadcast, no activity row — same category as the vault-not-found /
 * invalid-combo checks below). Returns a clear, actionable failure message,
 * or `null` when the leg is fine (not an "in" leg, not WSOL-denominated, or
 * sufficiently funded).
 */
async function checkWsolFunding(
  leg: BorrowOperateLeg | null,
  tokenAddress: string,
  walletAddr: string,
): Promise<string | null> {
  if (!leg || leg.direction !== "in" || tokenAddress !== SOL_MINT) return null;

  const connection = getSolanaConnection();
  const owner = new PublicKey(walletAddr);
  const mintPubkey = new PublicKey(tokenAddress);

  let balanceRaw = 0n;
  try {
    const tokenProgramId = await resolveMintTokenProgramId(connection, tokenAddress);
    const ata = deriveAssociatedTokenAccount(owner, mintPubkey, tokenProgramId);
    balanceRaw = (await getAccount(connection, ata)).amount;
  } catch {
    balanceRaw = 0n; // no WSOL token account found — treated as zero balance
  }

  // A close-all sentinel's exact required amount is provider-computed
  // (unknown to us in advance) — require SOME wrapped balance to exist
  // rather than a specific amount.
  const sufficient = leg.amountRaw !== null ? balanceRaw >= BigInt(leg.amountRaw) : balanceRaw > 0n;
  if (sufficient) return null;

  const need = leg.amountRaw ?? "some";
  return `this operation needs ${need} raw units of WRAPPED SOL (WSOL) already in your wallet's WSOL token `
    + `account (found ${balanceRaw.toString()}) — Jupiter Lend Borrow's /operate endpoint never wraps native SOL `
    + "for you. Wrap SOL into WSOL first, then retry.";
}

export const LEND_BORROW_HANDLERS: Record<string, ProtocolHandler> = {
  "solana.lend.borrowVaults": async (p) => {
    let market;
    try {
      market = validateJupiterLendBorrowMarket(str(p, "market") || undefined);
    } catch (err) {
      return fail(borrowFailureMessage(err));
    }
    const vaultIds = strArray(p, "vaultIds");
    const vaults = await getJupiterLendBorrowVaults(market);
    return ok(projectJupiterLendBorrowVaults(vaults, { vaultIds }));
  },

  "solana.lend.borrowPositions": async (p, ctx) => {
    let addr: string;
    try {
      addr = walletAddress(p, ctx);
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    let market;
    try {
      market = validateJupiterLendBorrowMarket(str(p, "market") || undefined);
    } catch (err) {
      return fail(borrowFailureMessage(err));
    }
    const vaultIds = strArray(p, "vaultIds");
    const positions = await getJupiterLendBorrowPositions(addr, market);
    return ok(projectJupiterLendBorrowPositions(positions, { vaultIds }));
  },

  "solana.lend.borrowOperate": async (p, ctx): Promise<ToolResult> => {
    const toolId = "solana.lend.borrowOperate";
    const resolution = resolveBorrowOperateRequest(p);
    if (!resolution.ok) return resolution.result;
    const resolved = resolution.request;

    const sessionId = ctx.sessionId;
    if (!sessionId) return fail(`${toolId} requires an active session.`);

    // Resolve owner + signer BEFORE any provider call (5D-protocols p2) so a
    // session scope mismatch fails closed without an on-chain side effect.
    let addr: string, secret: Uint8Array;
    try {
      addr = walletAddress(p, ctx);
      secret = walletSecret(ctx);
    } catch (err) {
      return walletScopeErrorToResult(err);
    }

    // The vault's own supplyToken/borrowToken label the agent_activity legs —
    // `/operate` carries no token identity of its own, only `vaultId`. A
    // local-list miss is a client-side validation failure (never reached the
    // provider), same category as the missing-param checks above — no
    // activity row (mirrors `resolveBorrowOperateRequest`'s own rejections).
    let vault: JupiterLendBorrowVault | undefined;
    try {
      const vaults = await getJupiterLendBorrowVaults(resolved.market);
      vault = vaults.find((v) => v.id === resolved.vaultId);
    } catch (err) {
      return fail(`${toolId} failed: ${borrowFailureMessage(err)}`);
    }
    if (!vault) {
      return fail(`${toolId}: vault ${resolved.vaultId} not found in the ${resolved.market} market.`);
    }

    // Native-SOL/WSOL pre-broadcast check (card B3) — a client-side check,
    // no activity row, same category as the vault-not-found check above.
    const wsolFailure =
      (await checkWsolFunding(resolved.collateralLeg, vault.supplyToken.address, addr))
      ?? (await checkWsolFunding(resolved.debtLeg, vault.borrowToken.address, addr));
    if (wsolFailure) {
      return fail(`${toolId}: ${wsolFailure}`);
    }

    const { tokenIn, tokenOut } = resolveActivityLegs(
      resolved.collateralLeg, resolved.debtLeg, vault.supplyToken, vault.borrowToken,
    );
    // w5-design.md §1: "the /operate delta shape lives in intent_params, not
    // in the role vocabulary" — a strict, versioned, normalized record (NOT
    // the raw agent params) of which legs moved which way. Recorded on BOTH
    // the pre-broadcast-failure path and the intent-creation path, so a
    // rejected call's audit trail carries the SAME shape a succeeded one would.
    // Cast is structural-only (mirrors `handler-helpers.ts`'s `toResultData`
    // rationale): `BorrowOperateIntentParams` has no index signature, but
    // every field is a plain JSON-safe value the `intentParams` boundary
    // accepts and sanitizes generically (`createExecutionIntent`).
    const intentParams = buildBorrowOperateIntentParams(resolved) as unknown as Record<string, unknown>;
    const sharedEventFields = {
      eventRole: "lend_borrow_operate" as const,
      protocol: PROTOCOL,
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      chainSlug: "solana",
      chainFamily: "solana" as const,
      walletAddress: addr,
      sessionId,
      tokenIn,
      tokenOut,
    };

    // 1. Request the unsigned provider tx BEFORE recording anything — a
    // rejection here is pre-broadcast (nothing to record was ever signed).
    let raw: { nftId: number; transaction: string };
    try {
      raw = await requestJupiterLendBorrowOperateTransaction(
        {
          vaultId: resolved.vaultId,
          positionId: resolved.positionId,
          signer: addr,
          colAmount: resolved.colAmount,
          debtAmount: resolved.debtAmount,
        },
        resolved.market,
      );
    } catch (err) {
      const reason = borrowFailureMessage(err);
      const { executionId } = await createAgentActivityPreBroadcastFailure({
        toolId,
        namespace: NAMESPACE,
        intentParams,
        event: {
          ...sharedEventFields,
          kind: "lend",
          eventIndex: 0,
          failureCode: "route_not_found",
          failureReason: reason,
        },
      });
      return { success: false, output: `${toolId} failed: ${reason}`, data: { _executionId: executionId } };
    }

    // 2. Record the intent BEFORE signing.
    const { executionId, events } = await createAgentActivityIntent({
      toolId,
      namespace: NAMESPACE,
      intentParams,
      events: [{ ...sharedEventFields, kind: "lend", eventIndex: 0 }],
    });
    const eventRow = events[0]!;

    // 3. Sign-only (REPLACE mode — Jupiter Lend Borrow's `/operate` response
    // carries no blockhash metadata to VERIFY against, same as Earn). A throw
    // here is a POST-INTENT failure: finalize the EXISTING row, never a
    // second intent (design R2).
    let prepared: PreparedSolanaTx;
    try {
      const signer = Keypair.fromSecretKey(secret);
      prepared = await prepareVersionedTx(raw.transaction, signer);
    } catch (err) {
      const reason = borrowFailureMessage(err);
      await failActivityEvent(eventRow.id, { failureCode: "unknown", failureReason: reason });
      return {
        success: false,
        output: `${toolId} failed: ${reason} — recorded (execution ${executionId}); nothing was broadcast.`,
        data: { _executionId: executionId },
      };
    }

    // 4. Persist signature + blockhash evidence BEFORE the submit call (CAS).
    const staged = await markActivitySolanaBroadcast(eventRow.id, {
      txHash: prepared.signature,
      fromAddress: addr,
      recentBlockhash: prepared.recentBlockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
    if (!staged.applied) {
      logger.warn(`${toolId}.staging_cas_miss`, { executionId, eventId: eventRow.id });
      return {
        success: false,
        output: `${toolId}: an internal error left this operation unrecorded before broadcast — refusing to submit untracked. Check execution ${executionId}; do not retry blindly.`,
        data: { _executionId: executionId },
      };
    }

    // 5. Broadcast over RPC — Borrow's `/operate` returns an opaque, TIPLESS
    // provider transaction, so Jupiter's tip-gated `/tx/v1/submit` (which
    // silently dropped these before 2026-07-24) is not reachable from here.
    // A signature mismatch or an ambiguous transport failure NEVER
    // terminalizes the row; the canonical local signature stays and the
    // Solana sweep (K3) resolves the row later.
    const broadcast = await broadcastStagedSolanaTx({
      toolId, rowId: eventRow.id, prepared, lane: { kind: "rpc" },
    });
    if (broadcast.kind === "rejected_before_broadcast") {
      // The node ANSWERED and refused: nothing went on-chain. Reporting this
      // as "pending confirmation" would be a lie. The row still stays pending
      // — the sweep owns terminality (design D4).
      return {
        success: false,
        output: `${toolId}: this operation was rejected before broadcast — nothing went on-chain: ${broadcast.reason}. Recorded (execution ${executionId}); do not retry until the cause is fixed.`,
        data: {
          _executionId: executionId,
          status: "rejected_before_broadcast",
          reason: broadcast.reason,
        },
      };
    }

    return {
      success: false,
      output: `Borrow operate broadcast (signature ${prepared.signature}, position ${raw.nftId}) — confirmation pending, tracked automatically. Do not retry.`,
      data: {
        _executionId: executionId,
        status: "pending",
        signature: prepared.signature,
        explorerUrl: solanaExplorerUrl(prepared.signature),
        positionId: raw.nftId,
        vaultId: resolved.vaultId,
        market: resolved.market,
      },
    };
  },
};
