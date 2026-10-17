/**
 * The Docker-to-native migration engine with every step injected: a fake
 * Docker source, a fake supervisor whose "cluster" is a directory under the
 * temp RUNTIME_DIR, fake pg_dump / pg_restore that carry the database facts
 * through a real dump FILE, and a facts reader over those files. The state
 * file, the dump, the facts file and the data dir are all real files, so
 * crash/resume is tested against what is actually on disk.
 *
 * A "crash" is a seam that never settles: the engine is frozen exactly there,
 * as a killed process would be, and a NEW engine on the same directories must
 * resume from what the first one made durable.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "", getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createDockerMigration } = await import("../migration/docker-to-native.js");
const { compareDatabaseFacts } = await import("../migration/database-facts.js");
const { readRuntimeState, writeRuntimeState } = await import("../runtime-state.js");
const { __resetCriticalOpsForTests, criticalOpInFlight } = await import("../../updates/critical-ops.js");

type Engine = ReturnType<typeof createDockerMigration>;
type Deps = Parameters<typeof createDockerMigration>[0];
type Facts = Parameters<typeof compareDatabaseFacts>[0];
type Source = Deps["source"];
type Supervisor = Exclude<Awaited<ReturnType<Deps["createSupervisor"]>>, { readonly unavailable: string }>;

const INSTALL_ID = "11111111-2222-3333-4444-555555555555";
const SYSID = "7697576143254888004";
const NATIVE_PORT = 45_999;
const SOURCE_PORT = 27_432;

function sourceFacts(): Facts {
  return {
    schemaVersion: 177,
    tables: {
      "public.schema_version": { rows: 169, digest: "d-schema" },
      "public.sessions": { rows: 3, digest: "d-sessions" },
      "public.messages": { rows: 40, digest: "d-messages" },
      "public.knowledge_entries": { rows: 5, digest: "d-ke" },
      "public.empty_table": { rows: 0, digest: null },
    },
    vectorColumns: { "public.knowledge_entries.embedding": { nonNull: 5, digest: "v-ke" } },
    vectorSample: { "1": "aa", "2": "bb", "3": "cc", "4": "dd", "5": "ee" },
    sequences: { "public.knowledge_entries_id_seq": "5", "public.unused_seq": null },
    indexes: ["public.knowledge_entries_pkey", "public.messages_pkey"],
    constraints: ["public.knowledge_entries.ke_embedding_dim_matches_vector:c"],
    extensions: ["plpgsql", "vector"],
    largeObjects: 0,
  };
}

/** A seam that never settles: the engine is frozen there, like a killed process. */
let onFrozen: () => void = () => {};
function frozen<T>(): Promise<T> {
  onFrozen();
  return new Promise<T>(() => {});
}

/** Run a migration until it freezes at the seam `hang` names, then "restart". */
async function crashAt(hang: keyof World["hang"]): Promise<void> {
  world.hang[hang] = true;
  const reached = new Promise<void>((resolve) => {
    onFrozen = resolve;
  });
  void engine(world).migrate();
  await reached;
  world.hang = {};
  __resetCriticalOpsForTests();
  world.calls.length = 0;
}

interface World {
  readonly root: string;
  readonly configDir: string;
  readonly runtimeDir: string;
  readonly statePath: string;
  readonly dataDir: string;
  readonly passwordPath: string;
  source: Facts;
  /** What pg_restore does to the facts on their way into the cluster. */
  corruptRestore: ((facts: Facts) => Facts) | null;
  hang: Partial<Record<"bringUp" | "pgDump" | "pgRestore" | "readTarget" | "stopSource", boolean>>;
  fail: Partial<Record<"pgDump" | "pgRestore" | "nativeStart", string>>;
  probe: Awaited<ReturnType<Source["probe"]>>;
  bringUp: Awaited<ReturnType<Source["bringUpDb"]>>;
  freeBytes: number;
  alivePids: Set<number>;
  calls: string[];
  toolCalls: Array<{ readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly pgpass: string | null }>;
}

const roots: string[] = [];
let world: World;

