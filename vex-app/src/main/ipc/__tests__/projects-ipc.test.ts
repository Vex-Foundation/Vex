/**
 * Contract tests for the five `vex:projects:*` channels.
 *
 * Each channel is driven through the real `registerHandler` boundary with a
 * scripted DB owner, covering the four paths every IPC surface owes:
 *   positive, invalid input, unauthorized sender, cancellation.
 *
 * Also pinned here, because they are the trust properties of this domain:
 *   - wallet ids are resolved SERVER-SIDE and an unknown id fails closed with
 *     nothing created or edited;
 *   - the renderer cannot supply a slug, a path, or a wallet address - the
 *     strict schemas reject every one of those keys by name;
 *   - `updateScope` requires an `expectedScopeVersion` and at least one field.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMainFrame,
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  getProject: vi.fn(),
  listProjects: vi.fn(),
  updateProjectScope: vi.fn(),
  renderProjectFiles: vi.fn(),
  enrichProjectFiles: vi.fn(),
  resolveWalletRef: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: { isPackaged: true },
}));

vi.mock("../../database/projects/create.js", () => ({
  createProject: mocks.createProject,
}));
vi.mock("../../database/projects/read.js", () => ({
  getProject: mocks.getProject,
  listProjects: mocks.listProjects,
}));
vi.mock("../../database/projects/scope.js", () => ({
  updateProjectScope: mocks.updateProjectScope,
}));
vi.mock("../_wallet-refs.js", async () => {
  const actual = await vi.importActual<typeof import("../_wallet-refs.js")>(
    "../_wallet-refs.js",
  );
  return { ...actual, resolveWalletRef: mocks.resolveWalletRef };
});
vi.mock("../../studio/installer.js", () => ({
  renderProjectFiles: mocks.renderProjectFiles,
  enrichProjectFiles: mocks.enrichProjectFiles,
}));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { registerProjectsHandlers } = await import("../projects/index.js");
const { CH } = await import("@shared/ipc/channels.js");
const { getCancelController } = await import("../register-handler.js");

const trustedSender = createTrustedSender({ sender: createTestWebContents() });
const untrustedSender = { senderFrame: createMainFrame("https://evil.example/") };

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

const DTO = {
  id: PROJECT_ID,
  name: "My App",
  slug: "my-app",
  rootPath: "my-app",
  displayPath: "~/Vex/projects/my-app",
  permission: "restricted" as const,
  agents: ["claude-code" as const],
  wallets: { evm: null, solana: null },
  scopeVersion: 1,
  backingSessionId: SESSION_ID,
  files: {
    lastRenderedScopeVersion: null,
    generatorFingerprint: null,
    artifacts: [],
  },
  createdAt: "2026-08-23T10:00:00.000Z",
  updatedAt: "2026-08-23T10:00:00.000Z",
};

const RENDER = {
  scopeVersion: 2,
  completed: true,
  trigger: "scope_update" as const,
  artifacts: [],
  warnings: [],
};

type ResultShape = {
  ok: boolean;
  data?: unknown;
  error?: { code: string; domain: string; redacted?: boolean; message?: string };
};

async function call(
  channel: string,
  payload: unknown,
  options: { sender?: unknown; requestId?: string } = {},
): Promise<ResultShape> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`Handler not registered: ${channel}`);
  return (await fn((options.sender ?? trustedSender) as TestIpcEvent, {
    requestId: options.requestId ?? REQUEST_ID,
    payload,
  })) as ResultShape;
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  mocks.resolveWalletRef.mockReturnValue(null);
  mocks.createProject.mockResolvedValue({ ok: true, data: DTO });
  mocks.getProject.mockResolvedValue({ ok: true, data: DTO });
  mocks.listProjects.mockResolvedValue({ ok: true, data: [DTO] });
  mocks.updateProjectScope.mockResolvedValue({
    ok: true,
    data: { ...DTO, scopeVersion: 2 },
  });
  mocks.renderProjectFiles.mockResolvedValue({ ok: true, data: RENDER });
  // The disk half is the installer's job and has its own suites; here it is
  // stubbed to the DTO's own value so these tests stay about the IPC contract.
  mocks.enrichProjectFiles.mockImplementation(
    async (project: { files: unknown }) => project.files,
  );
  registerProjectsHandlers();
});

afterEach(() => {
  handlers.clear();
});

const CHANNELS = [
  { channel: CH.projects.create, payload: { name: "My App", permission: "restricted" } },
  { channel: CH.projects.get, payload: { projectId: PROJECT_ID } },
  { channel: CH.projects.list, payload: {} },
  {
    channel: CH.projects.updateScope,
    payload: {
      projectId: PROJECT_ID,
      expectedScopeVersion: 1,
      permission: "full",
    },
  },
  { channel: CH.projects.repairFiles, payload: { projectId: PROJECT_ID } },
] as const;

describe("vex:projects:* - registration and the shared boundary paths", () => {
  it("registers exactly the five declared channels", () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        CH.projects.create,
        CH.projects.get,
        CH.projects.list,
        CH.projects.updateScope,
        CH.projects.repairFiles,
      ].sort(),
    );
  });

  it("has NO delete channel: A5 never deletes a user's files", () => {
    expect(Object.keys(CH.projects)).not.toContain("delete");
    expect([...handlers.keys()].some((c) => c.includes("delete"))).toBe(false);
  });

  it.each(CHANNELS)("$channel rejects an untrusted sender", async ({ channel, payload }) => {
    const r = await call(channel, payload, { sender: untrustedSender });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("validation.invalid_sender");
    expect(r.error?.redacted).toBe(true);
    // The origin never appears in the public error payload.
    expect(JSON.stringify(r.error)).not.toContain("evil.example");
    // And nothing reached the DB owner.
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.updateProjectScope).not.toHaveBeenCalled();
    expect(mocks.getProject).not.toHaveBeenCalled();
    expect(mocks.listProjects).not.toHaveBeenCalled();
  });

  it.each(CHANNELS)(
    "$channel normalises a cancelled request to internal.cancelled",
    async ({ channel, payload }) => {
      const owners = [
        mocks.createProject,
        mocks.getProject,
        mocks.listProjects,
        mocks.updateProjectScope,
        mocks.renderProjectFiles,
      ];
      // Abort while the owner is in flight, exactly as `vex:cancel` would.
      for (const owner of owners) {
        owner.mockImplementation(async () => {
          getCancelController(REQUEST_ID)?.abort();
          return {
            ok: false,
            error: {
              code: "internal.unexpected",
              domain: "projects",
              message: "interrupted",
              retryable: true,
              userActionable: false,
              redacted: true,
              correlationId: REQUEST_ID,
            },
          };
        });
      }
      const r = await call(channel, payload);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("internal.cancelled");
    },
  );
});

describe("vex:projects:create", () => {
  it("creates a project and returns the persisted DTO", async () => {
    const r = await call(CH.projects.create, {
      name: "My App",
      permission: "restricted",
      agents: ["claude-code"],
      wallets: { evm: null, solana: null },
    });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual(DTO);
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
  });

  it("applies schema defaults so an omitted roster and selection are explicit", async () => {
    await call(CH.projects.create, { name: "My App", permission: "full" });
    const [input] = mocks.createProject.mock.calls[0] as [
      { agents: unknown; wallets: unknown },
    ];
    expect(input.agents).toEqual([]);
    expect(input.wallets).toEqual({ evm: null, solana: null });
  });

  it.each([
    ["an empty name", { name: "", permission: "restricted" }],
    ["a name over 80 characters", { name: "a".repeat(81), permission: "restricted" }],
    ["an unknown permission", { name: "My App", permission: "root" }],
    ["an unknown agent id", { name: "My App", permission: "full", agents: ["skynet"] }],
    // The renderer cannot choose the folder name...
    ["a caller-supplied slug", { name: "My App", permission: "full", slug: "../escape" }],
    // ...nor a path...
    ["a caller-supplied path", { name: "My App", permission: "full", rootPath: "/etc" }],
    // ...nor a wallet ADDRESS: main resolves ids to addresses itself.
    [
      "a caller-supplied wallet address",
      {
        name: "My App",
        permission: "full",
        wallets: { evm: { id: "evm_1", address: "0xAttacker" }, solana: null },
      },
    ],
  ])("rejects %s before touching the DB", async (_label, payload) => {
    const r = await call(CH.projects.create, payload);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("validation.invalid_input");
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("fails closed on a wallet id main does not own, creating nothing", async () => {
    mocks.resolveWalletRef.mockReturnValue("invalid");
    const r = await call(CH.projects.create, {
      name: "My App",
      permission: "full",
      wallets: { evm: "evm_ghost", solana: null },
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("wallets.invalid_selection");
    expect(r.error?.domain).toBe("projects");
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("passes a DB refusal through by name rather than as an unexpected error", async () => {
    mocks.createProject.mockResolvedValue({
      ok: false,
      error: {
        code: "projects.slug_taken",
        domain: "projects",
        message: 'A folder named "my-app" already exists in your Vex Studio projects.',
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId: REQUEST_ID,
      },
    });
    const r = await call(CH.projects.create, { name: "My App", permission: "full" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("projects.slug_taken");
    expect(r.error?.message).toContain("my-app");
  });
});

describe("vex:projects:get and vex:projects:list", () => {
  it("returns the project for a known id", async () => {
    const r = await call(CH.projects.get, { projectId: PROJECT_ID });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual(DTO);
  });

  it("returns null for an unknown id rather than an error", async () => {
    mocks.getProject.mockResolvedValue({ ok: true, data: null });
    const r = await call(CH.projects.get, { projectId: PROJECT_ID });
    expect(r.ok).toBe(true);
    expect(r.data).toBeNull();
  });

  it("rejects a non-uuid project id", async () => {
    const r = await call(CH.projects.get, { projectId: "../../etc/passwd" });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("validation.invalid_input");
    expect(mocks.getProject).not.toHaveBeenCalled();
  });

  it("lists projects and rejects unknown keys on the empty input", async () => {
    const listed = await call(CH.projects.list, {});
    expect(listed.ok).toBe(true);
    expect(listed.data).toEqual([DTO]);

    const withJunk = await call(CH.projects.list, { limit: 5 });
    expect(withJunk.ok).toBe(false);
    expect(withJunk.error?.code).toBe("validation.invalid_input");
  });
});

describe("vex:projects:updateScope", () => {
  it("applies a permission edit and returns the bumped scope version", async () => {
    const r = await call(CH.projects.updateScope, {
      projectId: PROJECT_ID,
      expectedScopeVersion: 1,
      permission: "full",
    });
    expect(r.ok).toBe(true);
    expect((r.data as { project: { scopeVersion: number } }).project.scopeVersion).toBe(2);
    // No wallet edit means the owner is told so explicitly, not left to guess.
    expect(mocks.updateProjectScope.mock.calls[0]?.[1]).toBeNull();
  });

  it("resolves wallet ids server-side before the transaction", async () => {
    mocks.resolveWalletRef.mockReturnValue({ id: "evm_1", address: "0xResolved" });
    await call(CH.projects.updateScope, {
      projectId: PROJECT_ID,
      expectedScopeVersion: 1,
      wallets: { evm: "evm_1", solana: null },
    });
    expect(mocks.updateProjectScope.mock.calls[0]?.[1]).toEqual({
      evm: { id: "evm_1", address: "0xResolved" },
      solana: { id: "evm_1", address: "0xResolved" },
    });
  });

  it("fails closed on an unknown wallet id, editing nothing", async () => {
    mocks.resolveWalletRef.mockReturnValue("invalid");
    const r = await call(CH.projects.updateScope, {
      projectId: PROJECT_ID,
      expectedScopeVersion: 1,
      wallets: { evm: "evm_ghost", solana: null },
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("wallets.invalid_selection");
    expect(mocks.updateProjectScope).not.toHaveBeenCalled();
  });

  it.each([
    // Optimistic concurrency is mandatory: no version, no edit.
    ["a missing expectedScopeVersion", { projectId: PROJECT_ID, permission: "full" }],
    ["a zero expectedScopeVersion", { projectId: PROJECT_ID, expectedScopeVersion: 0, permission: "full" }],
    // An edit that changes nothing would still burn a scope version.
    ["an edit with no fields", { projectId: PROJECT_ID, expectedScopeVersion: 1 }],
    [
      "an attempt to rename through the scope surface",
      { projectId: PROJECT_ID, expectedScopeVersion: 1, name: "Renamed" },
    ],
    [
      "an attempt to move the project through the scope surface",
      { projectId: PROJECT_ID, expectedScopeVersion: 1, rootPath: "elsewhere" },
    ],
    [
      "an attempt to set scopeVersion directly",
      { projectId: PROJECT_ID, expectedScopeVersion: 1, scopeVersion: 99 },
    ],
  ])("rejects %s", async (_label, payload) => {
    const r = await call(CH.projects.updateScope, payload);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("validation.invalid_input");
    expect(mocks.updateProjectScope).not.toHaveBeenCalled();
  });

  it("surfaces a scope conflict by name so the caller re-reads instead of retrying", async () => {
    mocks.updateProjectScope.mockResolvedValue({
      ok: false,
      error: {
        code: "projects.scope_conflict",
        domain: "projects",
        message: "The project settings changed while you were editing them.",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId: REQUEST_ID,
      },
    });
    const r = await call(CH.projects.updateScope, {
      projectId: PROJECT_ID,
      expectedScopeVersion: 1,
      permission: "full",
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("projects.scope_conflict");
  });
});
