/**
 * The tool-call repetition detector, as a pure decision.
 *
 * The module imports nothing, so these are table tests over the real thing -
 * no mocks, no harness, and every assertion is about the contract the batch
 * orchestrator relies on: WHEN it fires, WHEN it must not, and WHAT it is
 * allowed to say about what it saw.
 *
 * The negative cases carry as much weight as the positive ones. A detector
 * that fires on correct polling would end honest autonomous work mid-flight,
 * which is a strictly worse failure than the loop it exists to catch.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_TOOL_CALL_CYCLE_LENGTH,
  TOOL_CALL_LOOP_THRESHOLD,
  TOOL_CALL_SIGNATURE_HISTORY_LIMIT,
  canonicalize,
  createToolCallLoopDetector,
  toolCallSignature,
  type CompletedToolCallObservation,
  type ToolCallLoopVerdict,
} from "@vex-agent/engine/core/runner/tool-call-loop-detector.js";

let nextId = 0;

function call(
  overrides: Partial<CompletedToolCallObservation> = {},
): CompletedToolCallObservation {
  nextId += 1;
  return {
    toolCallId: `call-${nextId}`,
    toolName: "wallet_balance",
    args: { address: "So1111" },
    output: "balance: 0",
    success: true,
    ...overrides,
  };
}

/** Verdict kinds produced by feeding `observations` to one fresh detector. */
function verdicts(
  observations: readonly CompletedToolCallObservation[],
): ToolCallLoopVerdict["kind"][] {
  const detector = createToolCallLoopDetector();
  return observations.map((o) => detector.observe(o).kind);
}

describe("the bound is what the module documents", () => {
  it("threshold 5, cycles up to 5, history exactly what the longest needs", () => {
    expect(TOOL_CALL_LOOP_THRESHOLD).toBe(5);
    expect(MAX_TOOL_CALL_CYCLE_LENGTH).toBe(5);
    expect(TOOL_CALL_SIGNATURE_HISTORY_LIMIT).toBe(25);
  });
});

describe("the signature", () => {
  it("ignores argument key ORDER - the same call written two ways is one call", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it("keeps array order - a reordered list is a different request", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("terminates on a cyclic argument object instead of throwing into the batch", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic["self"] = cyclic;
    expect(() => canonicalize(cyclic)).not.toThrow();
  });

  it("excludes the call id and the duration, which differ on every call", () => {
    // Two observations that differ ONLY in their call id must collide, or the
    // detector could never see a repeat at all.
    expect(toolCallSignature(call({ toolCallId: "a" })))
      .toBe(toolCallSignature(call({ toolCallId: "b" })));
  });

  it("separates a success from a failure carrying the same output", () => {
    expect(toolCallSignature(call({ success: true, output: "no route" })))
      .not.toBe(toolCallSignature(call({ success: false, output: "no route" })));
  });
});

describe("what triggers", () => {
  it("corrects on the FIFTH identical call, and not before", () => {
    expect(verdicts(Array.from({ length: 5 }, () => call()))).toEqual([
      "clear", "clear", "clear", "clear", "correct",
    ]);
  });

  it("stops on the SIXTH - the repeat that survived the correction", () => {
    expect(verdicts(Array.from({ length: 6 }, () => call()))).toEqual([
      "clear", "clear", "clear", "clear", "correct", "stop",
    ]);
  });

  it("detects an A-B-A-B cycle at its fifth full pass, k = 2", () => {
    const observations = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0
        ? call({ toolName: "quote", output: "no route" })
        : call({ toolName: "retry_quote", output: "unchanged" }));
    const detector = createToolCallLoopDetector();
    const results = observations.map((o) => detector.observe(o));

    expect(results.slice(0, 9).map((r) => r.kind)).toEqual(Array(9).fill("clear"));
    const last = results[9];
    expect(last?.kind).toBe("correct");
    if (last?.kind !== "correct") throw new Error("expected a correction");
    expect(last.facts.cycleLength).toBe(2);
    // The cycle's HEAD, so an operator reading the log can find it in the tape.
    expect(last.facts.toolName).toBe("quote");
    expect(last.facts.toolCallIds).toHaveLength(10);
  });
});