function makeWorld(): World {
  const root = mkdtempSync(path.join(os.tmpdir(), "vex-migration-"));
  roots.push(root);
  const configDir = path.join(root, "config");
  const runtimeDir = path.join(configDir, "runtime");
  mkdirSync(path.join(configDir, "local-infra", "secrets"), { recursive: true });
  const passwordPath = path.join(configDir, "local-infra", "secrets", "pg_password");
  writeFileSync(passwordPath, "s3cret:with\\colon\n", { mode: 0o600 });
  return {
    root,
    configDir,
    runtimeDir,
    statePath: path.join(runtimeDir, "runtime-state.json"),
    dataDir: path.join(runtimeDir, "pg18"),
    passwordPath,
    source: sourceFacts(),
    corruptRestore: null,
    hang: {},
    fail: {},
    probe: { kind: "volume_present" },
    bringUp: { kind: "ready", pgPort: SOURCE_PORT, passwordPath },
    freeBytes: 10 * 1024 ** 3,
    alivePids: new Set(),
    calls: [],
    toolCalls: [],
  };
}

/** What a Docker-era install leaves in CONFIG_DIR. */
function dockerInstall(w: World): void {
  writeFileSync(path.join(w.configDir, ".install-id"), INSTALL_ID);
  mkdirSync(path.join(w.configDir, "compose"), { recursive: true });
  writeFileSync(path.join(w.configDir, "compose", "docker-compose.yml"), "name: vex\n");
}

const fakeDbFile = (w: World): string => path.join(w.dataDir, "fake-db.json");

function fakeSupervisor(w: World): Supervisor {
  let running = false;
  return {
    async ensureCluster() {
      return { kind: "ready", initialized: false };
    },
    async start() {
      w.calls.push("native.start");
      if (w.fail.nativeStart !== undefined) {
        return { kind: "failed", connection: null, message: w.fail.nativeStart };
      }
      // The real supervisor's facts: initdb when there is no PG_VERSION, the
      // identity recorded once the bootstrap completed.
      if (!existsSync(path.join(w.dataDir, "PG_VERSION"))) {
        mkdirSync(w.dataDir, { recursive: true });
        writeFileSync(path.join(w.dataDir, "PG_VERSION"), "18\n");
        w.calls.push("native.initdb");
      }
      const state = await readRuntimeState(w.statePath);
      if (state.pg === null) await writeRuntimeState(w.statePath, { ...state, pg: { systemIdentifier: SYSID, lastPort: NATIVE_PORT, major: 18 } });
      running = true;
      return {
        kind: "running",
        connection: { host: "127.0.0.1", pgPort: NATIVE_PORT, pgPasswordPath: w.passwordPath },
        message: "running",
      };
    },
    async stop() {
      w.calls.push("native.stop");
      const was = running;
      running = false;
      return { kind: was ? "stopped" : "not_running", mode: was ? "fast" : null, message: "stopped" };
    },
    onHealthChange: () => () => {},
  };
}

function fakeSource(w: World): Source {
  return {
    async probe(installId) {
      w.calls.push(`source.probe:${installId}`);
      return w.probe;
    },
    async bringUpDb(installId) {
      w.calls.push(`source.bringUp:${installId}`);
      if (w.hang.bringUp === true) return frozen();
      return w.bringUp;
    },
    async stop(installId) {
      w.calls.push(`source.stop:${installId}`);
      if (w.hang.stopSource === true) return frozen();
      return { kind: "stopped", message: "stopped" };
    },
    async removeData(installId) {
      w.calls.push(`source.removeData:${installId}`);
      return { kind: "removed", message: "removed" };
    },
  };
}

function argValue(args: readonly string[], flag: string): string {
  const i = args.indexOf(flag);
  if (i < 0) throw new Error(`no ${flag} in ${args.join(" ")}`);
  return args[i + 1] as string;
}

