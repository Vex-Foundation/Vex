/**
 * The Studio MCP tool context: least privilege, and wallet scope that fails
 * closed exactly like a session's.
 *
 * The context is the whole security posture of this surface - every gate
 * downstream reads it and nothing else. So each field that decides a gate is
 * pinned by name here, and the wallet contract is exercised through the REAL
 * resolver (`resolveSelectedEntry`), not restated.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { projectScopeSchema, type ProjectScope } from "@vex-agent/mcp/project-scope.js";
import {
  buildProjectToolContext,
  buildProjectWalletResolution,
} from "@vex-agent/mcp/project-context.js";

const getWalletById = vi.fn();

vi.mock("@tools/wallet/inventory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tools/wallet/inventory.js")>();
  return { ...actual, getWalletById: (...args: unknown[]) => getWalletById(...args) };
});

const { resolveSelectedEntry } = await import("@tools/wallet/multi-auth.js");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const EVM_ADDRESS = "0x1111111111111111111111111111111111111111";

function scope(overrides: Partial<ProjectScope> = {}): ProjectScope {
  return projectScopeSchema.parse({
    projectId: PROJECT_ID,
    scopeVersion: 1,
    permission: "restricted",
    backingSessionId: SESSION_ID,
    wallets: {
      evm: { id: "evm_1", address: EVM_ADDRESS },
      solana: null,
    },
    ...overrides,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("projectScopeSchema", () => {
  it("rejects an unknown key rather than dropping it", () => {
    const parsed = projectScopeSchema.safeParse({
      ...scope(),
      readOnly: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a scopeVersion below 1 and a non-integer version", () => {
    expect(projectScopeSchema.safeParse({ ...scope(), scopeVersion: 0 }).success).toBe(false);
    expect(projectScopeSchema.safeParse({ ...scope(), scopeVersion: 1.5 }).success).toBe(false);
  });

  it("rejects a wallet ref missing its address snapshot", () => {
    const parsed = projectScopeSchema.safeParse({
      ...scope(),
      wallets: { evm: { id: "evm_1" }, solana: null },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("buildProjectToolContext", () => {
  it("builds the least-privileged context, field by field", () => {
    const context = buildProjectToolContext(scope());

    expect(context.sessionId).toBe(SESSION_ID);
    expect(context.sourceSession).toBe(SESSION_ID);
    expect(context.sessionPermission).toBe("restricted");
    // Never pre-approved: approval is granted by the Vex privileged executor.
    expect(context.approved).toBe(false);
    // Everything on this surface was emitted by an external agent's model.
    expect(context.modelOriginated).toBe(true);
    expect(context.sourceSurface).toBe("mcp_local");
    expect(context.sessionKind).toBe("agent");
    expect(context.planMode).toBe(false);
    expect(context.contextUsageBand).toBe("normal");
    expect(context.missionId).toBeNull();
    expect(context.missionRunId).toBeNull();
    // No mission allowlist - NOT "no wallet".
    expect(context.walletPolicy).toEqual({ kind: "none" });
    expect(context.loadedDocuments.size).toBe(0);
    expect(context.abortSignal).toBeUndefined();
  });

  it("mirrors a full-permission project", () => {
    expect(buildProjectToolContext(scope({ permission: "full" })).sessionPermission).toBe("full");
  });

  it("carries the caller's abort signal when there is one", () => {
    const controller = new AbortController();
    const context = buildProjectToolContext(scope(), { abortSignal: controller.signal });
    expect(context.abortSignal).toBe(controller.signal);
  });
});

describe("project wallet resolution fails closed", () => {
  it("is always session-scoped", () => {
    expect(buildProjectWalletResolution(scope().wallets)).toEqual({
      source: "session",
      evm: { id: "evm_1", address: EVM_ADDRESS },
      solana: null,
    });
  });

  it("a null family refuses instead of falling back to the primary wallet", () => {
    const resolution = buildProjectWalletResolution(scope().wallets);
    expect(() => resolveSelectedEntry("solana", resolution)).toThrow(/No solana wallet is selected/);
    // The primary-wallet lookup is never even attempted.
    expect(getWalletById).not.toHaveBeenCalled();
  });

  it("address drift refuses", () => {
    getWalletById.mockReturnValue({
      id: "evm_1",
      address: "0x2222222222222222222222222222222222222222",
    });
    const resolution = buildProjectWalletResolution(scope().wallets);
    expect(() => resolveSelectedEntry("eip155", resolution)).toThrow(/address changed/);
  });

  it("a wallet that no longer exists refuses", () => {
    getWalletById.mockReturnValue(null);
    const resolution = buildProjectWalletResolution(scope().wallets);
    expect(() => resolveSelectedEntry("eip155", resolution)).toThrow(/no longer available/);
  });

  it("a matching selection resolves", () => {
    getWalletById.mockReturnValue({ id: "evm_1", address: EVM_ADDRESS });
    const resolution = buildProjectWalletResolution(scope().wallets);
    expect(resolveSelectedEntry("eip155", resolution).entry.id).toBe("evm_1");
  });
});
