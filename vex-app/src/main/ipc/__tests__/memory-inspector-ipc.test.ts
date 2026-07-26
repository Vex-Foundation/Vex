/**
 * Focused contract test for the `memoryInspector.*` channels (memory-system
 * S10).
 *
 * Mocks `memory-inspector-db` so we can assert the Result mapping without a
 * live DB:
 *   ok        → sanitized payload passed through
 *   db error  → error Result passed through unchanged
 *   bad input → validation.invalid_input (before the DB is touched)
 *
 * Also pins the READ-ONLY contract: the memoryInspector channel namespace has
 * exactly three read channels — the memory lifecycle is exclusively
 * manager-owned (S9), so no mutation channel may ever appear here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  listInspectorCandidates: vi.fn(),
  listInspectorDecisions: vi.fn(),
  getJobsSummary: vi.fn(),
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

vi.mock("../../database/memory-inspector-db.js", () => ({
  listInspectorCandidates: mocks.listInspectorCandidates,
  listInspectorDecisions: mocks.listInspectorDecisions,
  getJobsSummary: mocks.getJobsSummary,
}));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { registerMemoryInspectorHandlers } = await import(
  "../memory-inspector.js"
);
const { CH } = await import("@shared/ipc/channels.js");

const trustedSender = createTrustedSender({ sender: createTestWebContents() });

type ResultShape = {
  ok: boolean;
  data?: unknown;
  error?: { code: string; domain: string };
};

async function call(channel: string, payload: unknown): Promise<ResultShape> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`Handler not registered: ${channel}`);
  return (await fn(trustedSender, {
    requestId: "test-corr",
    payload,
  })) as ResultShape;
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  registerMemoryInspectorHandlers();
});

afterEach(() => {
  handlers.clear();
});

const ISO = "2026-05-21T10:00:00.000Z";
const UUID = "00000000-0000-4000-8000-0000000000c1";

const DB_ERROR = {
  code: "internal.unexpected",
  domain: "memory",
  message: "Unable to load memory inspector data.",
  retryable: true,
  userActionable: false,
  redacted: true,
} as const;

describe("memoryInspector.listCandidates handler", () => {
  it("passes the parsed input to the DB helper and returns its rows", async () => {
    mocks.listInspectorCandidates.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          id: UUID,
          kind: "risk_rule",
          title: "Avoid X",
          summary: "s",
          tags: [],
          source: "observed",
          confidence: null,
          importance: 5,
          sensitivity: "normal",
          evidenceStrength: "none",
          retrievalVisibility: "not_consolidated",
          status: "pending",
          recordedAt: ISO,
          promotedKnowledgeId: null,
          createdAt: ISO,
          updatedAt: ISO,
        },
      ],
    });
    const r = await call(CH.memoryInspector.listCandidates, {
      status: "pending",
      limit: 25,
    });
    expect(r.ok).toBe(true);
    expect(mocks.listInspectorCandidates).toHaveBeenCalledWith({
      status: "pending",
      limit: 25,
    });
  });

  it("passes a DB error Result through unchanged", async () => {
    mocks.listInspectorCandidates.mockResolvedValueOnce({
      ok: false,
      error: DB_ERROR,
    });
    const r = await call(CH.memoryInspector.listCandidates, { limit: 10 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("internal.unexpected");
    expect(r.error?.domain).toBe("memory");
  });

  it("rejects invalid input before touching the DB", async () => {
    const r = await call(CH.memoryInspector.listCandidates, { limit: -1 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("validation.invalid_input");
    expect(mocks.listInspectorCandidates).not.toHaveBeenCalled();
  });

  it("rejects an unknown status value", async () => {
    const r = await call(CH.memoryInspector.listCandidates, {
      status: "draft",
      limit: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("validation.invalid_input");
  });
});

describe("memoryInspector.listDecisions handler", () => {
  it("passes the parsed filters to the DB helper", async () => {
    mocks.listInspectorDecisions.mockResolvedValueOnce({ ok: true, data: [] });
    const r = await call(CH.memoryInspector.listDecisions, {
      candidateId: UUID,
      decisionType: "reject",
      limit: 25,
    });
    expect(r.ok).toBe(true);
    expect(mocks.listInspectorDecisions).toHaveBeenCalledWith({
      candidateId: UUID,
      decisionType: "reject",
      limit: 25,
    });
  });

  it("passes a DB error Result through unchanged", async () => {
    mocks.listInspectorDecisions.mockResolvedValueOnce({
      ok: false,
      error: DB_ERROR,
    });
    const r = await call(CH.memoryInspector.listDecisions, { limit: 10 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("internal.unexpected");
  });

  it("rejects a non-uuid candidateId before touching the DB", async () => {
    const r = await call(CH.memoryInspector.listDecisions, {
      candidateId: "nope",
      limit: 10,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("validation.invalid_input");
    expect(mocks.listInspectorDecisions).not.toHaveBeenCalled();
  });
});

describe("memoryInspector.jobsSummary handler", () => {
  it("returns the summary DTO and passes the parsed input", async () => {
    mocks.getJobsSummary.mockResolvedValueOnce({
      ok: true,
      data: {
        countsByStatus: {
          pending: 1,
          running: 0,
          completed: 0,
          failed: 0,
          permanently_failed: 0,
          retired: 0,
        },
        recentJobs: [],
      },
    });
    const r = await call(CH.memoryInspector.jobsSummary, { recentLimit: 20 });
    expect(r.ok).toBe(true);
    expect(mocks.getJobsSummary).toHaveBeenCalledWith({ recentLimit: 20 });
  });

  it("passes a DB error Result through unchanged", async () => {
    mocks.getJobsSummary.mockResolvedValueOnce({ ok: false, error: DB_ERROR });
    const r = await call(CH.memoryInspector.jobsSummary, { recentLimit: 20 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("internal.unexpected");
  });

  it("rejects an out-of-range recentLimit before touching the DB", async () => {
    const r = await call(CH.memoryInspector.jobsSummary, { recentLimit: 101 });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("validation.invalid_input");
    expect(mocks.getJobsSummary).not.toHaveBeenCalled();
  });
});

describe("read-only doctrine pin", () => {
  it("the memoryInspector namespace has exactly the three read channels and registers exactly those", () => {
    expect(Object.keys(CH.memoryInspector)).toEqual([
      "listCandidates",
      "listDecisions",
      "jobsSummary",
    ]);
    expect([...handlers.keys()].sort()).toEqual(
      [
        CH.memoryInspector.listCandidates,
        CH.memoryInspector.listDecisions,
        CH.memoryInspector.jobsSummary,
      ].sort(),
    );
  });
});
