/**
 * The model-facing SURFACE of the two-step flow (R5, owner directive D2).
 *
 * Three things must hold together, and each has failed on its own before:
 *
 *  1. **The pointer is at the very top of every non-empty listing** — "na samej
 *     górze każdego listowania". `JSON.stringify` preserves insertion order and
 *     the model reads the string front-to-back, so this asserts the REAL route
 *     output starts with `{"nextStep":`, not merely that the object has the key.
 *  2. **The prompt teaches the flow that actually exists.** Shipping the tool
 *     while the prompt still says "follow up with a query or the toolId to get
 *     params" teaches a flow that no longer exists;
 *     `discovery-limit-prose.test.ts` only checks the 5/20 wording and cannot
 *     catch it.
 *  3. **The reveal is not defeated by prose.** `describe_tools` is hidden until
 *     a session discovers something, so its literal name must appear NOWHERE on
 *     the pre-reveal static surface — not in the always-visible tool schemas and
 *     not in the built prompt stack. Only a runtime listing's `nextStep` may
 *     name it, and after the reveal its own ToolDef and Tool Map row necessarily
 *     do. This is the contract
 *     `registry-swap-quote-reveal-consistency.test.ts` already enforces for the
 *     other hidden pair.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { buildToolModelPrompt } from "@vex-agent/engine/prompts/tool-model.js";
import { buildPromptStack, resetProtocolsPromptCache } from "@vex-agent/engine/prompts/index.js";
import { defaultVisibilityContext, getOpenAITools } from "@vex-agent/tools/registry.js";
import { MAX_DESCRIBE_TOOL_IDS } from "@vex-agent/tools/protocols/discovery.js";
import {
  clearDescribeToolsReveal,
  isDescribeToolsRevealed,
} from "@vex-agent/tools/registry/describe-tools-reveal.js";
import {
  clearDiscoveredTools,
  getDiscoveredToolIds,
} from "@vex-agent/tools/registry/discovered-tools.js";
import { dispatchTool } from "@vex-agent/tools/dispatcher.js";
import { makeTestContext } from "./_test-context.js";
import { makeContext } from "../engine/prompts/_prompt-stack-helpers.js";

const HIDDEN_TOOL_NAME = "describe_tools";
const SESSION = "discovery-list-prose-suite";

/**
 * The wire delivers arbitrary JSON roots (`null`, arrays, primitives) while the
 * dispatcher's arg type says `Record<string, unknown>` — these regressions exist
 * precisely to prove the handler survives that gap. Single cast from `unknown`,
 * contained here.
 */
function hostileWireArgs(root: unknown): Record<string, unknown> {
  return root as Record<string, unknown>;
}

const ENV_KEYS = ["JUPITER_API_KEY", "EMBEDDING_BASE_URL", "EMBEDDING_MODEL", "EMBEDDING_DIM", "EMBEDDING_PROVIDER"] as const;
const originalEnv: Record<string, string | undefined> = {};

async function listNamespace(namespace: string, sessionId = SESSION) {
  return dispatchTool(
    { name: "discover_tools", args: { namespace, list: true }, toolCallId: "call_list" },
    makeTestContext({ sessionId }),
  );
}

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.JUPITER_API_KEY = "test-key";
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_DIM;
  delete process.env.EMBEDDING_PROVIDER;
  clearDiscoveredTools(SESSION);
  clearDescribeToolsReveal(SESSION);
  resetProtocolsPromptCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  clearDiscoveredTools(SESSION);
  clearDescribeToolsReveal(SESSION);
});

describe("list mode — the nextStep pointer", () => {
  it("is the FIRST key of the serialized envelope the model actually receives", async () => {
    const result = await listNamespace("dexscreener");
    expect(result.output.startsWith(`{"${"nextStep"}":`)).toBe(true);
  });

  it("names the tool, the bound, the immediate callability, and an example built from the FIRST returned toolId", async () => {
    const result = await listNamespace("dexscreener");
    const payload = JSON.parse(result.output);

    expect(payload.nextStep).toContain(HIDDEN_TOOL_NAME);
    expect(payload.nextStep).toContain(String(MAX_DESCRIBE_TOOL_IDS));
    expect(payload.nextStep).toContain("callable");
    // The example must be a toolId this very listing returned, not a hard-coded
    // id that may not exist in the listed namespace.
    expect(payload.nextStep).toContain(payload.tools[0].toolId);
  });

  it("leaves the rest of the list contract untouched", async () => {
    const result = await listNamespace("dexscreener");
    const payload = JSON.parse(result.output);

    expect(payload.count).toBe(14);
    expect(payload.totalCount).toBe(14);
    expect(payload.hasMore).toBe(false);
    expect(payload.retrieval.method).toBe("list");
    // A list row stays lean: names + descriptions, never a param schema.
    for (const row of payload.tools) {
      expect(row).not.toHaveProperty("params");
      expect(row).toHaveProperty("requiredParams");
    }
  });

  it("an EMPTY namespace listing carries NO pointer — there is nothing to describe", async () => {
    delete process.env.JUPITER_API_KEY;
    const result = await listNamespace("solana");
    const payload = JSON.parse(result.output);

    expect(payload.count).toBe(0);
    expect(payload).not.toHaveProperty("nextStep");
    expect(result.output.startsWith('{"success":')).toBe(true);
  });

  it("ranked and catalog results carry NO pointer", async () => {
    for (const args of [{ namespace: "dexscreener" }, { query: "search pairs", namespace: "dexscreener" }]) {
      const result = await dispatchTool(
        { name: "discover_tools", args, toolCallId: "call_ranked" },
        makeTestContext({ sessionId: SESSION }),
      );
      expect(JSON.parse(result.output)).not.toHaveProperty("nextStep");
    }
  });
});

