/**
 * `execute_tool` flat-args tolerance — the model→tool envelope boundary.
 *
 * THE DEFECT THIS CLOSES, measured in a live session (2026-07-30)
 *
 * A weaker model called `execute_tool` with the params FLAT rather than nested:
 * `{toolId: "dexscreener.search", query: "robinhood", limit: "10",
 *   chainIds: "[\"robinhood\"]"}`. The runtime read `args.params` (absent),
 * validated an EMPTY bag, and answered
 * `Missing required parameter "query" for dexscreener.search` — which is false
 * as the model reads it: `query` IS there. The model re-sent the same shape six
 * times, each failing in 0 ms.
 *
 * The fix is tolerance with a precise fallback, NOT a loosened boundary: a
 * top-level key is lifted only when the resolved manifest DECLARES it, and
 * every lifted value still faces the unchanged strict param gate.
 */

import { describe, expect, it } from "vitest";
import "./_dispatcher-test-mocks.js";
import { makeTestContext } from "./_test-context.js";

import {
  resolveExecuteToolParams,
} from "@vex-agent/tools/protocols/runtime/flat-args.js";

const { dispatchTool } = await import("../../../vex-agent/tools/dispatcher.js");

const SEARCH = "dexscreener.search";

function lifted(args: Record<string, unknown>): {
  params: Record<string, unknown>;
  liftedKeys: readonly string[];
} {
  const outcome = resolveExecuteToolParams(SEARCH, args);
  if (!outcome.ok) throw new Error(`expected a lift, got rejection: ${outcome.reason}`);
  return { params: outcome.params, liftedKeys: outcome.liftedKeys };
}

function rejection(toolId: string, args: Record<string, unknown>): string {
  const outcome = resolveExecuteToolParams(toolId, args);
  expect(outcome.ok, `expected rejection for ${JSON.stringify(args)}`).toBe(false);
  return outcome.ok ? "" : outcome.reason;
}

describe("resolveExecuteToolParams — the nested envelope stays the contract", () => {
  it("passes a well-formed params object through untouched and lifts nothing", () => {
    const params = { query: "robinhood", chainIds: "base" };
    const outcome = lifted({ toolId: SEARCH, params });
    expect(outcome.params).toEqual(params);
    expect(outcome.liftedKeys).toEqual([]);
  });

  it("treats a non-object `params` as absent rather than as a bag", () => {
    const outcome = lifted({ toolId: SEARCH, params: "query=robinhood", query: "robinhood" });
    expect(outcome.params).toEqual({ query: "robinhood" });
    expect(outcome.liftedKeys).toEqual(["query"]);
  });

  it("leaves a call with no params and no flat keys to the ordinary gate", () => {
    const outcome = lifted({ toolId: SEARCH });
    expect(outcome.params).toEqual({});
    expect(outcome.liftedKeys).toEqual([]);
  });
});

describe("resolveExecuteToolParams — flat args are lifted manifest-driven", () => {
  it("lifts the LIVE failing call's declared keys into the params bag", () => {
    const outcome = lifted({
      toolId: SEARCH,
      query: "robinhood",
      limit: "10",
      chainIds: '["robinhood"]',
    });
    expect(outcome.params).toEqual({
      query: "robinhood",
      limit: "10",
      chainIds: '["robinhood"]',
    });
    expect([...outcome.liftedKeys].sort()).toEqual(["chainIds", "limit", "query"]);
  });

  it("never lifts the envelope's own keys into the params bag", () => {
    const outcome = lifted({ toolId: SEARCH, query: "robinhood" });
    expect(outcome.params).not.toHaveProperty("toolId");
    expect(outcome.params).not.toHaveProperty("params");
  });

  it("ignores undeclared top-level keys — they never reach the handler", () => {
    // `notAParam` matches nothing in the manifest: the lift drops it, and the
    // strict unknown-key gate is therefore never handed a key the MODEL did not
    // put inside `params`.
    const outcome = lifted({ toolId: SEARCH, query: "robinhood", notAParam: "x" });
    expect(outcome.params).toEqual({ query: "robinhood" });
    expect(outcome.liftedKeys).toEqual(["query"]);
  });

  it("lifts the runtime's own reserved control key", () => {
    const outcome = lifted({ toolId: SEARCH, query: "robinhood", dryRun: true });
    expect(outcome.params).toEqual({ query: "robinhood", dryRun: true });
  });

  it("does not lift for an unknown toolId — the unknown-tool error must win", () => {
    const outcome = resolveExecuteToolParams("not.a.tool", { toolId: "not.a.tool", query: "x" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.params).toEqual({});
  });
});

describe("resolveExecuteToolParams — the no-match branch names the real fix", () => {
  it("explains the params envelope instead of blaming a missing parameter", () => {
    const reason = rejection(SEARCH, { toolId: SEARCH, q: "robinhood", max: 10 });
    expect(reason).toContain("params");
    // The keys the model actually sent, so it can see what it did.
    expect(reason).toContain("q");
    expect(reason).toContain("max");
    // A copyable shape.
    expect(reason).toContain(`"toolId"`);
    expect(reason).toContain(SEARCH);
    // NOT the misleading message that cost six calls.
    expect(reason).not.toContain("Missing required parameter");
  });
});

describe("execute_tool — the live failure, end to end through the dispatcher", () => {
  const context = makeTestContext();

  it("answers the live flat call in full instead of 'Missing required parameter \"query\"'", async () => {
    // The live args verbatim, and all three of their spelling mistakes are now
    // understood: the flat envelope is lifted HERE, `chainIds: '["robinhood"]'`
    // by `string-array-coercion.ts`, and `limit: "10"` by
    // `numeric-string-coercion.ts` (see `protocol-param-numeric-string.test.ts`,
    // which owns that rule and its refusals). None of them loosened the gate —
    // each is a manifest-declared, logged, lossless rewrite — so the call the
    // model actually meant now reaches the handler.
    const result = await dispatchTool(
      {
        name: "execute_tool",
        args: {
          toolId: SEARCH,
          query: "robinhood",
          limit: "10",
          chainIds: '["robinhood"]',
        },
        toolCallId: "call_flat_1",
      },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.output).not.toContain(`Missing required parameter "query"`);
    expect(result.output).not.toContain("expected number");
  });

  it("answers an envelope-less call with the envelope fix", async () => {
    const result = await dispatchTool(
      { name: "execute_tool", args: { toolId: SEARCH, q: "robinhood" }, toolCallId: "call_flat_2" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain(`"params"`);
    expect(result.output).toContain("q");
  });
});
