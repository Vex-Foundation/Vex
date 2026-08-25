/**
 * The board presentation state machine, at the three seams that own it.
 *
 * The contract being pinned (Codex amendment 2): `BoardCompose` is a TERMINAL
 * presentation tool. It is the sole call in its batch, nothing dispatches once
 * a board is staged, the first eligible prose consumes it into the SAME
 * transcript row, and every other way a turn can end discards it.
 *
 * State table, one row per test below:
 *
 *   NONE     + compose alone            -> PENDING        (compose tool test)
 *   NONE     + compose beside a sibling -> NONE, batch refused whole
 *   PENDING  + any tool call            -> PENDING, batch refused whole
 *   PENDING  + second compose           -> PENDING, batch refused whole
 *   PENDING  + non-blank prose          -> NONE, board on that row's metadata
 *   PENDING  + blank prose              -> PENDING (nothing to annotate)
 *   PENDING  + prose whose INSERT threw -> NONE (the row does not exist)
 *   PENDING  + mission-run prose        -> NONE, continuation AFTER the commit
 *   PENDING  + scope closed (stop,
 *              cancel, exhaustion, park) -> NONE
 *
 * Approval and user-form parking need no row of their own: both are reached
 * only by a DISPATCHED tool, and row 3 dispatches nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BOARD_COMPOSE_NOT_SOLE_CALL_OUTPUT,
  BOARD_PENDING_TOOL_REFUSED_OUTPUT,
  evaluatePresentationGate,
} from "@vex-agent/engine/core/turn-loop-tool-batch/presentation-gate.js";
import {
  beginPresentationScope,
  consumePendingPresentation,
  endPresentationScope,
  hasPendingPresentation,
  stagePresentation,
} from "@vex-agent/engine/core/board-presentation.js";
import type { BoardSpecV1 } from "../../../../lib/board/index.js";

const SESSION = "session-board";

/** A minimal valid-shaped spec. Shape fidelity is `src/lib/board`'s own suite. */
function spec(title = "Board"): BoardSpecV1 {
  return {
    version: 1,
    title,
    pools: [{ chain: "solana", pairAddress: "Abc123" }],
    hydration: {
      rows: [
        {
          baseTokenSymbol: "WIF",
          baseTokenName: "dogwifhat",
          quoteTokenSymbol: "SOL",
          chainId: "solana",
          dexId: "raydium",
          priceUsd: "1.23",
          priceChange: { h1: "-1.5", h24: "4.25" },
          liquidityUsd: "1000000",
          volumeH24Usd: "250000",
          txns: { buys: 10, sells: 4 },
          pairAgeSeconds: 86_400,
        },
      ],
      candles: null,
      analysisCreatedAt: 1_700_000_000_000,
      marketDataFetchedAt: 1_700_000_000_000,
      provenance: { transport: "site_bridge", sourceObservation: "1 pool row" },
      staleAfterMs: 60_000,
    },
  } as BoardSpecV1;
}

/* ------------------------------------------------------------------ */
/* The pure gate                                                       */
/* ------------------------------------------------------------------ */

