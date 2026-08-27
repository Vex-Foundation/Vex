/**
 * THE FROZEN BOARD VOCABULARY.
 *
 * Two things are pinned here because later builders code against them without
 * reading this directory: the exact bytes of the Ask VEX context envelope
 * (which is persisted into the transcript and read back by the model), and
 * the safety chip table, whose exhaustiveness is what stops a new state from
 * shipping without copy, a tone and a bucket.
 */

import { describe, expect, it } from "vitest";
import {
  BOARD_SAFETY_CHIP,
  BOARD_SAFETY_STATES,
  boardKeyOf,
  boardRefOf,
  boardSafetyVerdict,
  buildBoardAskMessage,
  pairSubjectFromPool,
  pairSubjectKey,
  type BoardAskContext,
  type BoardSafetyDetails,
  type BoardSafetyEvidence,
  type BoardSafetyState,
  type ClassifyBoardSafety,
} from "../board-surface-contracts.js";
import { boardSpec, hydratedRow } from "./boardFixture.js";

const CONTEXT: BoardAskContext = {
  boardTitle: "Base memecoins",
  tokenSymbol: "UBERCAT",
  tokenName: "Ubercat",
  chain: "base",
  pairAddress: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
  ammId: "uniswap",
  priceUsd: "0.0001324",
  dataMode: "snapshot",
  observedAtMs: Date.UTC(2026, 7, 26, 11, 11, 30),
};

describe("board identity", () => {
  it("keys a board by session and message row", () => {
    const board = boardRefOf("sess-1", 12, boardSpec({ title: "Top movers" }));
    expect(boardKeyOf(board)).toBe("sess-1:12");
    expect(board.title).toBe("Top movers");
    expect(board.createdAt).toBe(board.spec.hydration.analysisCreatedAt);
  });
});

describe("pair subject", () => {
  it("carries the provider's own spelling and the orientation", () => {
    const subject = pairSubjectFromPool(
      { chain: "base", pairAddress: "0xAAA111", analysis: null },
      hydratedRow({ dexId: "uniswap", baseTokenSymbol: "PEPE" }),
    );
    expect(subject).toEqual({
      chain: "base",
      pairAddress: "0xAAA111",
      ammId: "uniswap",
      baseTokenSymbol: "PEPE",
      baseTokenName: "Pepe the Frog",
      quoteTokenSymbol: "WETH",
      orientation: "base",
    });
    expect(pairSubjectKey(subject)).toBe("base:0xAAA111");
  });

  it("is still a valid subject when the row never landed", () => {
    const subject = pairSubjectFromPool(
      { chain: "solana", pairAddress: "Abc123", analysis: null },
      null,
    );
    expect(subject.ammId).toBeNull();
    expect(subject.baseTokenSymbol).toBeNull();
    expect(subject.chain).toBe("solana");
  });
});

describe("safety chip table (A5 / A11)", () => {
  it("covers every state exactly once", () => {
    expect(Object.keys(BOARD_SAFETY_CHIP).sort()).toEqual(
      [...BOARD_SAFETY_STATES].sort(),
    );
  });

  it("only `clear` is green, and only `clear` counts as clean", () => {
    for (const state of BOARD_SAFETY_STATES) {
      const verdict = boardSafetyVerdict(state);
      expect(verdict.state).toBe(state);
      expect(verdict.label.length).toBeGreaterThan(0);
      if (state === "clear") {
        expect(verdict.tone).toBe("positive");
        expect(verdict.bucket).toBe("clean");
      } else {
        expect(verdict.tone).not.toBe("positive");
        expect(verdict.bucket).not.toBe("clean");
      }
    }
  });

  it("puts the three risk verdicts in the high-risk bucket, the rest unchecked", () => {
    const highRisk: readonly BoardSafetyState[] = [
      "flagged",
      "conflict",
      "identity-mismatch",
    ];
    for (const state of BOARD_SAFETY_STATES) {
      const expected =
        state === "clear"
          ? "clean"
          : highRisk.includes(state)
            ? "high-risk"
            : "unchecked";
      expect(boardSafetyVerdict(state).bucket).toBe(expected);
    }
  });

  it("says what happened to THIS response, never that a chain is unsupported", () => {
    expect(BOARD_SAFETY_CHIP.unavailable.label).toBe(
      "Checks unavailable in this response",
    );
  });
});

