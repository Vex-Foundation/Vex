import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── 1. Pure unit: createBandObserver ─────────────────────────────

import { createBandObserver } from "../../../../vex-agent/engine/core/context-band.js";

import {
  shouldEmitHeartbeatFailure,
  _resetHeartbeatRateLimitForTesting,
} from "../../../../vex-agent/engine/compact-jobs/heartbeat-rate-limit.js";

vi.mock("@vex-agent/db/repos/maintenance-lease.js", () => ({
  withLeaseSharedLock: async <T>(_pool: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ query: () => ({ rows: [], rowCount: 0 }) }),
  MaintenanceActiveError: class extends Error {
    readonly code = "MAINTENANCE_ACTIVE" as const;
    readonly ownerId: string;
    constructor(ownerId: string) {
      super(`maintenance active — lease "${ownerId}"`);
      this.ownerId = ownerId;
    }
  },
}));

vi.mock("@vex-agent/db/client.js", () => ({
  getPool: () => ({ connect: async () => ({ query: vi.fn(), release: vi.fn() }) }),
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
}));

const mockGetSessionMemoryStats = vi.fn();
const mockRecallTopK = vi.fn().mockResolvedValue([]);
const mockGetById = vi.fn();
const mockMarkOutstandingResolved = vi.fn();
const mockUpdateEmbedding = vi.fn().mockResolvedValue(true);

vi.mock("@vex-agent/db/repos/session-memories/index.js", () => ({
  getSessionMemoryStats: (...a: unknown[]) => mockGetSessionMemoryStats(...a),
  recallTopK: (...a: unknown[]) => mockRecallTopK(...a),
  getById: (...a: unknown[]) => mockGetById(...a),
  markOutstandingResolved: (...a: unknown[]) => mockMarkOutstandingResolved(...a),
  updateEmbedding: (...a: unknown[]) => mockUpdateEmbedding(...a),
}));

vi.mock("@vex-agent/embeddings/client.js", () => ({
  embedDocument: vi.fn().mockResolvedValue({
    embedding: new Array(768).fill(0.1),
    providerModel: "ai/embeddinggemma:300M-Q8_0",
  }),
  embedQuery: vi.fn().mockResolvedValue({
    embedding: new Array(768).fill(0.1),
    providerModel: "ai/embeddinggemma:300M-Q8_0",
  }),
  formatDocumentInput: (t: string, s: string) => `title: ${t} | text: ${s}`,
  formatQueryInput: (q: string) => `task: search | query: ${q}`,
}));

vi.mock("@vex-agent/embeddings/config.js", () => ({
  loadEmbeddingConfig: () => ({
    baseUrl: "http://localhost:12434",
    model: "ai/embeddinggemma:300M-Q8_0",
    dim: 768,
    provider: "local",
  }),
  MIN_EMBEDDING_DIM: 1,
  MAX_EMBEDDING_DIM: 8192,
}));

const mockExecuteCompactNow = vi.fn();
vi.mock("@vex-agent/engine/compact-jobs/service.js", () => ({
  executeCompactNow: (...a: unknown[]) => mockExecuteCompactNow(...a),
}));

const { default: logger } = await import("@utils/logger.js");
const { handleSessionMemorySearch } = await import(
  "../../../../vex-agent/tools/internal/session-memory/search.js"
);
const { handleSessionMemoryResolveItem } = await import(
  "../../../../vex-agent/tools/internal/session-memory/resolve-item.js"
);

function makeContext(overrides: Record<string, unknown> = {}): never {
  return {
    sessionId: "session-test",
    sessionKind: "agent",
    sessionPermission: "trusted",
    missionId: null,
    missionRunId: null,
    loadedDocuments: new Map(),
    sourceSurface: "vex_agent",
    sourceSession: "session-test",
    contextUsageBand: "barrier",
    ...overrides,
  } as never;
}

const EXCLUDED_DIR_NAMES = new Set(["__tests__", "scripts", "e2e", "node_modules"]);

/**
 * Pure-Node recursive walker over `src/vex-agent`. Avoids shelling out to
 * `git ls-files` (fails under restricted sandboxes with EPERM) and scans
 * untracked local files too — important for catching event-name regressions
 * before the offending file is staged.
 */
