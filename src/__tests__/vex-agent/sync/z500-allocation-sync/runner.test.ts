/**
 * The Z500 runner's whole branch matrix over an in-memory ledger and a
 * scripted venue: fail-closed source handling, the no-mutation identity
 * path, mutation + confirmation, the uncertain-mutation reconciliation
 * rules, window idempotency, takeover read-only semantics, and the
 * structural non-goals surface.
 *
 * Every venue mutation the runner COULD send is counted; most assertions
 * here are ultimately about that counter staying at zero or exactly one.
 */

import { describe, expect, it } from "vitest";
import { VexError, ErrorCodes } from "../../../../errors.js";
import type { AnsemSnapshot } from "@tools/ansem/types.js";
import type { IndexifyTradability } from "@tools/indexify/types.js";
import {
  runZ500AllocationSyncTick,
  sanitizeForRecord,
  type CurrentStackState,
  type Z500SyncDeps,
} from "@vex-agent/sync/z500-allocation-sync/runner.js";
import { buildProductionZ500Deps } from "@vex-agent/sync/z500-allocation-sync/production-deps.js";
import type { ClaimResult, Z500RunOutcome, Z500RunRepo } from "@vex-agent/sync/z500-allocation-sync/repo.js";
import { Z500_STACK_ID } from "@vex-agent/sync/z500-allocation-sync/config.js";

// ── Fixture vocabulary ─────────────────────────────────────────────

function mint(index: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const a = alphabet[Math.floor(index / alphabet.length)]!;
  const b = alphabet[index % alphabet.length]!;
  return `So1111111111111111111111111111111111111${a}${b}`;
}

function snapshot(count = 12): AnsemSnapshot {
  return {
    coins: Array.from({ length: count }, (_, i) => ({
      mintAddress: mint(i), marketCapUsd: 10_000 - i, symbol: `T${i}`, name: `Token ${i}`,
    })),
    fetchedAtIso: "2026-08-28T00:01:00.000Z",
    feedTimestampIso: null,
    rowsWithoutMint: 0,
    totalRows: count,
  };
}

/** The allocation the default snapshot's top 10 produce. */
function desiredOfSnapshot(): Record<string, number> {
  return Object.fromEntries(Array.from({ length: 10 }, (_, i) => [mint(i), 10]));
}

// ── In-memory ledger ───────────────────────────────────────────────

interface MemoryRun {
  id: number; windowId: string; status: string; outcome: Z500RunOutcome | null;
  record: Record<string, unknown>; error: string | null;
}

class MemoryRepo implements Z500RunRepo {
  runs = new Map<string, MemoryRun>();
  private nextId = 1;
  /** Scripted claim override for the owned/complete/takeover cases. */
  claimOverride: ClaimResult | null = null;

  async claimWindow(windowId: string): Promise<ClaimResult> {
    if (this.claimOverride) return this.claimOverride;
    const existing = this.runs.get(windowId);
    if (existing) return existing.status === "running" ? { kind: "owned" } : { kind: "complete" };
    const run: MemoryRun = { id: this.nextId++, windowId, status: "running", outcome: null, record: {}, error: null };
    this.runs.set(windowId, run);
    return { kind: "claimed", runId: run.id };
  }

  async mergeRecord(runId: number, patch: Record<string, unknown>): Promise<void> {
    const run = [...this.runs.values()].find((r) => r.id === runId);
    if (run) run.record = { ...run.record, ...patch };
  }

  async complete(runId: number, status: "succeeded" | "failed", outcome: Z500RunOutcome, error: string | null = null): Promise<void> {
    const run = [...this.runs.values()].find((r) => r.id === runId);
    if (run) { run.status = status; run.outcome = outcome; run.error = error; }
  }

  async getRun(windowId: string) {
    const run = this.runs.get(windowId);
    return run ? { ...run, triggerType: "scheduled", takeoverCount: 0 } : null;
  }

  only(): MemoryRun {
    const all = [...this.runs.values()];
    expect(all).toHaveLength(1);
    return all[0]!;
  }
}

// ── Scripted deps ──────────────────────────────────────────────────

