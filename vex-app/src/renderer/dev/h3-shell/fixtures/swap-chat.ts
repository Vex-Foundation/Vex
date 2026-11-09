/**
 * THE SWAP CHAT - one conversation followed from the ask to the receipt, so
 * the thinking, swap-waiting and filled states are three moments of the same
 * chat rather than three unrelated screens.
 *
 *   history   18 minutes ago: "What's in my main wallet on Base?", a
 *             balances read (812 ms) and Vex's answer.
 *   thinking  the ask, "Swap 200 USDC to ETH on Base.", 3 s ago; the run
 *             holds its lease and the turn is reasoning (`states/thinking.ts`
 *             streams it).
 *   waiting   the ask 42 s ago, a KyberSwap quote (1.43 s), and the execute
 *             call parked on a pending approval for 200 USDC to ETH on Base,
 *             enqueued 21 s ago.
 *   filled    the same approval approved, the execute call settled (6.21 s)
 *             with its Base transaction, and Vex's closing line.
 *
 * Every row is a `SessionMessageDto` as `messages.list` returns it (oldest
 * first inside a page, `messages-db.ts`), and the approval is the
 * `ApprovalSummaryDto` the engine's preview builder writes
 * (`approval-intent-preview.ts`): `execute_tool` wrapping
 * `kyberswap.swap.execute`, the bound quote line in the engine's own
 * `kyber-quote-v1` grammar, the Vex fee in `describeBoundVexFee`'s. The
 * figures are plausible and invented: 200 USDC quoted at 0.05714 ETH, a
 * 50 bps floor, a 0.25% fee. The transaction hash is a fixture
 * (`0x4833...`), not a Base transaction.
 */

