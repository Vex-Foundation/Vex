/**
 * The commit point: a staged board becomes durable inside the SAME assistant
 * INSERT that carries the model's final prose, or it does not become durable
 * at all.
 *
 * This is the half of the terminal-tool contract the batch gate cannot prove.
 * The DB boundary (`appendMessage`) is the only thing stubbed, so the real
 * `saveAssistantMessage` builds the real metadata and the assertions are about
 * the row that would actually be written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const appendMessage = vi.fn().mockResolvedValue({ id: 1 });
const appendEngineMessage = vi.fn().mockResolvedValue({ id: 2 });

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...args: unknown[]) => appendMessage(...args),
  appendEngineMessage: (...args: unknown[]) => appendEngineMessage(...args),
  streamDeltaBus: { emit: vi.fn() },
  toStreamDeltaEvent: vi.fn(),
}));

const { handleTextResponse } = await import(
  "../../../../vex-agent/engine/core/turn-loop-text-response.js"
);
const {
  beginPresentationScope,
  endPresentationScope,
  hasPendingPresentation,
  stagePresentation,
} = await import("../../../../vex-agent/engine/core/board-presentation.js");
type BoardSpecV1 = import("../../../../lib/board/index.js").BoardSpecV1;

const SESSION = "session-consume";

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

function context(missionRunId: string | null = null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { sessionId: SESSION, missionRunId } as any;
}

/** The assistant row's metadata payload, as it would reach the JSONB column. */
function assistantPayload(): Record<string, unknown> | undefined {
  const call = appendMessage.mock.calls[0];
  if (call === undefined) throw new Error("no assistant row was written");
  return (call[2] as { payload?: Record<string, unknown> }).payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  appendMessage.mockResolvedValue({ id: 1 });
  endPresentationScope(SESSION);
});

describe("final prose consumes the staged board", () => {
  it("writes prose and board in ONE insert and leaves nothing pending", async () => {
    beginPresentationScope(SESSION);
    stagePresentation(SESSION, spec("SOL majors"), 1);

    const outcome = await handleTextResponse({
      context: context(),
      liveMessages: [],
      content: "Here is what the pools are doing.",
      reasoning: null,
      mergeOperatorInstructions: vi.fn(),
    });

    expect(appendMessage).toHaveBeenCalledTimes(1);
    const [, message, metadata] = appendMessage.mock.calls[0] as [
      string,
      { role: string; content: string },
      { payload?: { board?: BoardSpecV1 } },
    ];
    expect(message.role).toBe("assistant");
    expect(message.content).toBe("Here is what the pools are doing.");
    expect(metadata.payload?.board?.title).toBe("SOL majors");
    expect(hasPendingPresentation(SESSION)).toBe(false);
    expect(outcome.kind).toBe("break_on_text");
  });

  it("carries reasoning and board on the same payload without displacing either", async () => {
    beginPresentationScope(SESSION);
    stagePresentation(SESSION, spec(), 1);

    await handleTextResponse({
      context: context(),
      liveMessages: [],
      content: "done",
      reasoning: "I checked liquidity first",
      mergeOperatorInstructions: vi.fn(),
    });

    const payload = assistantPayload();
    expect(payload?.["reasoning"]).toBe("I checked liquidity first");
    expect(payload?.["board"]).toBeDefined();
  });

  it("writes NO board key on an ordinary reply", async () => {
    beginPresentationScope(SESSION);

    await handleTextResponse({
      context: context(),
      liveMessages: [],
      content: "no board here",
      reasoning: null,
      mergeOperatorInstructions: vi.fn(),
    });

    expect(assistantPayload()).toBeUndefined();
  });

  it("leaves the board staged when the reply is blank", async () => {
    beginPresentationScope(SESSION);
    stagePresentation(SESSION, spec(), 1);

    await handleTextResponse({
      context: context(),
      liveMessages: [],
      content: "   \n  ",
      reasoning: null,
      mergeOperatorInstructions: vi.fn(),
    });

    // Nothing a reader could see was written, so the analysis is still waiting.
    expect(hasPendingPresentation(SESSION)).toBe(true);
  });

  it("clears the board when the row's INSERT fails", async () => {
    beginPresentationScope(SESSION);
    stagePresentation(SESSION, spec(), 1);
    appendMessage.mockRejectedValueOnce(new Error("insert failed"));

    await expect(
      handleTextResponse({
        context: context(),
        liveMessages: [],
        content: "this row never commits",
        reasoning: null,
        mergeOperatorInstructions: vi.fn(),
      }),
    ).rejects.toThrow("insert failed");

    // The row does not exist, so no later row may inherit its board.
    expect(hasPendingPresentation(SESSION)).toBe(false);
  });

  it("commits the board BEFORE the mission continuation marker", async () => {
    beginPresentationScope(SESSION);
    stagePresentation(SESSION, spec("mission board"), 1);

    const outcome = await handleTextResponse({
      context: context("run-1"),
      liveMessages: [],
      content: "interim finding",
      reasoning: null,
      mergeOperatorInstructions: vi.fn(),
    });

    expect(assistantPayload()?.["board"]).toBeDefined();
    expect(appendEngineMessage).toHaveBeenCalledTimes(1);
    // Ordering, not merely both happening: the durable board precedes the cue
    // that lets the mission take another action.
    const boardWrite = appendMessage.mock.invocationCallOrder[0]!;
    const continuation = appendEngineMessage.mock.invocationCallOrder[0]!;
    expect(boardWrite).toBeLessThan(continuation);
    expect(outcome.kind).toBe("mission_run_continue");
    expect(hasPendingPresentation(SESSION)).toBe(false);
  });
});
