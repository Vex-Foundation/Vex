/**
 * IPC contract tests for vex.support.createBugReport.
 *
 * Mirrors the register-handler test scaffolding: mock electron + logger +
 * cleanup + (here) the support service, then re-load the handler module.
 */

import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

// `vi.resetModules()` cold-loads the complete IPC/schema graph in each case;
// keep the behavioral assertions deterministic on slower CI filesystems.
vi.setConfig({ testTimeout: 15_000 });

type Handler = (
  event: { senderFrame?: MockFrame },
  raw: unknown,
) => unknown;

interface MockFrame {
  readonly url: string;
  readonly parent: MockFrame | null;
  readonly top: MockFrame | null;
}

const handlers = new Map<string, Handler>();
const cleanupTasks = new Set<() => void | Promise<void>>();
const serviceMock = vi.fn();
const openPathMock = vi.fn();
const mkdirMock = vi.fn();
const realpathMock = vi.fn();
const statMock = vi.fn();

/**
 * `resolveContainedLogsDir` builds its candidate with `path.join` and proves
 * containment with `path.sep`, so these fixtures are resolved and joined the
 * same way. A POSIX literal would make the realpath mock miss its key on
 * win32 (`\\fake\\user-data\\logs` never equals `/fake/user-data/logs`) and the
 * handler would report `internal.unexpected` for a reason that has nothing to
 * do with containment.
 */
const FAKE_USER_DATA = path.resolve("/fake/user-data");

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: {
    isPackaged: true,
    getPath: () => FAKE_USER_DATA,
  },
  shell: {
    openPath: (target: string) => openPathMock(target),
  },
}));

// `support.ts` is the only module in this import graph that touches node:fs
// (containment for openLogsFolder).
vi.mock("node:fs", () => ({
  promises: {
    mkdir: (...args: unknown[]) => mkdirMock(...args),
    realpath: (...args: unknown[]) => realpathMock(...args),
    stat: (...args: unknown[]) => statMock(...args),
  },
}));

vi.mock("../../logger/index.js", () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    silly: vi.fn(),
  },
}));

vi.mock("../../lifecycle/cleanup-registry.js", () => ({
  globalCleanup: {
    add: (task: () => void | Promise<void>) => {
      cleanupTasks.add(task);
      return async () => {
        cleanupTasks.delete(task);
        await task();
      };
    },
  },
}));

vi.mock("../../support/bug-report-service.js", () => ({
  createBugReport: (input: unknown) => serviceMock(input),
}));

function senderFrame(url: string): { senderFrame: MockFrame } {
  const frame: MockFrame & { parent: MockFrame | null; top: MockFrame | null } = {
    url,
    parent: null,
    top: null,
  };
  frame.top = frame;
  return { senderFrame: frame };
}

const trustedSender = senderFrame("app://vex/index.html");

const validPayload = {
  reportKind: "manual" as const,
  source: "user" as const,
  category: "user_reported_bug",
  severity: "error" as const,
  title: "Something broke",
  description: "",
  context: {},
  refs: {},
};

async function loadAndRegister(
  channel = "vex:support:createBugReport",
): Promise<Handler> {
  vi.resetModules();
  const mod = await import("../support.js");
  mod.registerSupportHandler();
  const fn = handlers.get(channel);
  if (!fn) throw new Error("handler not registered");
  return fn;
}

// Real UUIDs because the output schema enforces `z.string().uuid()` — the
// envelope tolerates any non-empty requestId, but the success path's
// outputSchema validation runs on the handler's reply and will reject a
// non-UUID `reportId`.
const REQ_1 = "11111111-1111-4111-8111-111111111111";
const REQ_2 = "22222222-2222-4222-8222-222222222222";
const REQ_3 = "33333333-3333-4333-8333-333333333333";
const REQ_4 = "44444444-4444-4444-8444-444444444444";
const REPORT_UUID = "55555555-5555-4555-8555-555555555555";