import type { ApprovalPendingGlobalDto, ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import type { MessagePage, SessionMessageDto } from "@shared/schemas/messages.js";
import type { RuntimeStateDto } from "@shared/schemas/runtime.js";
import { ok, type BridgeAnswers } from "../bridge.js";
import { isoAt, MINUTE } from "../clock.js";
import { fixture } from "../mark.js";
import { EVM_WALLET, MODEL } from "./base.js";
import { SWAP_CHAT } from "./sessions.js";

export type SwapStage = "thinking" | "waiting" | "filled";

const SECOND = 1_000;

function message(
  id: number,
  agoMs: number,
  role: SessionMessageDto["role"],
  kind: SessionMessageDto["kind"],
  content: string,
  extra: Partial<SessionMessageDto> = {},
): SessionMessageDto {
  return {
    id,
    sessionId: SWAP_CHAT.id,
    role,
    kind,
    content,
    createdAt: isoAt(-agoMs),
    toolCallId: null,
    toolName: null,
    toolCalls: null,
    explorerRefs: null,
    reasoning: null,
    durationMs: null,
    success: null,
    displayStatus: null,
    board: null,
    interruptDisposition: null,
    ...extra,
  };
}

const json = (value: unknown): string => JSON.stringify(value);

/** When the ask was sent, per stage: a live turn is seconds old, a receipt minutes. */
const ASK_AGO: Record<SwapStage, number> = {
  thinking: 3 * SECOND,
  waiting: 42 * SECOND,
  filled: 2 * MINUTE + 10 * SECOND,
};

const SWAP_PARAMS = { chain: "base", tokenIn: "USDC", tokenOut: "ETH", amountIn: "200", slippageBps: 50 };
const TX_HASH = `0x4833${"0".repeat(56)}f11d`;
const QUOTE_DIGEST = `4833${"ab".repeat(30)}`;

function history(): SessionMessageDto[] {
  return [
    message(101, 18 * MINUTE, "user", "text", "What's in my main wallet on Base?"),
    message(102, 18 * MINUTE - 4 * SECOND, "assistant", "tool_call", "", {
      reasoning: "Read the balances of the main EVM wallet on Base before answering.",
      toolCalls: [{ toolCallId: "call_h3_balances", toolName: "wallet_balances", toolArgs: json({ chain: "base" }) }],
    }),
    message(103, 18 * MINUTE - 5 * SECOND, "tool", "tool_result", json({
      chain: "base",
      wallet: EVM_WALLET.address,
      balances: [
        { symbol: "USDC", amount: "1240.50", usd: "1240.50" },
        { symbol: "ETH", amount: "0.1832", usd: "640.35" },
      ],
    }), { toolCallId: "call_h3_balances", toolName: "wallet_balances", durationMs: 812, success: true }),
    message(104, 18 * MINUTE - 9 * SECOND, "assistant", "text",
      "Your main wallet on Base holds **1,240.50 USDC** and **0.1832 ETH** (about $640). Nothing else on Base."),
  ];
}

function transcript(stage: SwapStage): SessionMessageDto[] {
  const ask = ASK_AGO[stage];
  const rows = [...history(), message(105, ask, "user", "text", "Swap 200 USDC to ETH on Base.")];
  if (stage === "thinking") return rows;
  rows.push(
    message(106, ask - 6 * SECOND, "assistant", "tool_call", "", {
      reasoning: "Quote 200 USDC to ETH on Base and compare routes before preparing anything.",
      toolCalls: [{
        toolCallId: "call_h3_quote",
        toolName: "execute_tool",
        toolArgs: json({ toolId: "kyberswap.swap.quote", params: SWAP_PARAMS }),
      }],
    }),
    message(107, ask - 8 * SECOND, "tool", "tool_result", json({
      tokenIn: "USDC",
      tokenOut: "ETH",
      amountIn: "200",
      amountOut: "0.05714",
      minAmountOut: "0.05686",
      route: "KyberSwap aggregator, 2 hops",
    }), { toolCallId: "call_h3_quote", toolName: "execute_tool", durationMs: 1_430, success: true }),
    message(108, ask - 21 * SECOND, "assistant", "tool_call",
      "Best route is KyberSwap: about **0.05714 ETH** for 200 USDC, never less than 0.05686 ETH. The swap is ready for you to check.", {
        toolCalls: [{
          toolCallId: "call_h3_swap",
          toolName: "execute_tool",
          toolArgs: json({ toolId: "kyberswap.swap.execute", params: SWAP_PARAMS }),
        }],
      }),
  );
  if (stage === "waiting") return rows;
  rows.push(
    message(109, 62 * SECOND, "tool", "tool_result", json({
      status: "confirmed",
      txHash: TX_HASH,
      tokenIn: "USDC",
      tokenOut: "ETH",
      amountIn: "200",
      amountOut: "0.05709",
    }), {
      toolCallId: "call_h3_swap",
      toolName: "execute_tool",
      durationMs: 6_210,
      success: true,
      explorerRefs: [{ chain: "base", txRef: TX_HASH }],
    }),
    message(110, 55 * SECOND, "assistant", "text",
      "Done. Swapped **200 USDC** for **0.05709 ETH** on Base. Your main wallet now holds 1,040.50 USDC and 0.2403 ETH."),
  );
  return rows;
}

/** The swap the waiting card asks about, as the engine enqueues it. */
function swapApproval(stage: SwapStage): ApprovalSummaryDto {
  const ask = ASK_AGO[stage];
  const approved = stage === "filled";
  return {
    id: "h3-fixture-approval-swap",
    sessionId: SWAP_CHAT.id,
    toolCallId: "call_h3_swap",
    toolName: "execute_tool",
    status: approved ? "approved" : "pending",
    permissionAtEnqueue: "restricted",
    createdAt: isoAt(-(ask - 21 * SECOND)),
    resolvedAt: approved ? isoAt(-70 * SECOND) : null,
    reasoningPreview: "Swap 200 USDC for ETH on Base through KyberSwap, the best of the quoted routes.",
    actionKind: "user_wallet_broadcast",
    riskLevel: "high",
    preview: {
      toolName: "swap.execute",
      namespace: "kyberswap",
      criticalArgs: {
        toolId: "kyberswap.swap.execute",
        ...SWAP_PARAMS,
        safety: "pass",
        vexFee:
          "Vex fee 0.25% (25 bps): 0.5 USDC | 500000 raw units | 6 decimals, taken on the input token inside this transaction; "
          + `199500000 raw units are swapped; paid to 0x7e57fee000000000000000000000000000000fee; stated by the matched quote and re-checked before signing.`,
        quoteBinding:
          "kyber-quote-v1 | quoted 0.05714 ETH | will not fill below 0.05686 ETH (50 bps of the quote)"
          + ` | quote h3-fixture-quote-1 digest ${QUOTE_DIGEST} | expires ${isoAt(-(ask - 21 * SECOND) + 10 * MINUTE)}`,
      },
    },
    expiresAt: isoAt(-(ask - 21 * SECOND) + 10 * MINUTE),
    decision: approved ? "approved" : null,
    decisionReason: null,
    executionStatus: approved ? "succeeded" : "not_started",
    origin: "agent",
    projectId: null,
    requestedByClient: null,
  };
}

function runtimeState(stage: SwapStage): RuntimeStateDto {
  const live = stage === "thinking";
  return {
    sessionId: SWAP_CHAT.id,
    hasActiveRun: stage !== "filled",
    missionRunId: null,
    status: stage === "waiting" ? "paused_approval" : live ? "running" : null,
    stopReason: null,
    lastCheckpointAt: null,
    startedAt: stage === "filled" ? null : isoAt(-ASK_AGO[stage]),
    iterationCount: stage === "filled" ? null : stage === "waiting" ? 3 : 1,
    leaseActive: live,
    leaseExpiresAt: live ? isoAt(MINUTE) : null,
    pendingControlKind: null,
    stoppable: stage !== "filled",
    activity: live ? { kind: "running" } : { kind: "none" },
  };
}

/** The pending row the app-wide inbox lists while the card waits. */
export function swapPendingAll(stage: SwapStage): ApprovalPendingGlobalDto[] {
  if (stage !== "waiting") return [];
  return [{ ...swapApproval(stage), sessionTitle: SWAP_CHAT.title, projectName: null }];
}

/** Every read an open chat makes, answered for the swap chat at one stage. */
export function swapChatAnswers(stage: SwapStage): BridgeAnswers {
  const page: MessagePage = fixture(`swap-chat.${stage}.messages`, {
    items: transcript(stage),
    nextCursor: null,
    hasMore: false,
  });
  const pending = stage === "waiting" ? [fixture("swap-chat.approval", swapApproval(stage))] : [];
  return {
    messages: { list: () => ok(page) },
    runtime: { getState: () => ok(runtimeState(stage)) },
    approvals: {
      listPending: () => ok(pending),
      get: () => ok(stage === "waiting" ? pending[0] ?? null : swapApproval(stage)),
    },
    mission: { getDraft: () => ok(null) },
    usage: {
      getContextWindow: () => ok({ sessionId: SWAP_CHAT.id, tokensUsed: 18_400, contextLimit: MODEL.contextLength }),
      // The last settled turn's rollup: the quote turn while the card waits,
      // the execute turn once it has filled. A live turn has none of its own.
      getLastTurn: () =>
        ok(stage === "thinking" ? null : {
          sessionId: SWAP_CHAT.id,
          latestRoundPromptTokens: 9_240,
          latestRoundCachedTokens: 6_100,
          turnCompletionTokens: stage === "filled" ? 520 : 410,
          turnReasoningTokens: 180,
          turnCacheWriteTokens: 0,
          turnCost: stage === "filled" ? 0.0264 : 0.0213,
          turnCachedSavings: 0.0081,
          roundCount: 3,
          currency: "USD",
          provider: MODEL.providerId,
          model: MODEL.modelId,
          latestRoundAt: isoAt(-(stage === "filled" ? 55 : 21) * SECOND),
        }),
    },
    sessions: {
      getModel: () =>
        ok({
          sessionId: SWAP_CHAT.id,
          provider: MODEL.providerId,
          modelId: MODEL.modelId,
          source: "global_default",
          updatedAt: null,
          supportsReasoning: true,
          reasoning: MODEL.reasoning,
        }),
    },
    poolsLaunch: { getAwaiting: () => ok({ awaiting: null }) },
    lighterTrading: { getPendingAgentSetup: () => ok({ interaction: null }) },
  };
}