interface Script {
  snapshot?: () => Promise<AnsemSnapshot>;
  stack?: CurrentStackState | null | (() => Promise<CurrentStackState | null>);
  tradability?: (m: string) => Promise<IndexifyTradability>;
  edit?: () => Promise<{ success: boolean; stack_id: number; version: number }>;
  history?: () => Promise<{ stack_id: number; current_version: number; versions: [] }>;
  hasKey?: boolean;
}

function makeDeps(script: Script, repo: MemoryRepo) {
  const editCalls: Array<Record<string, number>> = [];
  const deps: Z500SyncDeps = {
    fetchSnapshot: script.snapshot ?? (async () => snapshot()),
    readStack: async () => {
      const stack = script.stack;
      if (typeof stack === "function") return stack();
      return stack === undefined
        ? { allocation: { [mint(40)]: 100 }, allocationVersion: 1, isClosed: false }
        : stack;
    },
    readVersionHistory: script.history ?? (async () => ({ stack_id: Z500_STACK_ID, current_version: 1, versions: [] })),
    checkTradability: script.tradability ?? (async () => ({ found: true, tradingEnabled: true, archived: false, symbol: null })),
    editAllocation: async (_stackId, allocation) => {
      editCalls.push({ ...allocation });
      if (script.edit) return script.edit();
      return { success: true, stack_id: Z500_STACK_ID, version: 2 };
    },
    repo,
    hasIndexifyApiKey: () => script.hasKey ?? true,
    now: () => new Date("2026-08-28T00:02:00Z"),
  };
  return { deps, editCalls };
}

// ── Source failures leave the venue untouched ──────────────────────

describe("fail-closed source handling", () => {
  for (const [label, code, outcome] of [
    ["unavailable", ErrorCodes.ANSEM_UNAVAILABLE, "source_unavailable"],
    ["stale", ErrorCodes.ANSEM_STALE, "source_stale"],
    ["invalid/incomplete/malformed", ErrorCodes.ANSEM_INVALID_RESPONSE, "source_invalid"],
  ] as const) {
    it(`a ${label} source fails the run with zero venue calls`, async () => {
      const repo = new MemoryRepo();
      const { deps, editCalls } = makeDeps({
        snapshot: async () => { throw new VexError(code, "scripted"); },
      }, repo);
      await runZ500AllocationSyncTick(deps);
      const run = repo.only();
      expect(run.status).toBe("failed");
      expect(run.outcome).toBe(outcome);
      expect(editCalls).toHaveLength(0);
    });
  }

  it("an unverifiable mint (venue error mid-scan) fails the run, stack untouched", async () => {
    const repo = new MemoryRepo();
    const { deps, editCalls } = makeDeps({
      tradability: async () => { throw new VexError(ErrorCodes.INDEXIFY_RATE_LIMITED, "429"); },
    }, repo);
    await runZ500AllocationSyncTick(deps);
    expect(repo.only().outcome).toBe("indexify_unavailable");
    expect(editCalls).toHaveLength(0);
  });

  it("fewer than 10 eligible tokens → insufficient_eligible_tokens, stack untouched, exclusions recorded", async () => {
    const repo = new MemoryRepo();
    const { deps, editCalls } = makeDeps({
      snapshot: async () => snapshot(6),
    }, repo);
    await runZ500AllocationSyncTick(deps);
    const run = repo.only();
    expect(run.outcome).toBe("insufficient_eligible_tokens");
    expect(run.status).toBe("failed");
    expect(run.record.selectedMints).toHaveLength(6);
    expect(editCalls).toHaveLength(0);
  });
});

// ── The identity path ──────────────────────────────────────────────

describe("no-change identity", () => {
  it("an identical current allocation (any ordering) produces NO mutation request and a SUCCESS", async () => {
    const repo = new MemoryRepo();
    const desired = desiredOfSnapshot();
    const reordered = Object.fromEntries(Object.entries(desired).reverse());
    const { deps, editCalls } = makeDeps({
      stack: { allocation: reordered, allocationVersion: 4, isClosed: false },
    }, repo);
    await runZ500AllocationSyncTick(deps);
    const run = repo.only();
    expect(run.status).toBe("succeeded");
    expect(run.outcome).toBe("no_change_needed");
    expect(run.record.mutationRequested).toBe(false);
    expect(editCalls).toHaveLength(0);
  });
});

