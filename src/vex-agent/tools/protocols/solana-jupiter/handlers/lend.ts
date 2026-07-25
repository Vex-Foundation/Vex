/**
 * Solana/Jupiter lending handlers.
 *
 * `solana.lend.deposit`/`solana.lend.withdraw` (W5 design `w5-design.md`
 * §3/R2b, migration 049) write their durable truth DIRECTLY to
 * `agent_activity` through the staged Solana seam (K2:
 * `prepareVersionedTx` + `markActivitySolanaBroadcast` +
 * `broadcastStagedSolanaTx`) instead of the legacy `_tradeCapture` pipeline —
 * `capture: "none"` in `mutation-matrix.ts`, the same flip already applied to
 * kyberswap/uniswap/khalani/relay. The Jupiter Lend Earn `/deposit` and
 * `/withdraw` endpoints return a TRANSACTION-ONLY response
 * (`{ transaction: string }` — no `blockhashWithMetadata`), so
 * `prepareVersionedTx` always runs in its REPLACE/MANDATORY-HEIGHT mode
 * (design REVISION 2 R2b) — one code path, no discriminated heightless
 * variant.
 *
 * Write sequence per mutation (design §2/R2, verbatim order):
 *   1. request the unsigned provider tx — a rejection here is a PRE-broadcast
 *      failure (nothing was ever recorded): `createAgentActivityPreBroadcastFailure`.
 *   2. `createAgentActivityIntent` — record BEFORE signing.
 *   3. `prepareVersionedTx` (sign-only, REPLACE mode) — a throw here is a
 *      POST-INTENT failure: `failActivityEvent` on the row already created,
 *      NEVER a second intent row.
 *   4. `markActivitySolanaBroadcast` — persist the signature + blockhash
 *      evidence BEFORE the submit call (CAS).
 *   5. `broadcastStagedSolanaTx` on the RPC lane — a Lend transaction is
 *      built by the Lend API and carries NO tip, so it cannot use Jupiter's
 *      `/tx/v1/submit` (which requires one and silently dropped these
 *      transactions on real funds before 2026-07-24); the type system now
 *      makes that lane unreachable from here. A signature mismatch or an
 *      ambiguous transport failure never terminalizes the row; it stays
 *      `pending` and the Solana sweep (K3) resolves it later via the
 *      canonical local signature.
 * The in-turn result is truthful-pending (`success:false`) for every outcome
 * where the bytes may be in flight — this handler never fabricates a confirm.
 * The ONE exception is a DEFINITIVE rejection (the node answered and refused
 * before broadcasting), which is reported as a rejection rather than as
 * pending, because nothing went on-chain. `solana.lend.positions`/
 * `solana.lend.rates` are unaffected reads.
 */

import { Keypair } from "@solana/web3.js";

import {
  getJupiterLendEarnTokens,
  getJupiterLendEarnPositions,
  getJupiterLendEarnEarnings,
  requestJupiterLendEarnDepositTransaction,
  requestJupiterLendEarnWithdrawTransaction,
} from "@tools/solana-ecosystem/jupiter/jupiter-lend/earn-api/service.js";
import { prepareVersionedTx, type PreparedSolanaTx } from "@tools/solana-ecosystem/shared/solana-transaction.js";
import { solanaExplorerUrl } from "@tools/solana-ecosystem/shared/solana-validation.js";
import {
  createAgentActivityIntent,
  createAgentActivityPreBroadcastFailure,
  markActivitySolanaBroadcast,
  failActivityEvent,
  type AgentActivityEventRole,
} from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../../constants/solana-chain.js";

