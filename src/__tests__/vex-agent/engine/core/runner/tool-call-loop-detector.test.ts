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
  TOOL_READ_POLL_CAP,
  TOOL_RESULT_VOLATILE_KEYS,
  canonicalize,
  createToolCallLoopDetector,
  normalizeToolResultOutput,
  toolCallSignature,
  type CompletedToolCallObservation,
  type ToolCallLoopVerdict,
} from "@vex-agent/engine/core/runner/tool-call-loop-detector.js";

import { requireValue } from "../../../../helpers/require-value.js";

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

  /**
   * The signature is a DIGEST, and the reason is retention: arguments and
   * model-visible output are where addresses, amounts and user content live,
   * and the history holds a turn's worth of them in memory for the life of the
   * turn. A signature that still contained them would be a copy of that
   * content under another name.
   */
  it("is a sha256 digest that retains none of what it hashes", () => {
    const signature = toolCallSignature(
      call({
        args: { to: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", amount: "125" },
        output: "sent to 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    );
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signature).not.toContain("0xdeadbeef");
    expect(signature).not.toContain("125");
  });

  it("is stable for the same call and different for a changed argument", () => {
    const a = toolCallSignature(call({ args: { page: 1 } }));
    expect(toolCallSignature(call({ args: { page: 1 } }))).toBe(a);
    expect(toolCallSignature(call({ args: { page: 2 } }))).not.toBe(a);
  });

  /**
   * What the NUL separator actually buys, with a pair that genuinely collides
   * without it.
   *
   * The fields are name, canonical args, the success flag, then output. A
   * NUMERIC argument canonicalises to bare digits, so a character can be moved
   * across the name/args boundary with nothing else changing:
   *
   *     "a"  + "12" + "ok" + "x"   ->  a12okx
   *     "a1" + "2"  + "ok" + "x"   ->  a12okx
   *
   * Concatenated with no delimiter these are byte-identical, so an unseparated
   * signature would treat two unrelated calls as the same call - and five of
   * those STOP A RUN. The NUL cannot occur in either the JSON-encoded canonical
   * form or a bare number, so it is the thing that keeps them apart.
   *
   * (An earlier version of this test used "ab"+"c" against "a"+"bc", which
   * proved nothing: the args and the flag sit between name and output, so
   * those two differ with or without a separator.)
   */
  it("would collide across a field boundary if the separator were removed", () => {
    const shiftedLeft = call({ toolName: "a", args: 12, success: true, output: "x" });
    const shiftedRight = call({ toolName: "a1", args: 2, success: true, output: "x" });

    // The precondition this test rests on: identical once concatenated.
    const concatenated = (o: CompletedToolCallObservation) =>
      `${o.toolName}${canonicalize(o.args)}${o.success ? "ok" : "err"}${o.output}`;
    expect(concatenated(shiftedLeft)).toBe(concatenated(shiftedRight));

    // And distinct once the separator is in place.
    expect(toolCallSignature(shiftedLeft)).not.toBe(
      toolCallSignature(shiftedRight),
    );
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

describe("per-tool volatile-field normalisation", () => {
  /** A Jupiter price answer shaped like the handler's, plus a read stamp. */
  function priceOutput(usdPrice: number, blockId: number, asOf: string): string {
    return JSON.stringify({
      prices: { So111: { usdPrice, blockId, decimals: 9, priceChange24h: 1.5 } },
      missing: [],
      asOf,
    });
  }

  function priceRead(usdPrice: number, i: number): CompletedToolCallObservation {
    return call({
      toolName: "solana__token_prices_get",
      args: { mints: ["So111"] },
      output: priceOutput(usdPrice, 300_000_000 + i, `2026-09-29T10:00:0${i}.000Z`),
    });
  }

  it("is per tool and never names a price, balance or status field", () => {
    for (const keys of TOOL_RESULT_VOLATILE_KEYS.values()) {
      for (const kept of ["usdPrice", "price", "priceUsd", "balance", "amount", "status"]) {
        expect(keys.has(kept)).toBe(false);
      }
    }
    expect(TOOL_RESULT_VOLATILE_KEYS.get("solana__token_prices_get")?.has("blockId")).toBe(true);
  });

  it("catches a price poll whose result differs only in its fetch stamps", () => {
    const polls = Array.from({ length: 5 }, (_, i) => priceRead(142.5, i));
    // The raw outputs really do differ on every call.
    expect(new Set(polls.map((p) => p.output)).size).toBe(5);
    expect(verdicts(polls)).toEqual(["clear", "clear", "clear", "clear", "correct"]);
  });

  it("does NOT treat the same read as a loop when the PRICE moved", () => {
    const polls = Array.from({ length: 5 }, (_, i) => priceRead(142.5 + i, i));
    expect(verdicts(polls)).toEqual(Array(5).fill("clear"));
  });

  it("strips volatile keys at any depth and ignores key order", () => {
    const a = JSON.stringify({
      pair: { priceUsd: "1.2", sourceObservation: { fetchedAtMs: 1, cacheState: "cache_hit", cacheAgeMs: 4000 } },
    });
    const b = JSON.stringify({
      pair: { sourceObservation: { cacheState: "cache_miss", fetchedAtMs: 2 }, priceUsd: "1.2" },
    });
    const moved = JSON.stringify({ pair: { priceUsd: "1.3", sourceObservation: { fetchedAtMs: 3 } } });
    expect(normalizeToolResultOutput("dexscreener__pair_get", a))
      .toBe(normalizeToolResultOutput("dexscreener__pair_get", b));
    expect(normalizeToolResultOutput("dexscreener__pair_get", moved))
      .not.toBe(normalizeToolResultOutput("dexscreener__pair_get", a));
  });

  it("keeps balances: a WalletBalances answer whose balance moved is a different result", () => {
    const out = (amount: string, observedAt: string) =>
      JSON.stringify({ balances: [{ symbol: "USDC", amount }], sources: [{ observedAt }] });
    expect(normalizeToolResultOutput("WalletBalances", out("10", "t1")))
      .toBe(normalizeToolResultOutput("WalletBalances", out("10", "t2")));
    expect(normalizeToolResultOutput("WalletBalances", out("10", "t1")))
      .not.toBe(normalizeToolResultOutput("WalletBalances", out("11", "t1")));
  });

  it("leaves an unknown tool's output verbatim, as before", () => {
    const output = JSON.stringify({ value: 1, fetchedAt: "2026-09-29T10:00:00.000Z" });
    expect(normalizeToolResultOutput("some_unknown_read", output)).toBe(output);
    const polls = Array.from({ length: 5 }, (_, i) =>
      call({ toolName: "some_unknown_read", output: JSON.stringify({ value: 1, fetchedAt: `t${i}` }) }));
    expect(verdicts(polls)).toEqual(Array(5).fill("clear"));
  });

  it("falls back to verbatim when a listed tool's output is not JSON", () => {
    expect(normalizeToolResultOutput("solana__token_prices_get", "provider timeout"))
      .toBe("provider timeout");
  });
});

describe("per-turn read-polling cap", () => {
  function movingPriceRead(
    i: number,
    mints: readonly string[] = ["So111"],
  ): CompletedToolCallObservation {
    return call({
      toolName: "solana__token_prices_get",
      args: { mints },
      output: JSON.stringify({ prices: { So111: { usdPrice: 100 + i } } }),
    });
  }

  it("corrects the call that exceeds the cap, even when every price moved", () => {
    expect(TOOL_READ_POLL_CAP).toBe(5);
    const detector = createToolCallLoopDetector();
    const results = Array.from({ length: TOOL_READ_POLL_CAP + 1 }, (_, i) =>
      detector.observe(movingPriceRead(i)));
    expect(results.slice(0, TOOL_READ_POLL_CAP).map((r) => r.kind))
      .toEqual(Array(TOOL_READ_POLL_CAP).fill("clear"));
    const last = requireValue(results[TOOL_READ_POLL_CAP]);
    if (last.kind !== "correct") throw new Error(`expected a correction, got ${last.kind}`);
    expect(last.facts).toMatchObject({
      toolName: "solana__token_prices_get",
      cycleLength: 1,
      repeatCount: TOOL_READ_POLL_CAP + 1,
      strike: 1,
      trigger: "read_poll",
    });
    expect(last.facts.toolCallIds).toHaveLength(TOOL_READ_POLL_CAP + 1);
    // Facts carry the shape, never the arguments.
    expect(JSON.stringify(last.facts)).not.toContain("So111");
  });

  it("stops when the same read is issued again after the correction", () => {
    const kinds = verdicts(
      Array.from({ length: TOOL_READ_POLL_CAP + 2 }, (_, i) => movingPriceRead(i)),
    );
    expect(kinds.slice(-2)).toEqual(["correct", "stop"]);
  });

  it("counts identical arguments only: different arguments are different reads", () => {
    const detector = createToolCallLoopDetector();
    const kinds: string[] = [];
    for (let i = 0; i < 12; i++) {
      kinds.push(detector.observe(movingPriceRead(i, [i % 2 === 0 ? "So111" : "Jup222"])).kind);
    }
    // Six of each, interleaved: each key crosses the cap on its own sixth call.
    expect(kinds.slice(0, 10).every((k) => k === "clear")).toBe(true);
    expect(kinds.slice(10)).toEqual(["correct", "stop"]);
  });

  it("counts across the turn, not only back-to-back", () => {
    const detector = createToolCallLoopDetector();
    const kinds: string[] = [];
    for (let i = 0; i < TOOL_READ_POLL_CAP + 1; i++) {
      kinds.push(detector.observe(movingPriceRead(i)).kind);
      kinds.push(detector.observe(call({ toolName: `other_${i}`, output: `o${i}` })).kind);
    }
    expect(kinds.filter((k) => k !== "clear")).toEqual(["correct"]);
  });

  it("does not cap an unknown tool, however often it is polled", () => {
    const polls = Array.from({ length: 40 }, (_, i) =>
      call({ toolName: "some_unknown_read", args: { id: 1 }, output: `v${i}` }));
    expect(verdicts(polls).every((k) => k === "clear")).toBe(true);
  });

  it("reports the cycle, not the cap, when both fire on one call", () => {
    const detector = createToolCallLoopDetector();
    const frozen = () => call({
      toolName: "solana__token_prices_get",
      args: { mints: ["So111"] },
      output: JSON.stringify({ prices: { So111: { usdPrice: 1 } } }),
    });
    const results = Array.from({ length: 6 }, () => detector.observe(frozen()));
    const fifth = requireValue(results[4]);
    const sixth = requireValue(results[5]);
    if (fifth.kind === "clear" || sixth.kind === "clear") throw new Error("expected strikes");
    expect(fifth.facts.trigger).toBe("cycle");
    expect(sixth.kind).toBe("stop");
    expect(sixth.facts.trigger).toBe("cycle");
  });
});