/**
 * EXHAUSTIVENESS SCAFFOLD for the classifier T4 writes.
 *
 * This is not the classifier: it is the proof that the evidence type can
 * express the two cases a single outcome flag could not, plus the fixtures
 * T4's decision table (A11) will be driven with. When T4 lands, the real
 * `ClassifyBoardSafety` replaces the stub and these fixtures stay.
 */
describe("safety evidence shape", () => {
  const bundle: BoardSafetyDetails = {
    auditedTokenAddress: "0xtoken",
    subjectTokenAddress: "0xtoken",
    checks: [{ id: "isHoneypot", verdict: "pass", source: "goplus" }],
    unansweredCheckIds: [],
  };

  /** The shape of the decision, reduced to the two rows under discussion. */
  const classify: ClassifyBoardSafety = (evidence) => {
    if (evidence.lastAttempt.status === "in-flight" && evidence.lastGood === null) {
      return boardSafetyVerdict("pending");
    }
    if (evidence.lastGood === null) return boardSafetyVerdict("unavailable");
    if (evidence.lastGoodExpired && evidence.lastAttempt.status === "failed") {
      return boardSafetyVerdict("stale");
    }
    return boardSafetyVerdict("clear");
  };

  it("distinguishes usable-but-expired evidence from no evidence at all", () => {
    const staleEvidence: BoardSafetyEvidence = {
      lastGood: { bundle, fetchedAtMs: Date.UTC(2026, 7, 26, 10, 0, 0) },
      lastAttempt: {
        status: "failed",
        atMs: Date.UTC(2026, 7, 26, 11, 11, 0),
        reason: "transport",
      },
      lastGoodExpired: true,
    };
    const noEvidence: BoardSafetyEvidence = {
      lastGood: null,
      lastAttempt: {
        status: "failed",
        atMs: Date.UTC(2026, 7, 26, 11, 11, 0),
        reason: "transport",
      },
      lastGoodExpired: false,
    };

    expect(classify(staleEvidence).state).toBe("stale");
    expect(classify(noEvidence).state).toBe("unavailable");
    // The stale surface still has figures AND an honest clock to print.
    expect(staleEvidence.lastGood?.fetchedAtMs).toBe(
      Date.UTC(2026, 7, 26, 10, 0, 0),
    );
  });

  it("a first read in flight with nothing cached is pending, not unavailable", () => {
    expect(
      classify({
        lastGood: null,
        lastAttempt: { status: "in-flight" },
        lastGoodExpired: false,
      }).state,
    ).toBe("pending");
  });
});

describe("the Ask VEX context envelope", () => {
  it("is exactly these bytes", () => {
    expect(buildBoardAskMessage(CONTEXT, "Why is it moving?")).toBe(
      [
        "[Board context]",
        "Board: Base memecoins",
        "Token: UBERCAT (Ubercat) on base",
        "Pair: 0x1f9840a85d5af5bf1d1762f925bdaddc4201f984 on uniswap",
        "Price: 0.0001324 USD",
        "Figures: snapshot, read at 2026-08-26 11:11 UTC",
        "",
        "Why is it moving?",
      ].join("\n"),
    );
  });

  it("prints the pair address whole", () => {
    const message = buildBoardAskMessage(CONTEXT, "Check the risks");
    expect(message).toContain(CONTEXT.pairAddress);
    expect(message).not.toContain("...");
  });

  it("names a live reading as live", () => {
    const message = buildBoardAskMessage(
      { ...CONTEXT, dataMode: "live-connected" },
      "Check the risks",
    );
    expect(message).toContain("Figures: live, read at 2026-08-26 11:11 UTC");
  });

  it("says missing facts out loud instead of dropping the line", () => {
    const message = buildBoardAskMessage(
      {
        ...CONTEXT,
        tokenSymbol: null,
        tokenName: null,
        ammId: null,
        priceUsd: null,
      },
      "Check the risks",
    );
    expect(message).toContain("Token: unknown symbol on base");
    expect(message).toContain(`Pair: ${CONTEXT.pairAddress}\n`);
    expect(message).toContain("Price: not reported");
  });

  it("does not repeat a name identical to the symbol", () => {
    const message = buildBoardAskMessage(
      { ...CONTEXT, tokenName: "UBERCAT" },
      "Check the risks",
    );
    expect(message).toContain("Token: UBERCAT on base");
  });
});
