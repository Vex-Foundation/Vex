/**
 * Runtime param-type validation for `executeProtocolTool` (PR1 §1f).
 *
 * Pre-PR1 runtime only checked `required` presence; the `type` field in
 * `ProtocolParamDef` was documentation only. Handlers defended against
 * wrong types with `as any` casts on SDK enum params. PR1 closes the
 * boundary: the runtime rejects a call whose param `typeof` does not
 * match the declared `type`.
 *
 * We drive the runtime with an in-memory manifest + handler so the test
 * does not depend on any real protocol (every real handler would require
 * ENV / SDK setup). The assertion surface is the returned `ToolResult`.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import type {
  ProtocolExecutionContext,
  ProtocolHandler,
  ProtocolToolManifest,
} from "@vex-agent/tools/protocols/types.js";

// Approved full-permission session with the runtime's own neutral wallet
// defaults: every case here asserts the param-validation gate, so no wallet
// scope may influence whether the handler is reached.
const APPROVED_CONTEXT: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

// We patch the catalog lookups used by runtime.ts so we can inject a
// synthetic manifest without polluting the real registry. This keeps the
// test hermetic and avoids side-effects on unrelated suites.
vi.mock("@vex-agent/tools/protocols/catalog.js", async () => {
  const actual = await vi.importActual<typeof import("@vex-agent/tools/protocols/catalog.js")>(
    "@vex-agent/tools/protocols/catalog.js",
  );
  return {
    ...actual,
    getProtocolManifest: (toolId: string) =>
      TEST_MANIFESTS.get(toolId) ?? actual.getProtocolManifest(toolId),
    getProtocolHandler: (toolId: string) =>
      TEST_HANDLERS.get(toolId) ?? actual.getProtocolHandler(toolId),
  };
});

const TEST_MANIFESTS = new Map<string, ProtocolToolManifest>();
const TEST_HANDLERS = new Map<string, ProtocolHandler>();
let handlerCalls = 0;

const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");

function registerTestTool(manifest: ProtocolToolManifest, handler: ProtocolHandler): void {
  TEST_MANIFESTS.set(manifest.toolId, manifest);
  TEST_HANDLERS.set(manifest.toolId, handler);
}

beforeAll(() => {
  const captureHandler: ProtocolHandler = async (_params, _ctx) => {
    handlerCalls++;
    return { success: true, output: "ok" };
  };

  registerTestTool(
    {
      toolId: "test.type_validation.strict",
      publicName: "test__type_validation_strict",
      namespace: "dexscreener", // non-mutating namespace, non-advertised at test level is fine
      lifecycle: "active",
      description: "Test tool for runtime type validation",
      mutating: false,
      // Non-mutating synthetic tool: "read" is the classification that keeps
      // the approval gate out of the way of these param-validation assertions.
      actionKind: "read",
      exampleParams: {},
      params: [
        { key: "sort", type: "string", required: false, description: "A string enum" },
        { key: "limit", type: "number", required: false, description: "A number" },
        { key: "active", type: "boolean", required: false, description: "A boolean" },
        { key: "required_str", type: "string", required: true, description: "Required string" },
      ],
    },
    captureHandler,
  );
});

afterAll(() => {
  TEST_MANIFESTS.clear();
  TEST_HANDLERS.clear();
});

describe("runtime type validation (execute_tool)", () => {
  it("rejects wrong type for string param", async () => {
    handlerCalls = 0;
    const result = await executeProtocolTool(
      { toolId: "test.type_validation.strict", params: { required_str: "ok", sort: 123 } },
      APPROVED_CONTEXT,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/invalid type.*expected string.*got number/i);
    expect(handlerCalls).toBe(0);
  });

  it("rejects wrong type for number param", async () => {
    handlerCalls = 0;
    const result = await executeProtocolTool(
      { toolId: "test.type_validation.strict", params: { required_str: "ok", limit: "ten" } },
      APPROVED_CONTEXT,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/invalid type.*expected number.*got string/i);
    expect(handlerCalls).toBe(0);
  });

  it("rejects wrong type for boolean param", async () => {
    handlerCalls = 0;
    const result = await executeProtocolTool(
      { toolId: "test.type_validation.strict", params: { required_str: "ok", active: "yes" } },
      APPROVED_CONTEXT,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/invalid type.*expected boolean.*got string/i);
    expect(handlerCalls).toBe(0);
  });

  it("accepts correct types and calls handler exactly once", async () => {
    handlerCalls = 0;
    const result = await executeProtocolTool(
      {
        toolId: "test.type_validation.strict",
        params: { required_str: "ok", sort: "hot", limit: 10, active: true },
      },
      APPROVED_CONTEXT,
    );
    expect(result.success).toBe(true);
    expect(handlerCalls).toBe(1);
  });

  it("allows missing optional param (undefined = not enforced)", async () => {
    handlerCalls = 0;
    const result = await executeProtocolTool(
      { toolId: "test.type_validation.strict", params: { required_str: "ok" } },
      APPROVED_CONTEXT,
    );
    expect(result.success).toBe(true);
    expect(handlerCalls).toBe(1);
  });

  it("still rejects missing required param (required takes precedence)", async () => {
    handlerCalls = 0;
    const result = await executeProtocolTool(
      { toolId: "test.type_validation.strict", params: {} },
      APPROVED_CONTEXT,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/missing required parameter/i);
    expect(handlerCalls).toBe(0);
  });

  it("null and empty string are treated as missing (not type-checked)", async () => {
    handlerCalls = 0;
    // empty-string "" is treated as missing by runtime — so sort: "" is
    // allowed (optional + effectively absent); required_str: "" is rejected
    // as missing required. This mirrors pre-PR1 behaviour.
    const result = await executeProtocolTool(
      { toolId: "test.type_validation.strict", params: { required_str: "", sort: "" } },
      APPROVED_CONTEXT,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/missing required parameter "required_str"/i);
    expect(handlerCalls).toBe(0);
  });
});

// ── B-002: strict unknown-key boundary ───────────────────────────────────
//
// Pre-B-002 the runtime only checked DECLARED params (required + typeof) and
// let any UNDECLARED key flow straight into the handler. B-002 closes the
// boundary: a manifest-derived strict schema REJECTS any key that is neither
// declared nor a runtime-reserved control key (`dryRun`), BEFORE the handler.
describe("runtime strict param boundary (B-002 — unknown keys)", () => {
  it("rejects an UNKNOWN/extra key before the handler is invoked", async () => {
    handlerCalls = 0;
    const result = await executeProtocolTool(
      {
        toolId: "test.type_validation.strict",
        // `injected` is not declared on the manifest and is not a reserved
        // runtime control key — it must be rejected, not silently forwarded.
        params: { required_str: "ok", injected: "smuggled" },
      },
      APPROVED_CONTEXT,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/unknown parameter "injected"/i);
    expect(handlerCalls).toBe(0);
  });

  it("an UNKNOWN key whose value is `undefined` is treated as absent (handler runs)", async () => {
    handlerCalls = 0;
    // `{ undeclared_opt: undefined }` is equivalent to an absent key: JSON drops
    // it, and real tool-call params arrive via JSON.parse and never carry
    // `undefined`. It must NOT be rejected as an unknown key. The validator is a
    // gate (not a transform), so we assert handler invocation only — not removal.
    const result = await executeProtocolTool(
      {
        toolId: "test.type_validation.strict",
        params: { required_str: "ok", undeclared_opt: undefined },
      },
      APPROVED_CONTEXT,
    );
    expect(result.success).toBe(true);
    expect(handlerCalls).toBe(1);
  });

  it("names the allowed parameters in the rejection so the agent can self-correct", async () => {
    const result = await executeProtocolTool(
      { toolId: "test.type_validation.strict", params: { required_str: "ok", nope: 1 } },
      APPROVED_CONTEXT,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/allowed parameters: sort, limit, active, required_str/i);
  });

  it("a nested object value for a primitive-declared param is rejected (type), not passed through", async () => {
    handlerCalls = 0;
    // `sort` is declared `string`; a nested object must fail the strict type
    // check rather than reach the handler. Guards the 'no nested/extra shape
    // silently passes' invariant for today's primitive-only manifests.
    const result = await executeProtocolTool(
      { toolId: "test.type_validation.strict", params: { required_str: "ok", sort: { deep: true } } },
      APPROVED_CONTEXT,
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/invalid type.*expected string.*got object/i);
    expect(handlerCalls).toBe(0);
  });

  it("the reserved runtime control key `dryRun` is allowed even when the manifest does NOT declare it", async () => {
    handlerCalls = 0;
    // The synthetic manifest above declares no `dryRun` param, yet the runtime
    // owns `dryRun` (drives isPreviewExecution). It must NOT be rejected as
    // 'unknown'. (This manifest has no previewSupport, so the call still runs
    // the handler normally — we only assert dryRun is not rejected at the gate.)
    const result = await executeProtocolTool(
      { toolId: "test.type_validation.strict", params: { required_str: "ok", dryRun: true } },
      APPROVED_CONTEXT,
    );
    expect(result.success).toBe(true);
    expect(handlerCalls).toBe(1);
  });

  it("accepts a call with ONLY declared keys (no false-positive rejection)", async () => {
    handlerCalls = 0;
    const result = await executeProtocolTool(
      {
        toolId: "test.type_validation.strict",
        params: { required_str: "ok", sort: "hot", limit: 5, active: false },
      },
      APPROVED_CONTEXT,
    );
    expect(result.success).toBe(true);
    expect(handlerCalls).toBe(1);
  });
});