describe("registerSupportHandler", () => {
  beforeEach(() => {
    handlers.clear();
    cleanupTasks.clear();
    serviceMock.mockReset();
  });

  it("returns ok with the service result on valid input", async () => {
    serviceMock.mockResolvedValueOnce({
      reportId: REPORT_UUID,
      recorded: true,
      uploadState: "not_configured",
    });
    const fn = await loadAndRegister();
    const result = await fn(trustedSender, {
      requestId: REQ_1,
      payload: validPayload,
    });
    expect(result).toEqual({
      ok: true,
      data: {
        reportId: REPORT_UUID,
        recorded: true,
        uploadState: "not_configured",
      },
    });
    expect(serviceMock).toHaveBeenCalledTimes(1);
    const arg = serviceMock.mock.calls[0]?.[0] as { correlationIdFromIpc: string };
    expect(arg.correlationIdFromIpc).toBe(REQ_1);
  });

  it("rejects an invalid category at the schema boundary", async () => {
    const fn = await loadAndRegister();
    const result = (await fn(trustedSender, {
      requestId: REQ_2,
      payload: { ...validPayload, category: "Bug" },
    })) as { ok: false; error: { code: string; domain: string; correlationId: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("validation.invalid_input");
    expect(result.error.domain).toBe("support");
    // registerHandler stamps a fresh fallback correlationId when the whole
    // envelope (incl. payload) fails to parse — `requestId` is not recovered
    // from a partially-valid envelope. Assert shape, not equality.
    expect(typeof result.error.correlationId).toBe("string");
    expect(result.error.correlationId.length).toBeGreaterThan(0);
    expect(serviceMock).not.toHaveBeenCalled();
  });

  it("rejects an untrusted sender frame", async () => {
    const fn = await loadAndRegister();
    const result = (await fn(senderFrame("https://evil.example/"), {
      requestId: REQ_3,
      payload: validPayload,
    })) as { ok: false; error: { code: string; domain: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("validation.invalid_sender");
    expect(result.error.domain).toBe("support");
    expect(serviceMock).not.toHaveBeenCalled();
  });

  it("maps a thrown service error to support.persist_failed", async () => {
    serviceMock.mockRejectedValueOnce(new Error("db down"));
    const fn = await loadAndRegister();
    const result = (await fn(trustedSender, {
      requestId: REQ_4,
      payload: validPayload,
    })) as { ok: false; error: { code: string; domain: string; correlationId: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("support.persist_failed");
    expect(result.error.domain).toBe("support");
    expect(result.error.correlationId).toBe(REQ_4);
  });
});

// ── openLogsFolder (error-diagnostics plan D-FOLDER / §3.6) ──────────────────

const REQ_5 = "55555555-aaaa-4aaa-8aaa-555555555555";
const REAL_USER_DATA = path.resolve("/real/user-data");
const REAL_LOGS_DIR = path.join(REAL_USER_DATA, "logs");

describe("registerSupportHandler - openLogsFolder", () => {
  beforeEach(() => {
    handlers.clear();
    cleanupTasks.clear();
    openPathMock.mockReset().mockResolvedValue("");
    mkdirMock.mockReset().mockResolvedValue(undefined);
    statMock.mockReset().mockResolvedValue({ isDirectory: () => true });
    // Default: containment holds — logs dir resolves inside userData.
    realpathMock.mockReset().mockImplementation(async (p: unknown) => {
      if (p === FAKE_USER_DATA) return REAL_USER_DATA;
      if (p === path.join(FAKE_USER_DATA, "logs")) return REAL_LOGS_DIR;
      throw new Error(`unexpected realpath: ${String(p)}`);
    });
  });

  it("opens the realpath-resolved logs dir and returns {opened:true} (output schema)", async () => {
    const fn = await loadAndRegister("vex:support:openLogsFolder");
    const result = await fn(trustedSender, { requestId: REQ_5, payload: {} });
    expect(result).toEqual({ ok: true, data: { opened: true } });
    // mkdir ensures the dir exists before realpath.
    expect(mkdirMock).toHaveBeenCalledWith(path.join(FAKE_USER_DATA, "logs"), {
      recursive: true,
    });
    // shell.openPath receives the RESOLVED path, never the joined candidate.
    expect(openPathMock).toHaveBeenCalledTimes(1);
    expect(openPathMock).toHaveBeenCalledWith(REAL_LOGS_DIR);
  });

  it("rejects when realpath escapes userData (symlink traversal) - openPath never called", async () => {
    realpathMock.mockImplementation(async (p: unknown) => {
      if (p === FAKE_USER_DATA) return REAL_USER_DATA;
      // Symlink swap: logs dir resolves OUTSIDE userData.
      return path.resolve("/evil/elsewhere");
    });
    const fn = await loadAndRegister("vex:support:openLogsFolder");
    const result = (await fn(trustedSender, {
      requestId: REQ_5,
      payload: {},
    })) as { ok: false; error: { code: string; domain: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("internal.unexpected");
    expect(result.error.domain).toBe("support");
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it("rejects when the resolved path is not a directory", async () => {
    statMock.mockResolvedValue({ isDirectory: () => false });
    const fn = await loadAndRegister("vex:support:openLogsFolder");
    const result = (await fn(trustedSender, {
      requestId: REQ_5,
      payload: {},
    })) as { ok: false; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("internal.unexpected");
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it("maps a shell.openPath failure message to internal.unexpected", async () => {
    openPathMock.mockResolvedValue("no file manager available");
    const fn = await loadAndRegister("vex:support:openLogsFolder");
    const result = (await fn(trustedSender, {
      requestId: REQ_5,
      payload: {},
    })) as { ok: false; error: { code: string; domain: string; correlationId: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("internal.unexpected");
    expect(result.error.domain).toBe("support");
    expect(result.error.correlationId).toBe(REQ_5);
  });

  it("rejects a non-empty payload at the schema boundary (strict empty input)", async () => {
    const fn = await loadAndRegister("vex:support:openLogsFolder");
    const result = (await fn(trustedSender, {
      requestId: REQ_5,
      payload: { path: "/etc" },
    })) as { ok: false; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("validation.invalid_input");
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it("rejects an untrusted sender frame", async () => {
    const fn = await loadAndRegister("vex:support:openLogsFolder");
    const result = (await fn(senderFrame("https://evil.example/"), {
      requestId: REQ_5,
      payload: {},
    })) as { ok: false; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("validation.invalid_sender");
    expect(openPathMock).not.toHaveBeenCalled();
  });
});
