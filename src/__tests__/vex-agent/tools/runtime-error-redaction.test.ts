/**
 * B-003 — provider/SDK error redaction in `executeProtocolTool`.
 *
 * A thrown handler error can embed URLs, request/response bodies, auth headers,
 * and key material. NONE of that may reach:
 *   - the tool `output` returned to the agent (and downstream to the renderer),
 *   - the structured `protocol.execute.failed` warn log,
 *   - the capture-failure warn log.
 *
 * The runtime must surface ONLY a coarse cause CATEGORY (`code`) plus a bounded,
 * redacted message. This suite injects an error carrying an API key, a bearer
 * token, a credential-bearing URL, and a body, then asserts none of those raw
 * fragments appear in the output or in any captured log payload.
 *
 * Mirrors the catalog/lifecycle/capture mock surface used by
 * `execute-tool-taxonomy.test.ts` so the runtime runs for real while its leaf
 * DB/capture dependencies are no-ops.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import logger from "@utils/logger.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";

vi.mock("@vex-agent/tools/protocols/capture-validator.js", () => ({
  isPreviewExecution: vi.fn(() => false),
  validateCaptureContract: vi.fn(() => true),
}));

vi.mock("@vex-agent/tools/protocols/catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/catalog.js")>();
  return { ...actual, getProtocolManifest: vi.fn(), getProtocolHandler: vi.fn() };
});

vi.mock("@vex-agent/tools/protocols/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/lifecycle.js")>();
  return { ...actual, isExecutableNamespace: vi.fn(() => true) };
});

vi.mock("@vex-agent/tools/protocols/capture-pipeline.js", () => ({
  extractExternalRefs: vi.fn(() => ({})),
  populateCaptureItems: vi.fn(),
}));
vi.mock("@vex-agent/db/repos/executions.js", () => ({ recordExecution: vi.fn().mockResolvedValue(0) }));
vi.mock("@vex-agent/db/repos/sync.js", () => ({
  getJobsForNamespace: vi.fn().mockResolvedValue([]),
  enqueueRun: vi.fn(),
}));
vi.mock("@vex-agent/db/params.js", () => ({ sanitizeJsonbValue: (v: unknown) => v }));

const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");
const catalog = await import("@vex-agent/tools/protocols/catalog.js");

// ── Fixtures ─────────────────────────────────────────────────────────

function readManifest(): ProtocolToolManifest {
  return {
    toolId: "test.redact.read",
    publicName: "test__redact_read",
    namespace: "khalani",
    lifecycle: "active",
    description: "throwing read tool",
    mutating: false,
    actionKind: "read",
    params: [],
    exampleParams: {},
  };
}

const ctx = {
  sessionPermission: "full" as const,
  approved: true,
  sessionId: "test-session",
  walletResolution: { source: "default" as const },
  walletPolicy: { kind: "none" as const },
};

// A realistic provider error that smuggles secrets + provider internals.
const API_KEY = "sk-or-v1-abcdef0123456789abcdef0123456789";
const BEARER_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
const CREDENTIAL_URL = "https://user:p4ssw0rd@api.provider.io/v1/chat?key=topsecret123456789012";
const RAW_BODY = `Provider 500 — POST ${CREDENTIAL_URL} Authorization: Bearer ${BEARER_JWT} apiKey=${API_KEY} body={"messages":[{"role":"user"}]}`;

const SECRET_FRAGMENTS = [
  API_KEY,
  BEARER_JWT,
  CREDENTIAL_URL,
  "p4ssw0rd",
  "topsecret123456789012",
  "Bearer ",
  "Authorization",
  "https://",
];

function serializeLogCalls(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => JSON.stringify(c)).join("\n");
}

describe("executeProtocolTool — B-003 raw error redaction", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    vi.mocked(catalog.getProtocolManifest).mockReset().mockReturnValue(readManifest());
    vi.mocked(catalog.getProtocolHandler).mockReset().mockReturnValue(async () => {
      throw new Error(RAW_BODY);
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns a failure output with NO raw secret/URL/body fragment", async () => {
    const result = await executeProtocolTool({ toolId: "test.redact.read", params: {} }, ctx);

    expect(result.success).toBe(false);
    expect(typeof result.output).toBe("string");
    for (const fragment of SECRET_FRAGMENTS) {
      expect(result.output).not.toContain(fragment);
    }
  });

  it("emits a bounded, categorized failure output (toolId + code + message only)", async () => {
    const result = await executeProtocolTool({ toolId: "test.redact.read", params: {} }, ctx);

    // Shape (W1, SPEC §1.5): `<toolId> failed [<CODE>/<category>{, HTTP n}]: <bounded message>`.
    expect(result.output).toMatch(/^test\.redact\.read failed \[[A-Za-z_]+\/[a-z_]+(?:, HTTP \d+)?\]: /);
    // Length stays bounded even when the raw error is large.
    expect((result.output ?? "").length).toBeLessThan(280);
  });

  it("never writes a raw secret/URL/body fragment into the protocol.execute.failed log", async () => {
    await executeProtocolTool({ toolId: "test.redact.read", params: {} }, ctx);

    const failedCall = warnSpy.mock.calls.find(
      (c) => c[0] === "protocol.execute.failed",
    );
    expect(failedCall).toBeDefined();
    const payload = failedCall?.[1] as Record<string, unknown> | undefined;
    // Redacted summary fields ONLY — code (category) + bounded message + toolId.
    expect(payload).toMatchObject({ toolId: "test.redact.read" });
    expect(typeof payload?.code).toBe("string");
    expect(payload).not.toHaveProperty("error"); // old raw `error` field is gone

    const serialized = serializeLogCalls(warnSpy);
    for (const fragment of SECRET_FRAGMENTS) {
      expect(serialized).not.toContain(fragment);
    }
  });
});