describe("prompt prose — teaches the flow that exists", () => {
  it("describes the two-step flow and no longer teaches the retired follow-up", () => {
    const prompt = buildToolModelPrompt();
    expect(prompt).toContain("nextStep");
    expect(prompt).not.toContain("then run a normal query, or pass the exact toolId, to get the `params` schema");
  });

  it("says a lost schema can be re-fetched", () => {
    expect(buildToolModelPrompt()).toContain("re-fetchable");
  });
});

describe("H2 reveal safety — the hidden tool is never named on the pre-reveal static surface", () => {
  it("no always-visible tool schema mentions it in an unrevealed session", () => {
    // Default context has no sessionId, so the reveal fails closed to hidden —
    // this IS the unrevealed posture, not a stand-in.
    const tools = getOpenAITools(defaultVisibilityContext());
    expect(tools.map((t) => t.function.name)).not.toContain(HIDDEN_TOOL_NAME);

    const offenders = tools
      .filter((tool) => JSON.stringify(tool).includes(HIDDEN_TOOL_NAME))
      .map((tool) => tool.function.name);
    expect(offenders, `these tool schemas name the hidden tool pre-reveal: ${offenders.join(", ")}`)
      .toEqual([]);
  });

  it("the COMPLETE built prompt stack never mentions it pre-reveal", () => {
    const stack = buildPromptStack(makeContext());
    const full = [...stack.staticLayers, ...stack.turnLayers].join("\n");
    expect(full.includes(HIDDEN_TOOL_NAME)).toBe(false);
  });

  it("joins the visible surface for a session that revealed it, and only then", async () => {
    expect(isDescribeToolsRevealed(SESSION)).toBe(false);
    expect(getOpenAITools(defaultVisibilityContext({ sessionId: SESSION })).map((t) => t.function.name))
      .not.toContain(HIDDEN_TOOL_NAME);

    await listNamespace("dexscreener");

    expect(isDescribeToolsRevealed(SESSION)).toBe(true);
    expect(getOpenAITools(defaultVisibilityContext({ sessionId: SESSION })).map((t) => t.function.name))
      .toContain(HIDDEN_TOOL_NAME);
  });

  it("a RANKED discovery reveals it too — the flow is not artificially narrowed to list mode", async () => {
    await dispatchTool(
      { name: "discover_tools", args: { namespace: "dexscreener" }, toolCallId: "call_r" },
      makeTestContext({ sessionId: SESSION }),
    );
    expect(isDescribeToolsRevealed(SESSION)).toBe(true);
  });

  it("a FAILED discovery does NOT reveal it", async () => {
    const result = await dispatchTool(
      { name: "discover_tools", args: { namespace: "not-a-namespace", list: true }, toolCallId: "call_f" },
      makeTestContext({ sessionId: SESSION }),
    );
    expect(result.success).toBe(false);
    expect(isDescribeToolsRevealed(SESSION)).toBe(false);
  });

  it("an EMPTY result does NOT reveal it", async () => {
    delete process.env.JUPITER_API_KEY;
    const result = await listNamespace("solana");
    expect(JSON.parse(result.output).count).toBe(0);
    expect(isDescribeToolsRevealed(SESSION)).toBe(false);
  });

  it("answers a JSON root of `null` by name, with no exception and no recording", async () => {
    // Both inference paths accept an arbitrary JSON root and dispatch it
    // verbatim (`inference/stream-consumer.ts`, `inference/openrouter/mappers.ts`),
    // so `null` arguments reach the handler for real. Dereferencing before
    // validating turned that into a generic exception — the model learns
    // nothing it can act on, which is exactly what the real-cause decree
    // forbids.
    await listNamespace("dexscreener");
    const before = [...getDiscoveredToolIds(SESSION)];

    const result = await dispatchTool(
      { name: HIDDEN_TOOL_NAME, args: hostileWireArgs(null), toolCallId: "call_null" },
      makeTestContext({ sessionId: SESSION }),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("toolIds");
    // Not the generic dispatcher catch-all.
    expect(result.output).not.toContain("Cannot read");
    expect([...getDiscoveredToolIds(SESSION)]).toEqual(before);
  });

  it("answers every other non-object JSON root by name too", async () => {
    await listNamespace("dexscreener");
    for (const root of [[], "toolIds", 7, true]) {
      const result = await dispatchTool(
        { name: HIDDEN_TOOL_NAME, args: hostileWireArgs(root), toolCallId: "call_root" },
        makeTestContext({ sessionId: SESSION }),
      );
      expect(result.success, `root ${JSON.stringify(root)} was accepted`).toBe(false);
      expect(result.output).toContain("toolIds");
    }
  });

  it("the handler HARD-REFUSES an unrevealed dispatch, independent of tool-list visibility", async () => {
    const result = await dispatchTool(
      { name: HIDDEN_TOOL_NAME, args: { toolIds: ["dexscreener.search"] }, toolCallId: "call_x" },
      makeTestContext({ sessionId: SESSION }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("discover_tools");
  });
});