import type { ProtocolHandler } from "../../types.js";
import type { ToolResult } from "../../../types.js";
import { str, strArray, num, ok, fail } from "../../handler-helpers.js";
import { walletAddress, walletSecret } from "./core.js";
import { walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { resolveActivityTokenLeg } from "../activity-token-leg.js";
import { classifyJupiterProviderFailure } from "../provider-failure-mapping.js";
import { broadcastStagedSolanaTx } from "../staged-broadcast.js";
import { projectJupiterLendRates } from "../lend-projector.js";
import logger from "@utils/logger.js";

const PROTOCOL = "jupiter";
const NAMESPACE = "solana";

/** The ONE entry point for provider-error text reaching an output/log/reason (scrub boundary). */
function lendFailureMessage(err: unknown): string {
  return summarizeProtocolError(err).message;
}

interface StagedLendMutationInput {
  readonly toolId: string;
  readonly eventRole: AgentActivityEventRole;
  /** Which leg the asset/amount occupies on the `agent_activity` row — `in` for a deposit, `out` for a withdraw. */
  readonly direction: "in" | "out";
  readonly actionLabel: string;
  readonly asset: string;
  readonly amount: string;
  readonly addr: string;
  readonly secret: Uint8Array;
  readonly sessionId: string;
  readonly params: Record<string, unknown>;
  readonly requestTx: () => Promise<{ transaction: string }>;
}

/**
 * The shared K2 staged-seam orchestration for a single Vex-signed Solana
 * lend mutation (deposit or withdraw) — see the module doc's numbered
 * write sequence.
 */
async function executeStagedLendMutation(input: StagedLendMutationInput): Promise<ToolResult> {
  // The leg's token metadata (symbol/decimals + the exact-decimal
  // `amountHuman`) is COSMETIC provenance owned by `../activity-token-leg.ts`
  // — it can never fail this mutation. Resolved CONCURRENTLY with the provider
  // request so it adds no latency to a funded call, and BEFORE the intent
  // write so the row carries it from creation (the repo stores `amountHuman`
  // verbatim and derives nothing, so a leg written without it stays null
  // forever). The provider request keeps its own rejection contract: it is
  // settled explicitly here, because awaiting the (never-rejecting) leg first
  // would otherwise leave a rejection momentarily unhandled.
  const [leg, requested] = await Promise.all([
    resolveActivityTokenLeg(input.asset, input.amount),
    input.requestTx().then(
      (raw) => ({ ok: true as const, raw }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);
  const sharedEventFields = {
    eventRole: input.eventRole,
    protocol: PROTOCOL,
    chainId: SOLANA_SYNTHETIC_CHAIN_ID,
    chainSlug: "solana",
    chainFamily: "solana" as const,
    walletAddress: input.addr,
    sessionId: input.sessionId,
    ...(input.direction === "in" ? { tokenIn: leg } : { tokenOut: leg }),
  };

  // 1. The unsigned provider tx was requested BEFORE anything was recorded —
  // a rejection is pre-broadcast (nothing to record was ever signed).
  if (!requested.ok) {
    // W4: classified on what the provider actually SAID. Filing every
    // rejection as `route_not_found` told an autonomous agent to hunt for a
    // route when the real answer was a balance, a size limit, or a closed
    // market. The same named reason goes to the row and to the agent.
    const { failureCode, failureReason } = classifyJupiterProviderFailure(requested.error);
    const { executionId } = await createAgentActivityPreBroadcastFailure({
      toolId: input.toolId,
      namespace: NAMESPACE,
      intentParams: input.params,
      event: {
        ...sharedEventFields,
        kind: "lend",
        eventIndex: 0,
        failureCode,
        failureReason,
      },
    });
    return { success: false, output: `${input.toolId} failed: ${failureReason}`, data: { _executionId: executionId } };
  }
  const raw = requested.raw;

  // 2. Record the intent BEFORE signing.
  const { executionId, events } = await createAgentActivityIntent({
    toolId: input.toolId,
    namespace: NAMESPACE,
    intentParams: input.params,
    events: [{ ...sharedEventFields, kind: "lend", eventIndex: 0 }],
  });
  const eventRow = events[0]!;

  // 3. Sign-only (REPLACE mode — Jupiter Lend Earn responses carry no
  // blockhash metadata to VERIFY against). A throw here is a POST-INTENT
  // failure: finalize the EXISTING row, never a second intent (design R2).
  let prepared: PreparedSolanaTx;
  try {
    const signer = Keypair.fromSecretKey(input.secret);
    prepared = await prepareVersionedTx(raw.transaction, signer);
  } catch (err) {
    const reason = lendFailureMessage(err);
    await failActivityEvent(eventRow.id, { failureCode: "unknown", failureReason: reason });
    return {
      success: false,
      output: `${input.toolId} failed: ${reason} — recorded (execution ${executionId}); nothing was broadcast.`,
      data: { _executionId: executionId },
    };
  }

  // 4. Persist signature + blockhash evidence BEFORE the submit call (CAS).
  const staged = await markActivitySolanaBroadcast(eventRow.id, {
    txHash: prepared.signature,
    fromAddress: input.addr,
    recentBlockhash: prepared.recentBlockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
  });
  if (!staged.applied) {
    logger.warn(`${input.toolId}.staging_cas_miss`, { executionId, eventId: eventRow.id });
    return {
      success: false,
      output: `${input.toolId}: an internal error left this ${input.actionLabel.toLowerCase()} unrecorded before broadcast — refusing to submit untracked. Check execution ${executionId}; do not retry blindly.`,
      data: { _executionId: executionId },
    };
  }

  // 5. Broadcast over RPC. A signature mismatch or an ambiguous transport
  // failure NEVER terminalizes the row here — the canonical local signature
  // stays; the Solana sweep (K3) resolves the row later.
  const broadcast = await broadcastStagedSolanaTx({
    toolId: input.toolId, rowId: eventRow.id, prepared, lane: { kind: "rpc" },
  });
  if (broadcast.kind === "rejected_before_broadcast") {
    // The node ANSWERED and refused (preflight/simulation): nothing went to
    // the network. Reporting this as "pending confirmation" would be a lie.
    // The row still stays pending — the sweep owns terminality (design D4).
    return {
      success: false,
      output: `${input.toolId}: this ${input.actionLabel.toLowerCase()} was rejected before broadcast — nothing went on-chain: ${broadcast.reason}. Recorded (execution ${executionId}); do not retry until the cause is fixed.`,
      data: {
        _executionId: executionId,
        status: "rejected_before_broadcast",
        reason: broadcast.reason,
      },
    };
  }

  return {
    success: false,
    output: `${input.actionLabel} broadcast (signature ${prepared.signature}) — confirmation pending, tracked automatically. Do not retry.`,
    data: {
      _executionId: executionId,
      status: "pending",
      signature: prepared.signature,
      explorerUrl: solanaExplorerUrl(prepared.signature),
      asset: input.asset,
      amount: input.amount,
    },
  };
}

// ── Handler map ──────────────────────────────────────────────────

export const LEND_HANDLERS: Record<string, ProtocolHandler> = {
  "solana.lend.rates": async (p) => ok(projectJupiterLendRates(await getJupiterLendEarnTokens(), {
    assets: strArray(p, "assets"),
    minSupplyRate: num(p, "minSupplyRate"),
    minTotalRate: num(p, "minTotalRate"),
  })),
  "solana.lend.positions": async (p, ctx) => {
    let addr: string;
    try {
      addr = walletAddress(p, ctx);
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    const positions = await getJupiterLendEarnPositions(addr);
    // /earn/earnings' `positions` param wants the Earn/vault position token
    // (`token.address`), not the underlying asset mint (`token.assetAddress`)
    // — confirmed by earn-api/JupiterLendEarnApi.md and the upstream OpenAPI
    // spec (developers.jup.ag/docs/openapi-spec/lend/lend.yaml).
    const posAddresses = positions.map(pos => pos.token.address).filter(Boolean);
    const earningsResult = posAddresses.length > 0
      ? await getJupiterLendEarnEarnings(addr, posAddresses)
      : null;
    return ok({ positions, earnings: earningsResult?.earnings ?? [] });
  },
  "solana.lend.deposit": async (p, ctx) => {
    const asset = str(p, "asset"), amount = str(p, "amount");
    if (!asset || !amount) return fail("Missing required: asset, amount");
    const sessionId = ctx.sessionId;
    if (!sessionId) return fail("solana.lend.deposit requires an active session.");
    // Resolve owner + signer BEFORE any provider call (5D-protocols p2) so a
    // session scope mismatch fails closed without an on-chain side effect.
    let addr: string, secret: Uint8Array;
    try {
      addr = walletAddress(p, ctx);
      secret = walletSecret(ctx);
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    return executeStagedLendMutation({
      toolId: "solana.lend.deposit",
      eventRole: "lend_deposit",
      direction: "in",
      actionLabel: "Deposit",
      asset, amount, addr, secret, sessionId, params: p,
      requestTx: () => requestJupiterLendEarnDepositTransaction({ asset, amount, signer: addr }),
    });
  },
  "solana.lend.withdraw": async (p, ctx) => {
    const asset = str(p, "asset"), amount = str(p, "amount");
    if (!asset || !amount) return fail("Missing required: asset, amount");
    const sessionId = ctx.sessionId;
    if (!sessionId) return fail("solana.lend.withdraw requires an active session.");
    let addr: string, secret: Uint8Array;
    try {
      addr = walletAddress(p, ctx);
      secret = walletSecret(ctx);
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    return executeStagedLendMutation({
      toolId: "solana.lend.withdraw",
      eventRole: "lend_withdraw",
      direction: "out",
      actionLabel: "Withdrawal",
      asset, amount, addr, secret, sessionId, params: p,
      requestTx: () => requestJupiterLendEarnWithdrawTransaction({ asset, amount, signer: addr }),
    });
  },
};
