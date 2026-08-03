import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
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
    let entries: Dirent<string>[];
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

describe("knowledge telemetry retired (S9 cutover)", () => {
  // The agent-facing knowledge_* tool surface was deleted in S9, taking the
  // `knowledge.write.with_source` / `knowledge.supersede.with_source` events
  // with it. Long-term memory writes happen in the memory manager, which has
  // its own memLog surface (see memory/observability/logger.test.ts). This
  // scan pins that no runtime source quietly re-introduces the retired
  // knowledge event namespaces.
  it("no runtime source emits a retired knowledge.* tool event", () => {
    const files = listRuntimeFiles();
    expect(files.length, "fs walker returned no runtime files").toBeGreaterThan(0);

    const retired = [/"knowledge\.write\./, /"knowledge\.supersede\./, /"knowledge\.recall\./];
    const offenders: Array<{ path: string; line: number; snippet: string }> = [];
    for (const file of files) {
      const raw = readFileSync(file, "utf-8");
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (retired.some((pattern) => pattern.test(line))) {
          offenders.push({ path: file, line: i + 1, snippet: line.trim().slice(0, 140) });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // The shared BANNED_EVENT_PATTERNS block (enforced repo-wide by
  // naming-lint.test.ts) must keep banning the retired session-memory
  // namespaces — pin the from-parts regexes so a template drift in THIS
  // file is caught even though naming-lint owns the actual scan.
  it("BANNED_EVENT_PATTERNS bans the retired session-memory event namespaces", () => {
    const sources = BANNED_EVENT_PATTERNS.map((b) => b.pattern.source);
    expect(sources).toContain(`"${RETIRED_SESSION_RECALL_NS}\\.`);
    expect(sources).toContain(`"${RETIRED_RESOLVE_NS}\\.`);
  });
});
