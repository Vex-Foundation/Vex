/**
 * The dispatcher's GENERIC fallback catch — the last place a thrown value can
 * become agent-facing text (Codex final review, non-blocking 4).
 *
 * This catch is the one that never knows which venue threw, so it cannot rely
 * on a venue-local sanitizer having run first. Interpolating `err.message` raw
 * here would let an SDK error carrying a URL, a request/response body or an
 * auth header reach the model AND the structured logs. It now routes through
 * `summarizeProtocolError` / `renderProtocolFailureOutput`, the canonical
 * scrub → classify → remediate → render pipeline every venue already uses.
 *
 * Defence in depth: reviewed venue paths already sanitize before throwing.
 * These canaries pin that the fallback does not depend on them doing so.
 *
 * Scope note: the model-originated `execute_tool` rejection and the operator
 * Stop branch are deliberately NOT touched here — both return their own
 * purpose-built text and return BEFORE this fallback.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import { makeTestContext } from "./_test-context.js";

const routeToolCall = vi.fn();
const checkPressureDeny = vi.fn();
const checkPlanAcceptanceDeny = vi.fn();

vi.mock("../../../vex-agent/tools/dispatcher/protocol-route.js", () => ({
  routeToolCall: (...args: unknown[]) => routeToolCall(...args),
}));
vi.mock("../../../vex-agent/tools/dispatcher/pressure-gate.js", () => ({
  checkPressureDeny: (...args: unknown[]) => checkPressureDeny(...args),
}));
vi.mock("../../../vex-agent/tools/dispatcher/plan-acceptance-gate.js", () => ({
  checkPlanAcceptanceDeny: (...args: unknown[]) => checkPlanAcceptanceDeny(...args),
}));
vi.mock("../../../vex-agent/tools/dispatcher/mutating-targets.js", () => ({
  dispatchTargetIsMutating: vi.fn(() => false),
}));
vi.mock("../../../vex-agent/tools/dispatcher/internal-loaders.js", () => ({
  INTERNAL_TOOL_LOADERS: {},
}));

const { dispatchTool } = await import("../../../vex-agent/tools/dispatcher.js");

const CALL = { name: "web_research", args: { query: "x" }, toolCallId: "tc-1" };
const CONTEXT: InternalToolContext = makeTestContext({ sessionId: "s1" });

beforeEach(() => {
  vi.clearAllMocks();
  checkPressureDeny.mockReturnValue(undefined);
  checkPlanAcceptanceDeny.mockResolvedValue(undefined);
});

describe("dispatcher generic fallback — sanitized, never raw", () => {
  it("strips a provider URL with an embedded API key out of the agent-facing output", async () => {
    routeToolCall.mockRejectedValue(
      new Error("request to https://api.example.com/v1/quote?apiKey=sk-live-DEADBEEF0123456789 failed"),
    );

    const result = await dispatchTool(CALL, CONTEXT);

    expect(result.success).toBe(false);
    expect(result.output).not.toContain("sk-live-DEADBEEF0123456789");
    expect(result.output).not.toContain("api.example.com");
    expect(result.output).not.toContain("https://");
  });

  it("strips an Authorization header echoed back inside a thrown provider error", async () => {
    routeToolCall.mockRejectedValue(
      new Error('upstream rejected: {"headers":{"Authorization":"Bearer sk-live-SECRETTOKENVALUE"}}'),
    );

    const result = await dispatchTool(CALL, CONTEXT);

    expect(result.success).toBe(false);
    expect(result.output).not.toContain("sk-live-SECRETTOKENVALUE");
  });

  it("still NAMES the tool and a real cause — sanitizing must not become silencing", async () => {
    // Rule 04's truthful-tool-error decree: a generic label on a diagnosable
    // failure makes the agent retry blind and wastes the user's money.
    routeToolCall.mockRejectedValue(new Error("insufficient funds for gas * price + value"));

    const result = await dispatchTool(CALL, CONTEXT);

    expect(result.success).toBe(false);
    expect(result.output).toContain("web_research");
    expect(result.output.toLowerCase()).toContain("insufficient funds");
    expect(result.output.toLowerCase()).not.toContain("unexpected error");
  });

  it("bounds the output — an enormous thrown blob cannot flood the transcript", async () => {
    routeToolCall.mockRejectedValue(new Error("x".repeat(50_000)));

    const result = await dispatchTool(CALL, CONTEXT);

    expect(result.success).toBe(false);
    expect(result.output.length).toBeLessThan(2_000);
  });
});