describe("what must NOT trigger", () => {
  /**
   * The single most important negative case. A model polling a pending
   * transaction emits byte-identical name and arguments every time and is
   * behaving CORRECTLY. Only the answer moving distinguishes it from the
   * incident, which is exactly why the result is in the signature.
   */
  it("identical polling with a CHANGING result never triggers, at any length", () => {
    const polls = Array.from({ length: 40 }, (_, i) =>
      call({ toolName: "tx_status", args: { sig: "abc" }, output: `confirmations: ${i}` }));
    expect(verdicts(polls).every((k) => k === "clear")).toBe(true);
  });

  it("five DISTINCT calls never trigger", () => {
    const distinct = Array.from({ length: 5 }, (_, i) =>
      call({ toolName: `tool_${i}`, args: { i }, output: `out_${i}` }));
    expect(verdicts(distinct)).toEqual(Array(5).fill("clear"));
  });

  it("a single different call breaks a run of four and resets the window", () => {
    const detector = createToolCallLoopDetector();
    for (let i = 0; i < 4; i++) expect(detector.observe(call()).kind).toBe("clear");
    expect(detector.observe(call({ toolName: "other", output: "different" })).kind)
      .toBe("clear");
    // Four more identical calls: the tail is now [same, same, same, same]
    // preceded by the interloper, so no window of five matches.
    for (let i = 0; i < 4; i++) expect(detector.observe(call()).kind).toBe("clear");
  });

  it("a cycle longer than the maximum is not treated as a loop", () => {
    // Six distinct calls repeated five times: 30 observations, no k in [1,5].
    const detector = createToolCallLoopDetector();
    const kinds: string[] = [];
    for (let pass = 0; pass < 5; pass++) {
      for (let i = 0; i < 6; i++) {
        kinds.push(detector.observe(
          call({ toolName: `t${i}`, args: { i }, output: `o${i}` }),
        ).kind);
      }
    }
    expect(kinds.every((k) => k === "clear")).toBe(true);
  });
});

describe("what it reports", () => {
  it("names the shape of the repetition and NEVER the arguments", () => {
    const detector = createToolCallLoopDetector();
    const secret = { destination: "attacker-wallet", amountLamports: "999999" };
    let facts: Record<string, unknown> | null = null;
    for (let i = 0; i < 5; i++) {
      const verdict = detector.observe(call({
        toolName: "wallet_send",
        args: secret,
        output: "insufficient funds for attacker-wallet",
      }));
      if (verdict.kind === "correct") facts = { ...verdict.facts };
    }
    expect(facts).not.toBeNull();
    expect(facts).toMatchObject({
      toolName: "wallet_send",
      cycleLength: 1,
      repeatCount: 5,
      strike: 1,
    });
    // The privacy property, asserted on the serialized facts so a future field
    // cannot smuggle arguments back in.
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain("attacker-wallet");
    expect(serialized).not.toContain("999999");
    expect(serialized).not.toContain("insufficient funds");
  });

  it("numbers the strikes, so the consumer can tell correct from stop", () => {
    const detector = createToolCallLoopDetector();
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const verdict = detector.observe(call());
      if (verdict.kind !== "clear") seen.push(verdict.facts.strike);
    }
    expect(seen).toEqual([1, 2]);
  });
});

describe("boundedness", () => {
  /**
   * The history is a ring, and the three parallel arrays are shifted together.
   * If they ever drifted, the reported call ids would name calls that are not
   * the repeated ones - a fact that reads as evidence and would be wrong.
   */
  it("keeps a bounded history and still reports call ids from the real cycle", () => {
    const detector = createToolCallLoopDetector();
    // 60 distinct calls, far past the 25-entry bound, then five identical ones.
    for (let i = 0; i < 60; i++) {
      detector.observe(call({ toolName: `pad_${i}`, args: { i }, output: `p${i}` }));
    }
    const ids: string[] = [];
    let verdict: ToolCallLoopVerdict = { kind: "clear" };
    for (let i = 0; i < 5; i++) {
      const observation = call({ toolName: "looped", output: "same" });
      ids.push(observation.toolCallId);
      verdict = detector.observe(observation);
    }
    expect(verdict.kind).toBe("correct");
    if (verdict.kind === "clear") throw new Error("expected a correction");
    expect(verdict.facts.toolCallIds).toEqual(ids);
  });
});
