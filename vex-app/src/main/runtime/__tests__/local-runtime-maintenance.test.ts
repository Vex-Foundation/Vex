/**
 * Settings' restart and "Reset local data" over a real temporary runtime
 * directory: the hold, the critical ops, the engine reconnect and the
 * postmaster probe are stand-ins; the filesystem, the path guard and
 * runtime-state.json are real.
 *
 * Pins:
 *   - restart: single-flight (a second press joins), stop then start, the
 *     engine pool recycled only after a usable start, the hold released and
 *     the critical op ended on every path;
 *   - both refuse outside native mode, while a start, restart, reset or a
 *     migration runs (before and after the hold is taken), and while
 *     runtime-state.json is unreadable or records an unfinished migration;
 *   - reset deletes pg18/ and the initdb staging dir and clears `pg` (keeping
 *     every other field), touches nothing else, and keeps the hold;
 *   - reset refuses, deleting nothing and starting the runtime again, when the
 *     stop failed, when a live postmaster still holds the data dir, and when
 *     pg18 is a link or resolves outside the runtime dir.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeRuntimeStatus, RuntimeDirSize } from "@shared/schemas/system.js";
import { CRITICAL_OP } from "../../updates/critical-ops.js";
import {
  createLocalRuntimeMaintenance,
  type LocalRuntimeMaintenanceDeps,
} from "../native/local-runtime-maintenance.js";
import type { NativeRuntimeHold, NativeRuntimeStart, NativeRuntimeStop } from "../native/native-runtime.js";
import { readRuntimeState, writeRuntimeState } from "../runtime-state.js";

const READY: NativeRuntimeStatus = { seq: 9, phase: "ready" };
const RUNNING: NativeRuntimeStart = { kind: "running", message: "The local database is running." };
const STOPPED: NativeRuntimeStop = { kind: "stopped", message: "The local database stopped (fast)." };
const IDENTITY = "7412345678901234567";

interface Harness {
  readonly deps: LocalRuntimeMaintenanceDeps;
  readonly runtimeDir: string;
  readonly dataDir: string;
  readonly statePath: string;
  readonly calls: string[];
  readonly hold: {
    stop: ReturnType<typeof vi.fn<() => Promise<NativeRuntimeStop>>>;
    start: ReturnType<typeof vi.fn<() => Promise<NativeRuntimeStart>>>;
    release: ReturnType<typeof vi.fn<() => void>>;
  };
  ops: string[];
  holdAvailable: boolean;
  gateOpen: boolean;
  native: boolean;
  aliveCheck: (pid: number) => boolean;
  readonly opEnds: { count: number };
}

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vex-local-runtime-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function harness(): Harness {
  const runtimeDir = path.join(root, "runtime");
  const dataDir = path.join(runtimeDir, "pg18");
  mkdirSync(path.join(dataDir, "base", "1"), { recursive: true });
  writeFileSync(path.join(dataDir, "PG_VERSION"), "18\n");
  writeFileSync(path.join(dataDir, "base", "1", "1259"), Buffer.alloc(8192));
  mkdirSync(path.join(runtimeDir, "models"), { recursive: true });
  writeFileSync(path.join(runtimeDir, "models", "model.gguf"), "weights");
  const calls: string[] = [];
  const opEnds = { count: 0 };
  const hold = {
    stop: vi.fn(async () => {
      calls.push("stop");
      return STOPPED;
    }),
    start: vi.fn(async () => {
      calls.push("start");
      return RUNNING;
    }),
    release: vi.fn(() => {
      calls.push("release");
    }),
  };
  const h: Harness = {
    runtimeDir,
    dataDir,
    statePath: path.join(runtimeDir, "runtime-state.json"),
    calls,
    hold,
    ops: [],
    holdAvailable: true,
    gateOpen: true,
    native: true,
    aliveCheck: () => false,
    opEnds,
    deps: undefined as unknown as LocalRuntimeMaintenanceDeps,
  };
  (h as { deps: LocalRuntimeMaintenanceDeps }).deps = {
    runtimeDir,
    isNative: () => h.native,
    acquireHold: () => (h.holdAvailable ? (hold as NativeRuntimeHold) : null),
    activeCriticalOps: () => h.ops,
    startGateOpen: () => h.gateOpen,
    beginLocalRuntimeOp: () => {
      calls.push("op:begin");
      return () => {
        opEnds.count += 1;
        calls.push("op:end");
      };
    },
    currentStatus: () => READY,
    reconnectEngineDb: vi.fn(async () => {
      calls.push("reconnect");
      return true;
    }),
    readState: readRuntimeState,
    writeState: writeRuntimeState,
    measure: async (dir): Promise<RuntimeDirSize> => {
      const { measureDirectory } = await import("../native/dir-size.js");
      return measureDirectory(dir);
    },
    fs: {
      lstat: (file) => fsp.lstat(file),
      realpath: (file) => fsp.realpath(file),
      readFile: (file) => fsp.readFile(file, "utf8"),
      rm: (file) => fsp.rm(file, { recursive: true, force: true }),
    },
    processAlive: (pid) => h.aliveCheck(pid),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return h;
}

function writeState(h: Harness, state: unknown): void {
  writeFileSync(h.statePath, JSON.stringify(state));
}

describe("restart", () => {
  it("stops, starts, then reconnects the engine, and releases the hold and the critical op", async () => {
    const h = harness();
    const result = await createLocalRuntimeMaintenance(h.deps).restart();
    expect(result).toEqual({ kind: "restarted", status: READY });
    expect(h.calls).toEqual(["op:begin", "stop", "start", "reconnect", "release", "op:end"]);
  });

  it("is single-flight: a second press joins the restart in flight", async () => {
    const h = harness();
    let finishStart: () => void = () => {};
    h.hold.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStart = () => resolve(RUNNING);
        }),
    );
    const maintenance = createLocalRuntimeMaintenance(h.deps);
    const first = maintenance.restart();
    const second = maintenance.restart();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(h.hold.start).toHaveBeenCalledTimes(1));
    finishStart();
    expect(await second).toMatchObject({ kind: "restarted" });
    expect(h.hold.stop).toHaveBeenCalledTimes(1);
    // Once settled, the next press is a new restart.
    await maintenance.restart();
    expect(h.hold.stop).toHaveBeenCalledTimes(2);
  });

  it("reports a start that did not come back, without reconnecting the engine", async () => {
    const h = harness();
    h.hold.start.mockResolvedValue({ kind: "failed", message: "The disk is full." });
    const result = await createLocalRuntimeMaintenance(h.deps).restart();
    expect(result).toEqual({ kind: "failed", message: "The disk is full.", status: READY });
    expect(h.deps.reconnectEngineDb).not.toHaveBeenCalled();
    expect(h.calls.slice(-2)).toEqual(["release", "op:end"]);
  });

  it("still starts after a stop that failed, so whatever is up is adopted or replaced", async () => {
    const h = harness();
    h.hold.stop.mockResolvedValue({ kind: "failed", message: "The local database did not stop." });
    expect(await createLocalRuntimeMaintenance(h.deps).restart()).toMatchObject({ kind: "restarted" });
    expect(h.hold.start).toHaveBeenCalledTimes(1);
  });

  it("releases the hold and ends the critical op when the start throws", async () => {
    const h = harness();
    h.hold.start.mockRejectedValue(new Error("boom"));
    await expect(createLocalRuntimeMaintenance(h.deps).restart()).rejects.toThrow("boom");
    expect(h.hold.release).toHaveBeenCalledTimes(1);
    expect(h.opEnds.count).toBe(1);
  });
});

describe.each(["restart", "reset"] as const)("%s refuses", (action) => {
  const run = (h: Harness) => createLocalRuntimeMaintenance(h.deps)[action]();

  it("outside the native runtime", async () => {
    const h = harness();
    h.native = false;
    expect(await run(h)).toMatchObject({ kind: "refused", reason: "not_native" });
    expect(h.hold.stop).not.toHaveBeenCalled();
  });

  it.each([
    ["a start or a data migration", CRITICAL_OP.localRuntime],
    ["the schema migration", CRITICAL_OP.dbMigration],
  ])("while %s runs", async (_label, op) => {
    const h = harness();
    h.ops = [op];
    expect(await run(h)).toMatchObject({ kind: "refused", reason: "busy" });
    expect(h.hold.stop).not.toHaveBeenCalled();
  });

  it("while the native start gate is shut or a move runs, starting and deleting nothing", async () => {
    const h = harness();
    h.gateOpen = false;
    expect(await run(h)).toMatchObject({ kind: "refused", reason: "migration_pending" });
    expect(h.hold.stop).not.toHaveBeenCalled();
    expect(h.hold.start).not.toHaveBeenCalled();
    expect(existsSync(path.join(h.dataDir, "PG_VERSION"))).toBe(true);
  });

  it("when a move began between the first check and the hold, giving the hold back", async () => {
    const h = harness();
    const acquire = h.deps.acquireHold;
    (h.deps as { acquireHold: () => NativeRuntimeHold | null }).acquireHold = () => {
      h.gateOpen = false;
      return acquire();
    };
    expect(await run(h)).toMatchObject({ kind: "refused", reason: "migration_pending" });
    expect(h.hold.release).toHaveBeenCalledTimes(1);
    expect(h.hold.stop).not.toHaveBeenCalled();
  });

  it("while another start, restart or reset holds the runtime", async () => {
    const h = harness();
    h.holdAvailable = false;
    expect(await run(h)).toMatchObject({ kind: "refused", reason: "busy" });
  });

  it("when a migration began between the first check and the hold, giving the hold back", async () => {
    const h = harness();
    const acquire = h.deps.acquireHold;
    (h.deps as { acquireHold: () => NativeRuntimeHold | null }).acquireHold = () => {
      h.ops = [CRITICAL_OP.localRuntime];
      return acquire();
    };
    expect(await run(h)).toMatchObject({ kind: "refused", reason: "busy" });
    expect(h.hold.release).toHaveBeenCalledTimes(1);
    expect(h.hold.stop).not.toHaveBeenCalled();
  });

  it("while runtime-state.json records an unfinished migration", async () => {
    const h = harness();
    writeState(h, {
      pg: null,
      migration: {
        installId: "install-1",
        step: "dumped",
        outcome: null,
        dump: null,
        attempts: 1,
        lastFailure: null,
        oldStackStopped: null,
        startedAt: "2026-10-17T10:00:00.000Z",
        updatedAt: "2026-10-17T10:00:00.000Z",
      },
    });
    expect(await run(h)).toMatchObject({ kind: "refused", reason: "migration_pending" });
    expect(existsSync(h.dataDir)).toBe(true);
  });

  it("when runtime-state.json does not parse", async () => {
    const h = harness();
    writeFileSync(h.statePath, "{ not json");
    expect(await run(h)).toMatchObject({ kind: "refused", reason: "state_unreadable" });
    expect(existsSync(h.dataDir)).toBe(true);
  });
});

describe("reset local data", () => {
  const completedMigration = {
    installId: "install-1",
    step: "completed",
    outcome: "migrated",
    dump: null,
    attempts: 1,
    lastFailure: null,
    oldStackStopped: true,
    startedAt: "2026-10-17T10:00:00.000Z",
    updatedAt: "2026-10-17T10:05:00.000Z",
  };

  it("deletes the cluster and its record, keeps everything else, and keeps the hold for the relaunch", async () => {
    const h = harness();
    mkdirSync(`${h.dataDir}.initdb`);
    writeState(h, {
      pg: { systemIdentifier: IDENTITY, lastPort: 51234, major: 18 },
      provider: "native",
      migration: completedMigration,
      fromANewerBuild: { kept: true },
    });

    const result = await createLocalRuntimeMaintenance(h.deps).reset();

    expect(result).toEqual({ kind: "reset", deletedBytes: 8192 + 3, relaunching: true });
    expect(existsSync(h.dataDir)).toBe(false);
    expect(existsSync(`${h.dataDir}.initdb`)).toBe(false);
    expect(readFileSync(path.join(h.runtimeDir, "models", "model.gguf"), "utf8")).toBe("weights");
    expect(JSON.parse(readFileSync(h.statePath, "utf8"))).toEqual({
      pg: null,
      provider: "native",
      migration: completedMigration,
      fromANewerBuild: { kept: true },
    });
    expect(h.calls).toEqual(["op:begin", "stop", "op:end"]);
    expect(h.hold.release).not.toHaveBeenCalled();
    expect(h.hold.start).not.toHaveBeenCalled();
    expect(h.deps.log.info).toHaveBeenCalledWith(expect.stringContaining(`system_identifier=${IDENTITY}`));
    expect(h.deps.log.info).toHaveBeenCalledWith(expect.stringContaining(h.dataDir));
  });

  it("succeeds with nothing to delete when there is no cluster yet", async () => {
    const h = harness();
    rmSync(h.dataDir, { recursive: true });
    expect(await createLocalRuntimeMaintenance(h.deps).reset()).toEqual({
      kind: "reset",
      deletedBytes: 0,
      relaunching: true,
    });
    expect(JSON.parse(readFileSync(h.statePath, "utf8"))).toEqual({ pg: null, provider: "native" });
  });

  it("refuses when the stop failed, deletes nothing, and starts the runtime again", async () => {
    const h = harness();
    h.hold.stop.mockResolvedValue({ kind: "failed", message: "The local database did not stop." });
    expect(await createLocalRuntimeMaintenance(h.deps).reset()).toMatchObject({
      kind: "refused",
      reason: "still_running",
    });
    expect(existsSync(path.join(h.dataDir, "PG_VERSION"))).toBe(true);
    expect(h.hold.start).toHaveBeenCalledTimes(1);
    expect(h.hold.release).toHaveBeenCalledTimes(1);
    expect(h.opEnds.count).toBe(1);
  });

  it("refuses while a live postmaster still holds the data directory", async () => {
    const h = harness();
    writeFileSync(path.join(h.dataDir, "postmaster.pid"), `4242\n${h.dataDir}\n1700000000\n51234\n\n\n\nready\n`);
    h.aliveCheck = (pid) => pid === 4242;
    expect(await createLocalRuntimeMaintenance(h.deps).reset()).toMatchObject({
      kind: "refused",
      reason: "still_running",
    });
    expect(existsSync(path.join(h.dataDir, "PG_VERSION"))).toBe(true);
    expect(h.hold.start).toHaveBeenCalledTimes(1);
    expect(h.hold.release).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale postmaster.pid whose process is gone", async () => {
    const h = harness();
    writeFileSync(path.join(h.dataDir, "postmaster.pid"), `4242\n${h.dataDir}\n1700000000\n51234\n\n\n\nready\n`);
    expect(await createLocalRuntimeMaintenance(h.deps).reset()).toMatchObject({ kind: "reset" });
    expect(existsSync(h.dataDir)).toBe(false);
  });

  it("refuses a data directory that is a link out of the runtime directory, before stopping anything", async () => {
    const h = harness();
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(path.join(elsewhere, "precious"), "keep me");
    rmSync(h.dataDir, { recursive: true });
    symlinkSync(elsewhere, h.dataDir, "dir");
    expect(await createLocalRuntimeMaintenance(h.deps).reset()).toMatchObject({
      kind: "refused",
      reason: "path_unsafe",
    });
    expect(readFileSync(path.join(elsewhere, "precious"), "utf8")).toBe("keep me");
    expect(h.hold.stop).not.toHaveBeenCalled();
  });

  it("refuses when the runtime directory resolves elsewhere than pg18's parent", async () => {
    const h = harness();
    const realRuntime = path.join(root, "real-runtime");
    mkdirSync(realRuntime);
    // runtimeDir is a link; pg18 is reached through it but lives elsewhere.
    const linkedRuntime = path.join(root, "linked-runtime");
    symlinkSync(realRuntime, linkedRuntime, "dir");
    mkdirSync(path.join(realRuntime, "pg18"));
    const outside = path.join(root, "outside-pg18");
    mkdirSync(outside);
    const deps = { ...h.deps, runtimeDir: linkedRuntime };
    // Through the link everything agrees, so this is allowed...
    expect(await createLocalRuntimeMaintenance(deps).reset()).toMatchObject({ kind: "reset" });
    // ...but a pg18 swapped for a link to another folder is not.
    symlinkSync(outside, path.join(realRuntime, "pg18"), "dir");
    expect(await createLocalRuntimeMaintenance(deps).reset()).toMatchObject({
      kind: "refused",
      reason: "path_unsafe",
    });
    expect(existsSync(outside)).toBe(true);
  });

  it("refuses a pg18 swapped for a link while the servers stopped, and starts them again", async () => {
    const h = harness();
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(path.join(elsewhere, "precious"), "keep me");
    h.hold.stop.mockImplementation(async () => {
      rmSync(h.dataDir, { recursive: true });
      symlinkSync(elsewhere, h.dataDir, "dir");
      return STOPPED;
    });
    expect(await createLocalRuntimeMaintenance(h.deps).reset()).toMatchObject({
      kind: "refused",
      reason: "path_unsafe",
    });
    expect(readFileSync(path.join(elsewhere, "precious"), "utf8")).toBe("keep me");
    expect(h.hold.start).toHaveBeenCalledTimes(1);
    expect(h.hold.release).toHaveBeenCalledTimes(1);
  });

  it("refuses a relative runtime directory", async () => {
    const h = harness();
    const deps = { ...h.deps, runtimeDir: "runtime" };
    expect(await createLocalRuntimeMaintenance(deps).reset()).toMatchObject({
      kind: "refused",
      reason: "path_unsafe",
    });
  });

  it("reports a delete that failed and starts the runtime again", async () => {
    const h = harness();
    const deps = { ...h.deps, fs: { ...h.deps.fs, rm: async () => Promise.reject(new Error("EBUSY: resource busy")) } };
    expect(await createLocalRuntimeMaintenance(deps).reset()).toEqual({
      kind: "failed",
      message: "The local data could not be deleted: EBUSY: resource busy",
    });
    expect(h.hold.start).toHaveBeenCalledTimes(1);
    expect(h.hold.release).toHaveBeenCalledTimes(1);
  });
});