// ── Mutation + confirmation ────────────────────────────────────────

describe("the mutation path", () => {
  it("a differing allocation updates the stack ONCE with the exact 10×10 desired map, then confirms by read-back", async () => {
    const repo = new MemoryRepo();
    let applied = false;
    const { deps, editCalls } = makeDeps({
      stack: async () => applied
        ? { allocation: desiredOfSnapshot(), allocationVersion: 2, isClosed: false }
        : { allocation: { [mint(40)]: 100 }, allocationVersion: 1, isClosed: false },
      edit: async () => { applied = true; return { success: true, stack_id: Z500_STACK_ID, version: 2 }; },
      history: async () => ({ stack_id: Z500_STACK_ID, current_version: applied ? 2 : 1, versions: [] }),
    }, repo);
    await runZ500AllocationSyncTick(deps);
    const run = repo.only();
    expect(run.status).toBe("succeeded");
    expect(run.outcome).toBe("allocation_updated");
    expect(editCalls).toEqual([desiredOfSnapshot()]);
    expect(run.record.mutationRequested).toBe(true);
    expect(run.record.previousAllocation).toEqual({ [mint(40)]: 100 });
    expect(run.record.desiredAllocation).toEqual(desiredOfSnapshot());
    expect(run.record.resultingAllocationVersion).toBe(2);
  });

  it("a definitive venue refusal fails as mutation_rejected with exactly one attempt", async () => {
    const repo = new MemoryRepo();
    const refusal = new VexError(ErrorCodes.INDEXIFY_INVALID_REQUEST, "Indexify rejected the request (HTTP 400: not creator)");
    refusal.httpStatus = 400;
    const { deps, editCalls } = makeDeps({ edit: async () => { throw refusal; } }, repo);
    await runZ500AllocationSyncTick(deps);
    expect(repo.only().outcome).toBe("mutation_rejected");
    expect(editCalls).toHaveLength(1);
  });

  it("a closed stack is refused before any mutation", async () => {
    const repo = new MemoryRepo();
    const { deps, editCalls } = makeDeps({
      stack: { allocation: { [mint(40)]: 100 }, allocationVersion: 1, isClosed: true },
    }, repo);
    await runZ500AllocationSyncTick(deps);
    expect(repo.only().outcome).toBe("mutation_rejected");
    expect(editCalls).toHaveLength(0);
  });
});

// ── Uncertain-mutation reconciliation (the spec's numbered rules) ──

