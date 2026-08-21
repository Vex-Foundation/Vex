/**
 * The model-facing SURFACE of the two-step listing flow.
 *
 * Two things must hold together, and each has failed on its own before:
 *
 *  1. **The pointer is at the very top of every non-empty listing** — "na samej
 *     górze każdego listowania". `JSON.stringify` preserves insertion order and
 *     the model reads the string front-to-back, so this asserts the REAL route
 *     output starts with `{"nextStep":`, not merely that the object has the key.
 *  2. **The prompt teaches the flow that actually exists.** Shipping the tool
 *     while the prompt still teaches a retired follow-up teaches a flow that no
 *     longer exists; `discovery-limit-prose.test.ts` only checks the 5/20
 *     wording and cannot catch it.
 *
 * THE REVEAL-SAFETY BLOCK IS GONE, AND ITS ABSENCE IS DELIBERATE. This suite
 * used to pin "the hidden manifest-fetch tool is never named on the pre-reveal
 * static surface". Owner decision D2 retired that reveal: select is a MODE of
 * `ToolSearch`, always visible, so there is no hidden name for prose to leak
 * and no pre-reveal posture to protect. The listing's pointer now names a MODE
 * rather than a second tool, which is what the first block asserts.
 *
 * The hostile-wire-root block SURVIVES the merge and moves with the guard it
 * covers: the retired manifest-fetch handler owned the JSON-root check, and
 * `dispatcher/tool-search-args.ts` owns it now for all three modes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { buildToolModelPrompt } from "@vex-agent/engine/prompts/tool-model.js";
import { resetProtocolsPromptCache } from "@vex-agent/engine/prompts/index.js";
import { MAX_SELECT_TOOL_NAMES } from "@vex-agent/tools/protocols/discovery.js";
import {
  clearDiscoveredTools,
  getDiscoveredToolIds,
} from "@vex-agent/tools/registry/discovered-tools.js";
import { dispatchTool } from "@vex-agent/tools/dispatcher.js";
import { makeTestContext } from "./_test-context.js";

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
    { name: "ToolSearch", args: { namespace }, toolCallId: "call_list" },
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
  resetProtocolsPromptCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  clearDiscoveredTools(SESSION);
});

describe("namespace listing — the nextStep pointer", () => {
  it("is the FIRST key of the serialized envelope the model actually receives", async () => {
    const result = await listNamespace("dexscreener");
    expect(result.output.startsWith(`{"${"nextStep"}":`)).toBe(true);
  });

  it("names the MODE, the bound, the next-request callability, and an example built from the FIRST returned name", async () => {
    const result = await listNamespace("dexscreener");
    const payload = JSON.parse(result.output);

    expect(payload.nextStep).toContain("select:");
    expect(payload.nextStep).toContain(String(MAX_SELECT_TOOL_NAMES));
    expect(payload.nextStep).toContain("callable");
    // A listing makes nothing callable in the same turn, and the pointer must
    // say so — the merge's central mechanical fact.
    expect(payload.nextStep).toContain("NEXT message");
    // The example must be a name this very listing returned, not a hard-coded
    // one that may not exist in the listed namespace.
    expect(payload.nextStep).toContain(payload.tools[0].publicName);
  });

  it("leaves the rest of the listing contract untouched", async () => {
    const result = await listNamespace("dexscreener");
    const payload = JSON.parse(result.output);

    expect(payload.totalCount).toBe(payload.count);
    expect(payload.hasMore).toBe(false);
    expect(payload.retrieval.method).toBe("list");
    // A listing row stays lean: names + one-line summaries + required KEYS,
    // never a param schema.
    for (const row of payload.tools) {
      expect(row).not.toHaveProperty("params");
      expect(row).toHaveProperty("requiredParams");
      expect(row).toHaveProperty("summary");
    }
  });

  it("an EMPTY namespace listing carries NO pointer — there is nothing to select", async () => {
    delete process.env.JUPITER_API_KEY;
    const result = await listNamespace("solana");
    const payload = JSON.parse(result.output);

    expect(payload.count).toBe(0);
    expect(payload).not.toHaveProperty("nextStep");
    expect(result.output.startsWith('{"success":')).toBe(true);
  });

  it("a listing records NOTHING — the menu does not disturb the working set", async () => {
    await listNamespace("dexscreener");
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
  });
});

describe("prompt prose — teaches the flow that exists", () => {
  it("teaches all three modes", () => {
    const prompt = buildToolModelPrompt();
    expect(prompt).toContain("select:");
    expect(prompt).toContain("NO query");
  });

  it("says a lost schema can be recovered by selecting the tool again", () => {
    expect(buildToolModelPrompt()).toContain("recover a tool whose schema");
  });
});

describe("hostile wire roots reach this lane for real", () => {
  it("answers a JSON root of `null` by name, with no exception and no recording", async () => {
    // Both inference paths accept an arbitrary JSON root and dispatch it
    // verbatim (`inference/stream-consumer.ts`, `inference/openrouter/mappers.ts`),
    // so `null` arguments reach the handler for real. Dereferencing before
    // validating turned that into a generic exception — the model learns
    // nothing it can act on, which is exactly what the real-cause decree
    // forbids.
    const result = await dispatchTool(
      { name: "ToolSearch", args: hostileWireArgs(null), toolCallId: "call_null" },
      makeTestContext({ sessionId: SESSION }),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("must be an object");
    // Not the generic dispatcher catch-all.
    expect(result.output).not.toContain("Cannot read");
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
  });

  it("answers every other non-object JSON root by name too", async () => {
    for (const root of [[], "namespace", 7, true]) {
      const result = await dispatchTool(
        { name: "ToolSearch", args: hostileWireArgs(root), toolCallId: "call_root" },
        makeTestContext({ sessionId: SESSION }),
      );
      expect(result.success, `root ${JSON.stringify(root)} was accepted`).toBe(false);
      expect(result.output).toContain("must be an object");
      expect(getDiscoveredToolIds(SESSION)).toEqual([]);
    }
  });
});