function engine(w: World, overrides: Partial<Deps> = {}): Engine {
  return createDockerMigration({
    configDir: w.configDir,
    runtimeDir: w.runtimeDir,
    platform: "darwin",
    source: fakeSource(w),
    locateClientTools: async () => ({ kind: "found", tools: { pgDump: "/tree/bin/pg_dump", pgRestore: "/tree/bin/pg_restore" } }),
    createSupervisor: async () => fakeSupervisor(w),
    runTool: async (command, args, options) => {
      const pgpassFile = options.env["PGPASSFILE"];
      w.toolCalls.push({
        command,
        args,
        env: options.env,
        pgpass: pgpassFile !== undefined && existsSync(pgpassFile) ? readFileSync(pgpassFile, "utf8") : null,
      });
      if (command.endsWith("pg_dump")) {
        if (w.hang.pgDump === true) {
          writeFileSync(argValue(args, "-f"), "PGDMP partial");
          return frozen();
        }
        if (w.fail.pgDump !== undefined) return { code: 1, stdout: "", stderr: w.fail.pgDump };
        writeFileSync(argValue(args, "-f"), JSON.stringify(w.source));
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command.endsWith("pg_restore")) {
        w.calls.push("pg_restore");
        if (w.hang.pgRestore === true) {
          writeFileSync(fakeDbFile(w), readFileSync(args.at(-1) as string, "utf8"));
          return frozen();
        }
        if (w.fail.pgRestore !== undefined) return { code: 1, stdout: "", stderr: w.fail.pgRestore };
        if (existsSync(fakeDbFile(w))) return { code: 1, stdout: "", stderr: 'ERROR: relation "sessions" already exists' };
        const dumped = JSON.parse(readFileSync(args.at(-1) as string, "utf8")) as Facts;
        writeFileSync(fakeDbFile(w), JSON.stringify(w.corruptRestore === null ? dumped : w.corruptRestore(dumped)));
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected tool ${command}`);
    },
    facts: {
      async openSource() {
        w.calls.push("source.snapshot");
        return {
          snapshotId: "00000003-0000001B-1",
          databaseBytes: 1_000_000,
          readFacts: async () => structuredClone(w.source),
          close: async () => {
            w.calls.push("source.snapshot.close");
          },
        };
      },
      async readTarget(_endpoint, sampleIds) {
        w.calls.push("target.facts");
        if (w.hang.readTarget === true) return frozen();
        const facts = JSON.parse(readFileSync(fakeDbFile(w), "utf8")) as Facts;
        return {
          ...facts,
          vectorSample: Object.fromEntries(Object.entries(facts.vectorSample).filter(([id]) => sampleIds.includes(id))),
        };
      },
    },
    freeBytes: async () => w.freeBytes,
    processAlive: (pid) => w.alivePids.has(pid),
    ...overrides,
  });
}

async function state(w: World = world): Promise<Awaited<ReturnType<typeof readRuntimeState>>> {
  return readRuntimeState(w.statePath);
}

const migrationFiles = (w: World): string[] => {
  const dir = path.join(w.runtimeDir, "migration");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

beforeEach(() => {
  __resetCriticalOpsForTests();
  world = makeWorld();
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe("detect", () => {
  it("a new install (no install id) needs nothing and never asks Docker", async () => {
    expect(await engine(world).detect()).toEqual({ kind: "not_needed", reason: "no_docker_install" });
    expect(world.calls).toEqual([]);
  });

  it("a Docker install with its volume is pending", async () => {
    dockerInstall(world);
    expect(await engine(world).detect()).toEqual({ kind: "pending", installId: INSTALL_ID, resumeStep: null, lastFailure: null });
    expect(world.calls).toEqual([`source.probe:${INSTALL_ID}`]);
  });

  it("a Docker install whose volume never existed is treated as new", async () => {
    dockerInstall(world);
    world.probe = { kind: "volume_absent" };
    expect(await engine(world).detect()).toEqual({ kind: "not_needed", reason: "no_docker_volume" });
  });

  it("Docker not answering is pending_docker_unavailable, decided from the files alone", async () => {
    dockerInstall(world);
    world.probe = { kind: "unreachable", detail: "Cannot connect to the Docker daemon" };
    expect(await engine(world).detect()).toEqual({
      kind: "pending_docker_unavailable",
      installId: INSTALL_ID,
      detail: "Cannot connect to the Docker daemon",
      resumeStep: null,
      lastFailure: null,
    });
  });

  it("an install id without a rendered project and no Docker is not a Docker install", async () => {
    writeFileSync(path.join(world.configDir, ".install-id"), INSTALL_ID);
    world.probe = { kind: "unreachable", detail: "no docker" };
    expect(await engine(world).detect()).toEqual({ kind: "not_needed", reason: "no_docker_install" });
  });

  it("a recorded native cluster is a native install", async () => {
    dockerInstall(world);
    await writeRuntimeState(world.statePath, { pg: { systemIdentifier: SYSID, lastPort: 1, major: 18 } });
    expect(await engine(world).detect()).toEqual({ kind: "not_needed", reason: "native_install" });
    expect(world.calls).toEqual([]);
  });

  it("an interrupted migration past the dump is pending without Docker, even with a native cluster recorded", async () => {
    dockerInstall(world);
    await writeRuntimeState(world.statePath, {
      pg: { systemIdentifier: SYSID, lastPort: 1, major: 18 },
      migration: {
        installId: INSTALL_ID, step: "restored", outcome: null, dump: { sha256: "a".repeat(64), bytes: 1 },
        attempts: 1, lastFailure: null, oldStackStopped: null, startedAt: "t", updatedAt: "t",
      },
    });
    expect(await engine(world).detect()).toEqual({ kind: "pending", installId: INSTALL_ID, resumeStep: "restored", lastFailure: null });
    expect(world.calls).toEqual([]);
  });

  it("a corrupt runtime-state.json is reported, never reset", async () => {
    mkdirSync(world.runtimeDir, { recursive: true });
    writeFileSync(world.statePath, "{ nope");
    const status = await engine(world).detect();
    expect(status.kind).toBe("state_unreadable");
    expect(readFileSync(world.statePath, "utf8")).toBe("{ nope");
  });
});

describe("migrate: the happy path", () => {
  beforeEach(() => dockerInstall(world));

  it("dumps over TCP, restores into a fresh cluster, verifies, flips the provider, stops the old stack", async () => {
    const phases: string[] = [];
    const result = await engine(world).migrate({ onProgress: (p) => phases.push(p.phase) });

    expect(result.kind).toBe("migrated");
    if (result.kind !== "migrated") return;
    expect(result.oldStackStopped).toBe(true);
    expect(result.report).toMatchObject({ ok: true, schemaVersion: 177, tables: 5, rows: 217, vectors: 5, sampledVectors: 5 });

    const s = await state();
    expect(s.provider).toBe("native");
    expect(s.pg?.systemIdentifier).toBe(SYSID);
    expect(s.migration).toMatchObject({
      installId: INSTALL_ID, step: "completed", outcome: "migrated", dump: null, attempts: 1, oldStackStopped: true, lastFailure: null,
    });
    // The verified cluster stays; the dump and every work file are gone.
    expect(existsSync(fakeDbFile(world))).toBe(true);
    expect(migrationFiles(world)).toEqual([]);
    expect([...new Set(phases)]).toEqual(["preparing", "starting_source", "dumping", "restoring", "verifying", "finishing"]);

    expect(world.calls).toEqual([
      `source.probe:${INSTALL_ID}`,
      `source.bringUp:${INSTALL_ID}`,
      "source.snapshot",
      "source.snapshot.close",
      "native.start",
      "native.initdb",
      "pg_restore",
      "target.facts",
      "native.stop",
      `source.stop:${INSTALL_ID}`,
    ]);
    expect(world.calls.some((c) => c.startsWith("source.removeData"))).toBe(false);
    expect(criticalOpInFlight()).toBe(false);
  });

  it("runs the bundled pg_dump -Fc on the exported snapshot and pg_restore single-transaction, the password only in a pgpass file", async () => {
    await engine(world).migrate();
    const [dump, restore] = world.toolCalls;
    expect(dump?.command).toBe("/tree/bin/pg_dump");
    expect(dump?.args).toEqual([
      "-h", "127.0.0.1", "-p", String(SOURCE_PORT), "-U", "vex", "-d", "vex", "--no-password",
      "-Fc", "--snapshot=00000003-0000001B-1", "-f", path.join(world.runtimeDir, "migration", "vex.dump.partial"),
    ]);
    expect(restore?.command).toBe("/tree/bin/pg_restore");
    expect(restore?.args).toEqual([
      "-h", "127.0.0.1", "-p", String(NATIVE_PORT), "-U", "vex", "-d", "vex", "--no-password",
      "--exit-on-error", "--single-transaction", path.join(world.runtimeDir, "migration", "vex.dump"),
    ]);
    for (const call of world.toolCalls) {
      expect(call.args.join(" ")).not.toContain("s3cret");
      expect(JSON.stringify(call.env)).not.toContain("s3cret");
      expect(Object.keys(call.env).sort()).toEqual(["PGCONNECT_TIMEOUT", "PGPASSFILE"]);
    }
    // pgpass escapes ':' and '\' and names exactly the port the tool connects to.
    expect(dump?.pgpass).toBe(`127.0.0.1:${String(SOURCE_PORT)}:vex:vex:s3cret\\:with\\\\colon\n`);
    expect(restore?.pgpass).toBe(`127.0.0.1:${String(NATIVE_PORT)}:vex:vex:s3cret\\:with\\\\colon\n`);
  });

  it("is idempotent once completed", async () => {
    await engine(world).migrate();
    world.calls.length = 0;
    expect(await engine(world).migrate()).toEqual({ kind: "already_completed", outcome: "migrated" });
    expect(await engine(world).detect()).toEqual({ kind: "not_needed", reason: "migrated" });
    expect(world.calls).toEqual([]);
  });

  it("a second caller joins the migration in flight; start fresh is refused meanwhile", async () => {
    world.hang.readTarget = true;
    const e = engine(world);
    const first = e.migrate();
    const second = e.migrate();
    expect(second).toBe(first);
    expect(await e.startFresh()).toMatchObject({ kind: "failed", reason: "busy" });
    expect(await e.removeOldData()).toMatchObject({ kind: "refused", reason: "busy" });
  });

  it("moves a pre-existing, unrecorded data dir aside instead of deleting it", async () => {
    mkdirSync(world.dataDir, { recursive: true });
    writeFileSync(path.join(world.dataDir, "PG_VERSION"), "18\n");
    writeFileSync(path.join(world.dataDir, "precious"), "keep me");
    expect((await engine(world).migrate()).kind).toBe("migrated");
    const aside = readdirSync(world.runtimeDir).filter((n) => n.startsWith("pg18.set-aside-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(path.join(world.runtimeDir, aside[0] as string, "precious"), "utf8")).toBe("keep me");
  });

  it("refuses an install whose volume Docker says is gone, writing no record", async () => {
    world.probe = { kind: "volume_absent" };
    expect(await engine(world).migrate()).toMatchObject({ kind: "failed", reason: "not_pending" });
    expect((await state()).migration).toBeUndefined();
    expect(await engine(world).detect()).toEqual({ kind: "not_needed", reason: "no_docker_volume" });
  });

  it("refuses an install that already has a recorded native cluster, touching nothing", async () => {
    await writeRuntimeState(world.statePath, { pg: { systemIdentifier: SYSID, lastPort: 1, major: 18 } });
    expect(await engine(world).migrate()).toMatchObject({ kind: "failed", reason: "not_pending" });
    expect(await state()).toEqual({ pg: { systemIdentifier: SYSID, lastPort: 1, major: 18 } });
    expect(world.calls).toEqual([]);
  });

  it("reports a stack it could not stop, and still completes: the data is verified", async () => {
    const e = engine(world, {
      source: { ...fakeSource(world), stop: async () => ({ kind: "failed", message: "docker stop exited 1" }) },
    });
    const result = await e.migrate();
    expect(result).toMatchObject({ kind: "migrated", oldStackStopped: false });
    expect((await state()).migration?.oldStackStopped).toBe(false);
  });
});

describe("migrate: resume after a crash at each step", () => {
  beforeEach(() => dockerInstall(world));

  it("while the old database comes up: starts over from the dump", async () => {
    await crashAt("bringUp");
    expect((await state()).migration?.step).toBe("started");
    expect((await engine(world).migrate()).kind).toBe("migrated");
    expect(world.calls[0]).toBe(`source.bringUp:${INSTALL_ID}`);
    expect((await state()).migration?.attempts).toBe(2);
  });

  it("mid-dump: the partial file is never taken for a dump, and the dump runs again", async () => {
    await crashAt("pgDump");
    expect((await state()).migration?.step).toBe("started");
    expect(migrationFiles(world)).toContain("vex.dump.partial");
    expect(migrationFiles(world)).not.toContain("vex.dump");
    expect((await engine(world).migrate()).kind).toBe("migrated");
    expect(world.calls).toContain("source.snapshot");
  });

  it("mid-restore: the half-restored cluster is dropped and the restore lands in a fresh one", async () => {
    await crashAt("pgRestore");
    expect((await state()).migration?.step).toBe("dumped");
    expect(existsSync(fakeDbFile(world))).toBe(true);
    const result = await engine(world).migrate();
    expect(result.kind).toBe("migrated");
    // No second dump; Docker is needed only for the final stop.
    expect(world.calls).toEqual([
      "native.start",
      "native.initdb",
      "pg_restore",
      "target.facts",
      "native.stop",
      `source.stop:${INSTALL_ID}`,
    ]);
  });

  it("after the restore committed: only verification runs again", async () => {
    await crashAt("readTarget");
    expect((await state()).migration?.step).toBe("restored");
    expect((await engine(world).migrate()).kind).toBe("migrated");
    expect(world.calls).toEqual(["native.start", "target.facts", "native.stop", `source.stop:${INSTALL_ID}`]);
  });

  it("after verification: only the finish runs again", async () => {
    await crashAt("stopSource");
    const s = await state();
    expect(s.migration?.step).toBe("verified");
    expect(s.provider).toBeUndefined();
    expect(await engine(world).detect()).toMatchObject({ kind: "pending", resumeStep: "verified" });
    const result = await engine(world).migrate();
    expect(result).toMatchObject({ kind: "migrated", oldStackStopped: true });
    if (result.kind === "migrated") expect(result.report?.ok).toBe(true);
    expect(world.calls).toEqual([`source.stop:${INSTALL_ID}`]);
    expect((await state()).provider).toBe("native");
  });

  it("refuses a dump that changed on disk between steps, then retries clean", async () => {
    await crashAt("pgRestore");
    writeFileSync(path.join(world.runtimeDir, "migration", "vex.dump"), "tampered");
    expect(await engine(world).migrate()).toMatchObject({ kind: "failed", reason: "dump_corrupt" });
    expect((await state()).migration?.step).toBe("started");
    expect((await engine(world).migrate()).kind).toBe("migrated");
  });

  it("stops an orphaned postmaster of the crashed session before dropping its data dir", async () => {
    await crashAt("pgRestore");
    writeFileSync(path.join(world.dataDir, "postmaster.pid"), `4242\n${world.dataDir}\n0\n${String(NATIVE_PORT)}\n\n\n\nready\n`);
    world.alivePids.add(4242);
    const reaping = engine(world, {
      createSupervisor: async () => {
        const s = fakeSupervisor(world);
        return { ...s, start: async (signal) => ((world.alivePids.delete(4242), s.start(signal))) };
      },
    });
    expect((await reaping.migrate()).kind).toBe("migrated");
  });

  it("never drops a data dir a live postmaster nobody could stop still holds", async () => {
    await crashAt("pgRestore");
    writeFileSync(path.join(world.dataDir, "postmaster.pid"), `4242\n${world.dataDir}\n0\n1\n\n\n\nready\n`);
    world.alivePids.add(4242);
    expect(await engine(world).migrate()).toMatchObject({ kind: "failed", reason: "native_cluster_busy" });
    expect(existsSync(path.join(world.dataDir, "PG_VERSION"))).toBe(true);
  });
});

describe("migrate: failures drop what the migration made and keep the install pending", () => {
  beforeEach(() => dockerInstall(world));

  async function expectCleanFailure(reason: string): Promise<void> {
    const s = await state();
    expect(s.migration).toMatchObject({ step: "started", dump: null, outcome: null });
    expect(s.migration?.lastFailure?.kind).toBe(reason);
    expect(s.provider).toBeUndefined();
    expect(s.pg).toBeNull();
    expect(existsSync(world.dataDir)).toBe(false);
    expect(migrationFiles(world)).toEqual([]);
    expect(world.calls.some((c) => c.startsWith("source.removeData"))).toBe(false);
    expect(await engine(world).detect()).toMatchObject({ kind: "pending", lastFailure: { kind: reason } });
  }

  it("a single missing row fails verification, with the table named in the report", async () => {
    world.corruptRestore = (f) => ({ ...f, tables: { ...f.tables, "public.messages": { rows: 39, digest: "other" } } });
    const result = await engine(world).migrate();
    expect(result).toMatchObject({ kind: "failed", reason: "verify_failed" });
    if (result.kind !== "failed") return;
    expect(result.report?.mismatches).toEqual(["table public.messages has 40 rows in the old database and 39 in the new one"]);
    await expectCleanFailure("verify_failed");
    // The stack the attempt started is stopped again.
    expect(world.calls).toContain(`source.stop:${INSTALL_ID}`);
  });

  it("a changed vector fails verification", async () => {
    world.corruptRestore = (f) => ({ ...f, vectorSample: { ...f.vectorSample, "3": "zz" } });
    const result = await engine(world).migrate();
    expect(result).toMatchObject({ kind: "failed", reason: "verify_failed" });
    if (result.kind === "failed") expect(result.report?.mismatches).toEqual(["knowledge_entries id 3: the embedding is not byte-equal"]);
    await expectCleanFailure("verify_failed");
  });

  it("a failed pg_restore", async () => {
    world.fail.pgRestore = 'pg_restore: error: could not execute query: ERROR:  type "vector" does not exist';
    const result = await engine(world).migrate();
    expect(result).toMatchObject({ kind: "failed", reason: "restore_failed" });
    if (result.kind === "failed") expect(result.message).toContain('type "vector" does not exist');
    await expectCleanFailure("restore_failed");
  });

  it("a failed pg_dump", async () => {
    world.fail.pgDump = "pg_dump: error: connection to server failed";
    expect(await engine(world).migrate()).toMatchObject({ kind: "failed", reason: "dump_failed" });
    await expectCleanFailure("dump_failed");
  });

  it("a full disk during the restore", async () => {
    world.fail.pgRestore = "ERROR: could not extend file: No space left on device";
    expect(await engine(world).migrate()).toMatchObject({ kind: "failed", reason: "disk_full" });
    await expectCleanFailure("disk_full");
  });

  it("not enough free space is caught before the dump, with the numbers", async () => {
    world.freeBytes = 1_000;
    const result = await engine(world).migrate();
    expect(result).toMatchObject({ kind: "failed", reason: "disk_full", availableBytes: 1_000, requiredBytes: 2_000_000 + 256 * 1024 * 1024 });
    expect(world.toolCalls).toEqual([]);
    await expectCleanFailure("disk_full");
  });

  it("an old database where setup never finished (no schema_version)", async () => {
    world.source = { ...sourceFacts(), schemaVersion: null };
    expect(await engine(world).migrate()).toMatchObject({ kind: "failed", reason: "source_empty" });
    await expectCleanFailure("source_empty");
  });

  it.each([
    [{ kind: "docker_unavailable", message: "Docker Desktop is not running" } as const, "docker_unavailable"],
    [{ kind: "no_volume", message: "no volume" } as const, "no_docker_volume"],
    [{ kind: "failed", message: "rejects this install's credentials" } as const, "source_unavailable"],
  ])("the old database cannot be brought up (%o)", async (bringUp, reason) => {
    world.bringUp = bringUp;
    expect(await engine(world).migrate()).toMatchObject({ kind: "failed", reason, message: bringUp.message });
    expect(world.toolCalls).toEqual([]);
    await expectCleanFailure(reason);
  });

  it("the built-in database does not start", async () => {
    world.fail.nativeStart = "port taken";
    expect(await engine(world).migrate()).toMatchObject({ kind: "failed", reason: "native_start_failed" });
    await expectCleanFailure("native_start_failed");
  });

  it("the bundled tree is missing: nothing touches Docker", async () => {
    const result = await engine(world, { locateClientTools: async () => ({ kind: "unavailable", detail: "no pg_dump" }) }).migrate();
    expect(result).toMatchObject({ kind: "failed", reason: "native_unavailable", message: "no pg_dump" });
    expect(world.calls.filter((c) => c.startsWith("source.bringUp"))).toEqual([]);
  });

  it("Retry after a failure starts clean and succeeds", async () => {
    world.fail.pgRestore = "boom";
    await engine(world).migrate();
    delete world.fail.pgRestore;
    const result = await engine(world).migrate();
    expect(result.kind).toBe("migrated");
    expect((await state()).migration).toMatchObject({ step: "completed", attempts: 2, lastFailure: null });
  });
});

describe("migrate: cancellation keeps what is durable", () => {
  beforeEach(() => dockerInstall(world));

  it("aborted mid-dump: cancelled at `started`, no partial dump left, nothing dropped", async () => {
    const controller = new AbortController();
    const e = engine(world, {
      runTool: async (_command, args, options) => {
        writeFileSync(argValue(args, "-f"), "partial");
        controller.abort();
        expect(options.signal?.aborted).toBe(true);
        return { code: null, stdout: "", stderr: "" };
      },
    });
    expect(await e.migrate({ signal: controller.signal })).toEqual({ kind: "cancelled", resumeStep: "started" });
    expect(migrationFiles(world)).toEqual([]);
    expect((await state()).migration?.lastFailure).toBeNull();
  });

  it("aborted mid-restore: cancelled at `dumped`, the next launch resumes the restore", async () => {
    const controller = new AbortController();
    let restores = 0;
    const e = engine(world, {
      runTool: async (command, args, options) => {
        if (command.endsWith("pg_restore") && restores++ === 0) {
          controller.abort();
          return { code: null, stdout: "", stderr: "" };
        }
        writeFileSync(argValue(args, "-f"), JSON.stringify(world.source));
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(await e.migrate({ signal: controller.signal })).toEqual({ kind: "cancelled", resumeStep: "dumped" });
    expect(migrationFiles(world)).toEqual(["source-facts.json", "vex.dump"]);
    expect((await engine(world).migrate()).kind).toBe("migrated");
  });
});

describe("startFresh", () => {
  beforeEach(() => dockerInstall(world));

  it("creates a fresh cluster and flips the provider; Docker is only asked whether the volume exists", async () => {
    expect(await engine(world).startFresh()).toEqual({ kind: "started_fresh" });
    const s = await state();
    expect(s.provider).toBe("native");
    expect(s.pg?.systemIdentifier).toBe(SYSID);
    expect(s.migration).toMatchObject({ step: "completed", outcome: "fresh", installId: INSTALL_ID });
    expect(world.calls).toEqual([`source.probe:${INSTALL_ID}`, "native.start", "native.initdb", "native.stop"]);
    expect(await engine(world).detect()).toEqual({ kind: "not_needed", reason: "started_fresh" });
    expect(await engine(world).startFresh()).toEqual({ kind: "started_fresh" });
  });

  it("after an interrupted migration, drops that attempt's cluster and dump and starts empty", async () => {
    await crashAt("readTarget");
    expect((await state()).migration?.step).toBe("restored");
    expect(existsSync(fakeDbFile(world))).toBe(true);
    expect(await engine(world).startFresh()).toEqual({ kind: "started_fresh" });
    expect(existsSync(fakeDbFile(world))).toBe(false);
    expect(migrationFiles(world)).toEqual([]);
    // The stack that attempt started is stopped; the volume is not touched.
    expect(world.calls).toContain(`source.stop:${INSTALL_ID}`);
    expect(world.calls.some((c) => c.startsWith("source.removeData"))).toBe(false);
  });

  it("works with Docker gone", async () => {
    world.probe = { kind: "unreachable", detail: "docker: command not found" };
    expect(await engine(world).startFresh()).toEqual({ kind: "started_fresh" });
  });

  it("is refused once the data was migrated", async () => {
    await engine(world).migrate();
    expect(await engine(world).startFresh()).toMatchObject({ kind: "failed", reason: "not_pending" });
  });
});

describe("removeOldData", () => {
  beforeEach(() => dockerInstall(world));

  it("is refused while the migration has not completed", async () => {
    expect(await engine(world).removeOldData()).toMatchObject({ kind: "refused", reason: "not_completed" });
    world.fail.pgRestore = "boom";
    await engine(world).migrate();
    expect(await engine(world).removeOldData()).toMatchObject({ kind: "refused", reason: "not_completed" });
    expect(world.calls.some((c) => c.startsWith("source.removeData"))).toBe(false);
  });

  it("after start fresh, only with the explicit acknowledgement", async () => {
    await engine(world).startFresh();
    expect(await engine(world).removeOldData()).toMatchObject({ kind: "refused", reason: "not_imported" });
    expect(await engine(world).removeOldData({ allowWithoutImport: true })).toMatchObject({ kind: "removed" });
  });

  it("after a completed migration, for this install's project only", async () => {
    await engine(world).migrate();
    expect(await engine(world).removeOldData()).toMatchObject({ kind: "removed" });
    expect(world.calls.filter((c) => c.startsWith("source.removeData"))).toEqual([`source.removeData:${INSTALL_ID}`]);
  });

  it("is refused when the install id changed since", async () => {
    await engine(world).migrate();
    writeFileSync(path.join(world.configDir, ".install-id"), "another");
    expect(await engine(world).removeOldData()).toMatchObject({ kind: "refused", reason: "install_changed" });
  });
});