describe("uncertain mutation reconciliation", () => {
  const timeout = () => { throw new VexError(ErrorCodes.INDEXIFY_TIMEOUT, "Indexify request timed out or was aborted"); };

  it("read-back shows the desired allocation applied → success WITHOUT a retry", async () => {
    const repo = new MemoryRepo();
    let sent = false;
    const { deps, editCalls } = makeDeps({
      stack: async () => sent
        ? { allocation: desiredOfSnapshot(), allocationVersion: 2, isClosed: false }
        : { allocation: { [mint(40)]: 100 }, allocationVersion: 1, isClosed: false },
      edit: async () => { sent = true; return timeout(); },
      history: async () => ({ stack_id: Z500_STACK_ID, current_version: sent ? 2 : 1, versions: [] }),
    }, repo);
    await runZ500AllocationSyncTick(deps);
    const run = repo.only();
    expect(run.status).toBe("succeeded");
    expect(run.outcome).toBe("reconciled_already_applied");
    expect(editCalls).toHaveLength(1);
  });

  it("read-back PROVES not-applied (allocation and version unmoved) → exactly ONE retry, then success", async () => {
    const repo = new MemoryRepo();
    let attempts = 0;
    const { deps, editCalls } = makeDeps({
      stack: async () => attempts >= 2
        ? { allocation: desiredOfSnapshot(), allocationVersion: 2, isClosed: false }
        : { allocation: { [mint(40)]: 100 }, allocationVersion: 1, isClosed: false },
      edit: async () => {
        attempts += 1;
        if (attempts === 1) return timeout();
        return { success: true, stack_id: Z500_STACK_ID, version: 2 };
      },
      history: async () => ({ stack_id: Z500_STACK_ID, current_version: attempts >= 2 ? 2 : 1, versions: [] }),
    }, repo);
    await runZ500AllocationSyncTick(deps);
    const run = repo.only();
    expect(run.outcome).toBe("allocation_updated");
    expect(editCalls).toHaveLength(2);
  });

  it("an INCONCLUSIVE read-back (version moved, allocation neither previous nor desired) → failed, NO retry", async () => {
    const repo = new MemoryRepo();
    let sent = false;
    const { deps, editCalls } = makeDeps({
      // Previous read: {mint40:100} v1. After the uncertain send, the stack
      // reads as a THIRD state — neither the previous allocation nor the
      // desired one, at a moved version — so nothing is proven either way.
      stack: async () => sent
        ? { allocation: { [mint(41)]: 100 }, allocationVersion: 3, isClosed: false }
        : { allocation: { [mint(40)]: 100 }, allocationVersion: 1, isClosed: false },
      edit: async () => { sent = true; return timeout(); },
      history: async () => ({ stack_id: Z500_STACK_ID, current_version: sent ? 3 : 1, versions: [] }),
    }, repo);
    await runZ500AllocationSyncTick(deps);
    expect(repo.only().outcome).toBe("mutation_unresolved");
    expect(editCalls).toHaveLength(1);
  });

  it("reconciliation reads THEMSELVES failing → failed, NO retry — never a blind second mutation", async () => {
    const repo = new MemoryRepo();
    let sent = false;
    const { deps, editCalls } = makeDeps({
      stack: async () => {
        if (sent) throw new VexError(ErrorCodes.INDEXIFY_API_ERROR, "venue down");
        return { allocation: { [mint(40)]: 100 }, allocationVersion: 1, isClosed: false };
      },
      edit: async () => { sent = true; return timeout(); },
    }, repo);
    await runZ500AllocationSyncTick(deps);
    expect(repo.only().outcome).toBe("mutation_unresolved");
    expect(editCalls).toHaveLength(1);
  });

  it("a retry that is itself uncertain → failed, and no THIRD attempt exists", async () => {
    const repo = new MemoryRepo();
    const { deps, editCalls } = makeDeps({
      edit: async () => timeout(),
    }, repo);
    await runZ500AllocationSyncTick(deps);
    expect(repo.only().outcome).toBe("mutation_unresolved");
    expect(editCalls).toHaveLength(2);
  });
});

// ── Window idempotency and the tick contract ───────────────────────

describe("window idempotency", () => {
  it("a second tick in the same window is a no-op — the window is complete", async () => {
    const repo = new MemoryRepo();
    const first = makeDeps({}, repo);
    await runZ500AllocationSyncTick(first.deps);
    const second = makeDeps({}, repo);
    const result = await runZ500AllocationSyncTick(second.deps);
    expect(result.evaluated).toBe(false);
    expect(result.detail).toBe("complete");
    expect(second.editCalls).toHaveLength(0);
    expect(repo.runs.size).toBe(1);
  });

  it("a window owned by a LIVE worker elsewhere is not touched", async () => {
    const repo = new MemoryRepo();
    repo.claimOverride = { kind: "owned" };
    const { deps, editCalls } = makeDeps({}, repo);
    const result = await runZ500AllocationSyncTick(deps);
    expect(result.evaluated).toBe(false);
    expect(editCalls).toHaveLength(0);
  });

  it("without INDEXIFY_API_KEY the tick skips WITHOUT claiming, so the first keyed tick still catches up", async () => {
    const repo = new MemoryRepo();
    const { deps } = makeDeps({ hasKey: false }, repo);
    const result = await runZ500AllocationSyncTick(deps);
    expect(result.evaluated).toBe(false);
    expect(repo.runs.size).toBe(0);
  });
});