describe("evaluatePresentationGate", () => {
  it("lets an ordinary batch through", () => {
    expect(
      evaluatePresentationGate({
        toolCalls: [{ name: "WalletBalances" }, { name: "AgentScan" }],
        hasPendingPresentation: false,
      }),
    ).toEqual({ kind: "proceed" });
  });

  it("lets a lone BoardCompose through", () => {
    expect(
      evaluatePresentationGate({
        toolCalls: [{ name: "BoardCompose" }],
        hasPendingPresentation: false,
      }),
    ).toEqual({ kind: "proceed" });
  });

  it("refuses the WHOLE batch when BoardCompose has a sibling", () => {
    const decision = evaluatePresentationGate({
      toolCalls: [{ name: "BoardCompose" }, { name: "WalletBalances" }],
      hasPendingPresentation: false,
    });
    expect(decision).toEqual({
      kind: "refuse_batch",
      reason: "compose_not_sole_call",
      output: BOARD_COMPOSE_NOT_SOLE_CALL_OUTPUT,
    });
  });

  it("refuses the batch when a board is already pending, whatever it contains", () => {
    for (const calls of [
      [{ name: "WalletBalances" }],
      [{ name: "BoardCompose" }],
      [{ name: "BoardCompose" }, { name: "AgentScan" }],
    ]) {
      expect(
        evaluatePresentationGate({ toolCalls: calls, hasPendingPresentation: true }),
      ).toMatchObject({
        kind: "refuse_batch",
        reason: "pending_presentation",
        output: BOARD_PENDING_TOOL_REFUSED_OUTPUT,
      });
    }
  });

  it("names the pending board rather than the sole-call rule when both apply", () => {
    // A model told "compose must be alone" while the real problem is a staged
    // board would re-emit the compose and be refused again.
    const decision = evaluatePresentationGate({
      toolCalls: [{ name: "BoardCompose" }, { name: "AgentScan" }],
      hasPendingPresentation: true,
    });
    expect(decision).toMatchObject({ reason: "pending_presentation" });
  });

  it("proceeds on an empty batch", () => {
    expect(
      evaluatePresentationGate({ toolCalls: [], hasPendingPresentation: true }),
    ).toEqual({ kind: "proceed" });
  });
});

/* ------------------------------------------------------------------ */
/* The store: scope lifecycle                                          */
/* ------------------------------------------------------------------ */

describe("board presentation scope", () => {
  beforeEach(() => {
    endPresentationScope(SESSION);
  });

  it("refuses to stage outside a live turn", () => {
    expect(stagePresentation(SESSION, spec(), 1)).toBe("no_open_scope");
    expect(hasPendingPresentation(SESSION)).toBe(false);
  });

  it("stages inside an open scope and reports it pending", () => {
    beginPresentationScope(SESSION);
    expect(stagePresentation(SESSION, spec(), 1)).toBe("staged");
    expect(hasPendingPresentation(SESSION)).toBe(true);
  });

  it("refuses a second board rather than replacing the first", () => {
    beginPresentationScope(SESSION);
    stagePresentation(SESSION, spec("first"), 1);
    expect(stagePresentation(SESSION, spec("second"), 2)).toBe("already_pending");
    expect(consumePendingPresentation(SESSION)?.spec.title).toBe("first");
  });

  it("consumes exactly once", () => {
    beginPresentationScope(SESSION);
    stagePresentation(SESSION, spec(), 1);
    expect(consumePendingPresentation(SESSION)).not.toBeNull();
    expect(consumePendingPresentation(SESSION)).toBeNull();
    expect(hasPendingPresentation(SESSION)).toBe(false);
  });

  it("discards the board when the turn ends without prose", () => {
    beginPresentationScope(SESSION);
    stagePresentation(SESSION, spec(), 1);
    endPresentationScope(SESSION);
    expect(hasPendingPresentation(SESSION)).toBe(false);
    // And a later turn cannot pick it up.
    beginPresentationScope(SESSION);
    expect(consumePendingPresentation(SESSION)).toBeNull();
  });

  it("discards a board left behind by a turn that threw past its own close", () => {
    beginPresentationScope(SESSION);
    stagePresentation(SESSION, spec("orphan"), 1);
    beginPresentationScope(SESSION);
    expect(hasPendingPresentation(SESSION)).toBe(false);
  });

  it("keeps sessions independent", () => {
    beginPresentationScope(SESSION);
    beginPresentationScope("other-session");
    stagePresentation(SESSION, spec(), 1);
    expect(hasPendingPresentation("other-session")).toBe(false);
    endPresentationScope("other-session");
    expect(hasPendingPresentation(SESSION)).toBe(true);
    endPresentationScope(SESSION);
  });
});

/* ------------------------------------------------------------------ */
/* The batch: nothing dispatches on a refusal                          */
/* ------------------------------------------------------------------ */

const dispatchTool = vi.fn();
const persistBatchTranscript = vi.fn().mockResolvedValue(undefined);

vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (...args: unknown[]) => dispatchTool(...args),
}));
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/execute.js", () => ({
  buildToolContext: (context: Record<string, unknown>) => ({
    ...context,
    approved: false,
    contextUsageBand: "normal",
  }),
}));
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/approval-stop.js", () => ({
  assertApprovalActionKind: () => "read",
  enqueueApprovalIntent: vi.fn(),
}));
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/results.js", async (
  importOriginal,
) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  persistBatchTranscript: (...args: unknown[]) => persistBatchTranscript(...args),
}));