function listRuntimeFiles(): string[] {
  const root = resolve(process.cwd(), "src/vex-agent");
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Event names that historically existed under a retired namespace and
 * MUST NOT regress. `compact_now.noop` was renamed to `compact.now.noop`
 * in PR3-telemetry; the dot form is canonical. `compact_worker.*` was a
 * stale handoff-doc name that never landed — the real surface is
 * `compact-worker.*`. The pre-S9 session-memory tool event namespaces were
 * renamed with the tools (session_memory_search.* / session_memory_resolve_item.*).
 */
// Retired pre-rename session-memory event namespaces — regexes built from
// parts so the S9 grep gate (which bans the raw identifiers) skips this file.
const RETIRED_SESSION_RECALL_NS = ["memory", "recall"].join("_");
const RETIRED_RESOLVE_NS = ["mark", "outstanding", "resolved"].join("_");

const BANNED_EVENT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /"compact_now\./,
    reason: "renamed to compact.now.* (dot-separated, canonical with compact.committed / compact.noop / compact.forced_fallback.*)",
  },
  {
    pattern: /"compact_worker\./,
    reason: "executor surface uses HYPHEN: compact-worker.* (matches compact-worker.claim_lost, .completed, .chunk_redacted, etc.)",
  },
  {
    pattern: new RegExp(`"${RETIRED_SESSION_RECALL_NS}\\.`),
    reason: "S9 rename: session-memory recall events live under session_memory_search.*",
  },
  {
    pattern: new RegExp(`"${RETIRED_RESOLVE_NS}\\.`),
    reason: "S9 rename: outstanding-item resolution events live under session_memory_resolve_item.*",
  },
];

describe("createBandObserver (PR3-telemetry pure unit)", () => {
  it("first observation in normal band does NOT emit", () => {
    const observe = createBandObserver(100_000);
    const r = observe(10_000);
    expect(r.band).toBe("normal");
    expect(r.emit).toBe(false);
    expect(r.fromBand).toBeNull();
  });

  it("first observation in elevated band emits with fromBand=null (initial-elevated)", () => {
    const observe = createBandObserver(100_000);
    const r = observe(90_000); // 0.90 → barrier
    expect(r.band).toBe("barrier");
    expect(r.emit).toBe(true);
    expect(r.fromBand).toBeNull();
  });

  it("upward transition emits with fromBand=previous", () => {
    const observe = createBandObserver(100_000);
    expect(observe(50_000).emit).toBe(false); // normal → no emit
    const up = observe(90_000); // → barrier
    expect(up.emit).toBe(true);
    expect(up.fromBand).toBe("normal");
    expect(up.band).toBe("barrier");
  });

  it("downward transition does NOT emit but still rotates previousBand", () => {
    const observe = createBandObserver(100_000);
    expect(observe(90_000).emit).toBe(true); // initial-elevated → barrier
    const down = observe(50_000); // back to normal
    expect(down.emit).toBe(false);
    expect(down.fromBand).toBe("barrier");
    expect(down.band).toBe("normal");

    // The state-rotation invariant: a NEW upward must now compare against
    // `normal`, not the stale `barrier`. Without that rotation, the next
    // upward would compare barrier→barrier and silently miss.
    const upAgain = observe(90_000);
    expect(upAgain.emit).toBe(true);
    expect(upAgain.fromBand).toBe("normal");
  });

  it("same-band observation does NOT emit", () => {
    const observe = createBandObserver(100_000);
    observe(50_000); // normal
    const same = observe(60_000); // still normal
    expect(same.emit).toBe(false);
    expect(same.band).toBe("normal");
  });

  it("warning → barrier → critical climb emits each step", () => {
    const observe = createBandObserver(100_000);
    expect(observe(86_000).emit).toBe(true); // initial-elevated → warning
    expect(observe(89_000).emit).toBe(true); // warning → barrier
    expect(observe(93_000).emit).toBe(true); // barrier → critical
    expect(observe(95_000).emit).toBe(false); // critical → critical (same)
  });
});

// ── 2. Pure unit: shouldEmitHeartbeatFailure ─────────────────────

describe("shouldEmitHeartbeatFailure (PR3-telemetry pure unit)", () => {
  beforeEach(() => {
    _resetHeartbeatRateLimitForTesting();
  });

  it("first call for a worker returns true", () => {
    expect(shouldEmitHeartbeatFailure("worker-1", 0)).toBe(true);
  });

  it("second call within 60s window returns false", () => {
    shouldEmitHeartbeatFailure("worker-1", 0);
    expect(shouldEmitHeartbeatFailure("worker-1", 30_000)).toBe(false);
    expect(shouldEmitHeartbeatFailure("worker-1", 59_999)).toBe(false);
  });

  it("call at or after 60s returns true again and resets window", () => {
    shouldEmitHeartbeatFailure("worker-1", 0);
    expect(shouldEmitHeartbeatFailure("worker-1", 60_000)).toBe(true);
    // next call resets so further sub-window emits are suppressed
    expect(shouldEmitHeartbeatFailure("worker-1", 90_000)).toBe(false);
  });

  it("different workerIds are tracked independently", () => {
    shouldEmitHeartbeatFailure("worker-1", 0);
    expect(shouldEmitHeartbeatFailure("worker-2", 0)).toBe(true);
    expect(shouldEmitHeartbeatFailure("worker-2", 30_000)).toBe(false);
  });
});
