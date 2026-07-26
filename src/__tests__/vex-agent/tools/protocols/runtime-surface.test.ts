/**
 * Façade-surface guard for the protocol-runtime structural split (A-003).
 *
 * `src/vex-agent/tools/protocols/runtime.ts` was split into sibling modules
 * under `./runtime/` (params, errors, gates, capture) while the original path
 * stays a compatibility façade. This test pins the EXACT public runtime surface
 * so a later edit cannot silently drop, rename, or add an export. The behavior
 * of `executeProtocolTool` is covered by the dedicated runtime-*.test.ts suites
 * (redaction, type-validation, prequote-gate, wallet-scope); here we only assert
 * presence + runtime typeof + the exact export-key set, plus a tiny pin on the
 * `protocol.execute.capture_failed` redaction path the split must preserve.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import logger from "@utils/logger.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";

// ── Surface pins (no mocks needed) ───────────────────────────────────

import * as runtimeFacade from "../../../../vex-agent/tools/protocols/runtime.js";

// Type-only imports must compile against the façade re-exports. The runtime
// façade exports only values (no types); we pin the value-import surface and
// rely on `tsc --noEmit` to reject any signature drift in these named imports.
import {
  executeProtocolTool,
  discoverProtocolCapabilities,
} from "../../../../vex-agent/tools/protocols/runtime.js";

describe("protocol runtime façade — public surface", () => {
  it("exposes every expected export with the correct runtime typeof", () => {
    expect(typeof executeProtocolTool).toBe("function");
    expect(typeof discoverProtocolCapabilities).toBe("function");
  });

  it("named re-exports are identity-equal to the namespace import", () => {
    expect(runtimeFacade.executeProtocolTool).toBe(executeProtocolTool);
    expect(runtimeFacade.discoverProtocolCapabilities).toBe(discoverProtocolCapabilities);
  });

  it("exports EXACTLY the expected runtime keys — no more, no less", () => {
    const keys = Object.keys(runtimeFacade).sort();
    expect(keys).toEqual(
      [
        "executeProtocolTool",
        "discoverProtocolCapabilities",
      ].sort(),
    );
  });
});

// ── Capture-failure redaction pin (Codex suggestion) ─────────────────
//
// Mirrors the mock surface of `runtime-error-redaction.test.ts`, but exercises
// the `protocol.execute.capture_failed` branch: a MUTATING tool whose handler
// SUCCEEDS but whose capture (DB recordExecution) throws a credential-bearing
// error. The split must keep that error redacted via `summarizeProtocolError`.

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
// recordExecution throws a credential-bearing error to drive capture_failed.
// vi.hoisted: the factory below is hoisted ABOVE a plain `const`, so the URL
// must be hoisted with it (plain top-level consts hit the TDZ — vitest's
// "no top level variables inside vi.mock" rule).
const CAPTURE_URL = vi.hoisted(() => "postgres://user:p4ssw0rd@db.internal:5432/vex?sslmode=require");
vi.mock("@vex-agent/db/repos/executions.js", () => ({
  recordExecution: vi.fn().mockRejectedValue(new Error(`capture insert failed at ${CAPTURE_URL}`)),
}));
vi.mock("@vex-agent/db/repos/sync.js", () => ({
  getJobsForNamespace: vi.fn().mockResolvedValue([]),
  enqueueRun: vi.fn(),
}));
vi.mock("@vex-agent/db/params.js", () => ({ sanitizeJsonbValue: (v: unknown) => v }));

const { executeProtocolTool: executeWithMocks } = await import("@vex-agent/tools/protocols/runtime.js");
const catalog = await import("@vex-agent/tools/protocols/catalog.js");

function mutatingManifest(): ProtocolToolManifest {
  return {
    toolId: "test.capture.mutate",
    namespace: "khalani",
    lifecycle: "active",
    description: "successful mutating tool with failing capture",
    mutating: true,
    actionKind: "external_post",
    params: [],
    exampleParams: {},
  };
}

const mutatingCtx = {
  sessionPermission: "full" as const,
  approved: true,
  sessionId: "test-session",
  walletResolution: { source: "default" as const },
  walletPolicy: { kind: "none" as const },
};

describe("executeProtocolTool — capture_failed redaction (A-003 split pin)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    vi.spyOn(logger, "info").mockImplementation(() => logger as never);
    vi.mocked(catalog.getProtocolManifest).mockReset().mockReturnValue(mutatingManifest());
    vi.mocked(catalog.getProtocolHandler).mockReset().mockReturnValue(async () => ({
      success: true,
      output: "ok",
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts the credential-bearing capture error in protocol.execute.capture_failed", async () => {
    const result = await executeWithMocks({ toolId: "test.capture.mutate", params: {} }, mutatingCtx);

    // Handler succeeded — capture failure must NOT change the success result.
    expect(result.success).toBe(true);

    const captureCall = warnSpy.mock.calls.find((c) => c[0] === "protocol.execute.capture_failed");
    expect(captureCall).toBeDefined();
    const payload = captureCall?.[1] as Record<string, unknown> | undefined;
    expect(payload).toMatchObject({ toolId: "test.capture.mutate" });
    expect(typeof payload?.code).toBe("string");

    // No raw credential/URL fragment anywhere in the captured log payloads.
    const serialized = warnSpy.mock.calls.map((c) => JSON.stringify(c)).join("\n");
    expect(serialized).not.toContain(CAPTURE_URL);
    expect(serialized).not.toContain("p4ssw0rd");
    expect(serialized).not.toContain("postgres://");
  });
});
