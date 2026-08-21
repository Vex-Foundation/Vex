/**
 * Protocol wallet-scope (puzzle 5 phase 5D-protocols p5).
 *
 * The 5B hard-deny for user-wallet signing tools (actionKind
 * user_wallet_broadcast / external_post) under `source:"session"` was LIFTED in
 * p5: every protocol signer now resolves the session's selected wallet and fails
 * closed on an unselected family. So under a session, signing tools must now
 * REACH the handler (authorization = approval gate + handler-level resolution),
 * exactly like `read` tools and `source:"default"` always have.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
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
const captureValidator = await import("@vex-agent/tools/protocols/capture-validator.js");

function makeManifest(overrides: Partial<ProtocolToolManifest> = {}): ProtocolToolManifest {
  return {
    toolId: "test.fake",
    publicName: "test__fake",
    namespace: "khalani",
    lifecycle: "active",
    description: "fake",
    mutating: false,
    actionKind: "read",
    params: [],
    exampleParams: {},
    ...overrides,
  };
}

const SESSION_CTX = {
  sessionPermission: "full" as const,
  approved: true,
  sessionId: "s1",
  walletResolution: { source: "session" as const, evm: null, solana: null },
  walletPolicy: { kind: "none" as const },
};
const DEFAULT_CTX = {
  sessionPermission: "full" as const,
  approved: true,
  sessionId: "s1",
  walletResolution: { source: "default" as const },
  walletPolicy: { kind: "none" as const },
};

beforeEach(() => {
  vi.mocked(captureValidator.isPreviewExecution).mockReturnValue(false);
  vi.mocked(catalog.getProtocolManifest).mockReset();
  vi.mocked(catalog.getProtocolHandler).mockReset();
});

describe("protocol wallet-scope with signing handlers enabled", () => {
  for (const actionKind of ["user_wallet_broadcast", "external_post"] as const) {
    it(`no longer denies ${actionKind} under source:session — handler is reached`, async () => {
      vi.mocked(catalog.getProtocolManifest).mockReturnValue(
        makeManifest({ toolId: "x.sign", mutating: true, actionKind }),
      );
      const handler = vi.fn().mockResolvedValue({ success: true, output: "ok" });
      vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);

      const result = await executeProtocolTool({ toolId: "x.sign", params: {} }, SESSION_CTX);

      // The 5B hard-deny is gone: signing tools now reach the handler under a
      // session (the handler resolves the session wallet + fails closed itself).
      expect(handler).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.output).not.toContain("wallet-scoped session");
    });
  }

  it("no longer denies a PREVIEW of a signing tool under session", async () => {
    vi.mocked(captureValidator.isPreviewExecution).mockReturnValue(true);
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(
      makeManifest({ toolId: "x.sign", mutating: true, actionKind: "user_wallet_broadcast" }),
    );
    const handler = vi.fn().mockResolvedValue({ success: true, output: "ok" });
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);

    const result = await executeProtocolTool({ toolId: "x.sign", params: {} }, SESSION_CTX);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it("a read tool under session reaches the handler", async () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(
      makeManifest({ toolId: "x.read", actionKind: "read" }),
    );
    const handler = vi.fn().mockResolvedValue({ success: true, output: "ok" });
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);

    const result = await executeProtocolTool({ toolId: "x.read", params: {} }, SESSION_CTX);

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a signing tool under source:default reaches the handler", async () => {
    vi.mocked(catalog.getProtocolManifest).mockReturnValue(
      makeManifest({ toolId: "x.sign", mutating: true, actionKind: "user_wallet_broadcast" }),
    );
    const handler = vi.fn().mockResolvedValue({ success: true, output: "ok" });
    vi.mocked(catalog.getProtocolHandler).mockReturnValue(handler);

    const result = await executeProtocolTool({ toolId: "x.sign", params: {} }, DEFAULT_CTX);

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