const { processTurnToolBatch } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch.js"
);

function context() {
  return {
    sessionId: SESSION,
    sessionKind: "chat",
    sessionPermission: "full",
    missionId: null,
    missionRunId: null,
    loadedDocuments: new Map(),
    walletPolicy: { kind: "none" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function runBatch(names: readonly string[]) {
  return processTurnToolBatch({
    context: context(),
    turnResult: {
      content: null,
      reasoning: null,
      toolCalls: names.map((name, i) => ({ id: `call-${i}`, name, arguments: {} })),
    },
    liveMessages: [],
    currentTokenCount: 0,
    contextLimit: 100_000,
    lastTextSoFar: null,
  });
}

/** The persisted call/result pair for the batch under test. */
function persisted(): {
  executedCalls: Array<{ name: string }>;
  executedResults: Array<{ output: string; success: boolean }>;
} {
  const call = persistBatchTranscript.mock.calls[0];
  if (call === undefined) throw new Error("persistBatchTranscript not called");
  return call[0] as ReturnType<typeof persisted>;
}

describe("processTurnToolBatch - board presentation gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistBatchTranscript.mockResolvedValue(undefined);
    dispatchTool.mockResolvedValue({ success: true, output: "ok" });
    endPresentationScope(SESSION);
  });

  it("dispatches a lone BoardCompose", async () => {
    beginPresentationScope(SESSION);
    const outcome = await runBatch(["BoardCompose"]);
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("normal_complete");
  });

  it("refuses a mixed batch WITHOUT dispatching anything", async () => {
    beginPresentationScope(SESSION);
    const outcome = await runBatch(["BoardCompose", "WalletBalances"]);

    expect(dispatchTool).not.toHaveBeenCalled();
    const { executedCalls, executedResults } = persisted();
    // Pairing survives: every emitted call carries exactly one result.
    expect(executedCalls).toHaveLength(2);
    expect(executedResults).toHaveLength(2);
    expect(executedResults.every((r) => r.output === BOARD_COMPOSE_NOT_SOLE_CALL_OUTPUT)).toBe(true);
    expect(executedResults.every((r) => r.success === false)).toBe(true);
    // Nothing ran, so the turn's tool budget is untouched and the loop goes on.
    expect(outcome).toMatchObject({ kind: "normal_complete", toolCallsExecuted: 0 });
  });

  it("refuses every tool call once a board is staged, with the prose instruction", async () => {
    beginPresentationScope(SESSION);
    stagePresentation(SESSION, spec(), 1);

    const outcome = await runBatch(["WalletBalances", "AgentScan"]);

    expect(dispatchTool).not.toHaveBeenCalled();
    const { executedResults } = persisted();
    expect(executedResults.map((r) => r.output)).toEqual([
      BOARD_PENDING_TOOL_REFUSED_OUTPUT,
      BOARD_PENDING_TOOL_REFUSED_OUTPUT,
    ]);
    expect(outcome).toMatchObject({ kind: "normal_complete", toolCallsExecuted: 0 });
    // The board is still staged: a refusal must not lose the analysis.
    expect(hasPendingPresentation(SESSION)).toBe(true);
  });

  it("refuses a SECOND compose without dispatching it", async () => {
    beginPresentationScope(SESSION);
    stagePresentation(SESSION, spec("first"), 1);

    await runBatch(["BoardCompose"]);

    expect(dispatchTool).not.toHaveBeenCalled();
    expect(persisted().executedResults[0]?.output).toBe(BOARD_PENDING_TOOL_REFUSED_OUTPUT);
    expect(consumePendingPresentation(SESSION)?.spec.title).toBe("first");
  });

  it("keeps ordinary batches untouched when no board is in play", async () => {
    beginPresentationScope(SESSION);
    const outcome = await runBatch(["WalletBalances", "AgentScan"]);
    expect(dispatchTool).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ kind: "normal_complete", toolCallsExecuted: 2 });
  });
});