// ── Takeover: read-only reconciliation, never a rerun ──────────────

describe("takeover of a dead worker's window", () => {
  it("mutation was requested and the read-back confirms it applied → succeeded, no new mutation", async () => {
    const repo = new MemoryRepo();
    const desired = desiredOfSnapshot();
    const dead: MemoryRun = {
      id: 99, windowId: "2026-08-28T00:00:00.000Z", status: "running", outcome: null,
      record: { mutationRequested: true, desiredAllocation: desired, previousAllocation: { [mint(40)]: 100 }, previousAllocationVersion: 1 },
      error: null,
    };
    repo.runs.set(dead.windowId, dead);
    repo.claimOverride = { kind: "takeover", runId: 99, record: dead.record };
    const { deps, editCalls } = makeDeps({
      stack: { allocation: desired, allocationVersion: 2, isClosed: false },
      history: async () => ({ stack_id: Z500_STACK_ID, current_version: 2, versions: [] }),
    }, repo);
    await runZ500AllocationSyncTick(deps);
    expect(dead.status).toBe("succeeded");
    expect(dead.outcome).toBe("reconciled_already_applied");
    expect(editCalls).toHaveLength(0);
  });

  it("mutation was requested but cannot be confirmed → takeover_unresolved, and STILL no new mutation", async () => {
    const repo = new MemoryRepo();
    const dead: MemoryRun = {
      id: 99, windowId: "2026-08-28T00:00:00.000Z", status: "running", outcome: null,
      record: { mutationRequested: true, desiredAllocation: desiredOfSnapshot(), previousAllocation: { [mint(40)]: 100 }, previousAllocationVersion: 1 },
      error: null,
    };
    repo.runs.set(dead.windowId, dead);
    repo.claimOverride = { kind: "takeover", runId: 99, record: dead.record };
    const { deps, editCalls } = makeDeps({
      stack: { allocation: { [mint(40)]: 100 }, allocationVersion: 1, isClosed: false },
    }, repo);
    await runZ500AllocationSyncTick(deps);
    expect(dead.status).toBe("failed");
    expect(dead.outcome).toBe("takeover_unresolved");
    expect(editCalls).toHaveLength(0);
  });

  it("the worker died BEFORE any mutation was requested → failed cleanly, stack provably untouched", async () => {
    const repo = new MemoryRepo();
    const dead: MemoryRun = {
      id: 99, windowId: "2026-08-28T00:00:00.000Z", status: "running", outcome: null, record: {}, error: null,
    };
    repo.runs.set(dead.windowId, dead);
    repo.claimOverride = { kind: "takeover", runId: 99, record: {} };
    const { deps, editCalls } = makeDeps({}, repo);
    await runZ500AllocationSyncTick(deps);
    expect(dead.status).toBe("failed");
    expect(dead.outcome).toBe("internal_error");
    expect(editCalls).toHaveLength(0);
  });
});

// ── Sanitization and the structural non-goals surface ──────────────

describe("audit hygiene and non-goals", () => {
  it("an Indexify-key-shaped string never survives into a persisted error", () => {
    // Fully synthetic hex — the spec forbids even key FRAGMENTS in fixtures.
    const dirty = "refused for key ix_0123456789abcdef0123456789abcdef: bad";
    const clean = sanitizeForRecord(dirty);
    expect(clean).not.toContain("ix_0123456789abcdef");
    expect(clean).toContain("ix_[REDACTED]");
  });

  it("the production deps surface is EXACTLY the allowed capability set — no trade, no rebalance, no create", () => {
    const deps = buildProductionZ500Deps();
    expect(Object.keys(deps).sort()).toEqual([
      "checkTradability",
      "editAllocation",
      "fetchSnapshot",
      "hasIndexifyApiKey",
      "now",
      "readStack",
      "readVersionHistory",
      "repo",
    ]);
  });

  it("the runner pins stack 28440 — the workflow's Z500_STACK_ID is the spec's id", () => {
    expect(Z500_STACK_ID).toBe(28440);
  });
});
