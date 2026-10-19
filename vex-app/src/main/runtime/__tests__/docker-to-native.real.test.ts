/**
 * The Docker-to-native migration end to end, on this machine, with nothing
 * faked: the SAME pinned image the app ships (pgvector 0.8.2 on PG18, from the
 * compose template), the app's own compose code, its 169 migrations, the
 * bundled pg_dump / pg_restore / postgres, and the real pg_password.
 *
 *   1. The "previous release": a disposable compose project for a test-only
 *      install id (`migtest-...`), its `db` service up on a free port, every
 *      migration applied, realistic data seeded (sessions, messages, jsonb,
 *      knowledge_entries with 768-dim vectors, wallet intents), then stopped
 *      as the old app's quit would leave it.
 *   2. Migrate into a native cluster under a temp RUNTIME_DIR: verified, the
 *      provider flipped, the volume still there, the stack stopped, and the
 *      native cluster serves the data (counts, exact vectors, a cosine
 *      search, the migration runner a no-op).
 *   3. A crash right after pg_restore committed, with an orphaned postmaster
 *      left on the data dir; and a crash during verification. Both resume.
 *   4. A forced verification failure (a row deleted and a vector changed in
 *      the copy): the copy is dropped, the volume and its data untouched.
 *   5. "Remove old Docker data" removes exactly this project's volumes.
 *
 * Every container and volume this creates carries the `migtest-` install id
 * and is removed in afterAll; nothing else on the machine is touched.
 *
 * Skipped, visibly, when Docker does not answer, the pinned image is not
 * present locally (no pull from a test), or the native tree is not built.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "", getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createDockerMigration } = await import("../migration/docker-to-native.js");
const { createDockerSource } = await import("../migration/docker-source.js");
const { createPostgresSupervisor, runPgTool } = await import("../native/postgres-supervisor.js");
const { locatePostgresBinaries, locatePostgresClientTools, pgDataDir, runtimeStatePath } = await import("../runtime-paths.js");
const { readRuntimeState } = await import("../runtime-state.js");
const { getPgPassword } = await import("../secrets/pg-password.js");
const { __resetCriticalOpsForTests } = await import("../../updates/critical-ops.js");
const { runMigrationsWithProgress } = await import("../../../../../src/lib/db/migrate-runner.js");
const { createPreviousRelease, dockerAnswers, IMAGE, MIGRATIONS_DIR, REPO_ROOT, SEED } = await import("./support/previous-release.js");

type Deps = Parameters<typeof createDockerMigration>[0];
type MigrateResult = Awaited<ReturnType<ReturnType<typeof createDockerMigration>["migrate"]>>;
type PreviousRelease = Awaited<ReturnType<typeof createPreviousRelease>>;

const STEP_TIMEOUT_MS = 300_000;

const pgLocation = await locatePostgresBinaries({ packaged: false, repoRoot: REPO_ROOT });
const toolsLocation = await locatePostgresClientTools({ packaged: false, repoRoot: REPO_ROOT });
const unavailable =
  process.platform === "win32"
    ? "no Windows tree to run against here"
    : pgLocation.kind === "unavailable"
      ? pgLocation.detail
      : toolsLocation.kind === "unavailable"
        ? toolsLocation.detail
        : IMAGE === ""
          ? "the compose template names no pgvector image"
          : dockerAnswers();
const TITLE = "the Docker-to-native migration, end to end on this machine";

describe.skipIf(unavailable !== null)(unavailable === null ? TITLE : `${TITLE} (skipped: ${unavailable})`, () => {
  let release: PreviousRelease | undefined;
  let installId = "";
  let project = "";
  let volumes: readonly string[] = [];
  let root: string;
  let configDir: string;
  let sourcePort = 0;
  let password = "";
  const orphans: ChildProcess[] = [];
  const evidence: Record<string, unknown> = {};
  let seededVectors: Map<number, string>;
  let seededMessages = 0;

  const prev = (): PreviousRelease => {
    if (release === undefined) throw new Error("the previous release was not set up");
    return release;
  };
  const binaries = (): Extract<typeof pgLocation, { kind: "found" }>["binaries"] => {
    if (pgLocation.kind !== "found") throw new Error("unreachable");
    return pgLocation.binaries;
  };
  const renderDeps = (): ReturnType<PreviousRelease["renderDeps"]> => prev().renderDeps();
  const docker = (args: readonly string[]): ReturnType<PreviousRelease["docker"]> => prev().docker(args);
  const volumeExists = (name: string): boolean => prev().volumeExists(name);
  const runningContainers = (): string[] => prev().runningContainers();
  const withClient = <T,>(port: number, body: (c: pg.Client) => Promise<T>): Promise<T> => prev().withClient(port, body);
  const bringSourceUp = (): Promise<void> => prev().bringUp();
  const stopSource = (): Promise<void> => prev().stop();

  function migration(runtimeDir: string, overrides: Partial<Deps> = {}): ReturnType<typeof createDockerMigration> {
    __resetCriticalOpsForTests();
    return createDockerMigration({
      configDir,
      runtimeDir,
      source: createDockerSource({ renderDeps: renderDeps(), pgPort: sourcePort }),
      locateClientTools: () => locatePostgresClientTools({ packaged: false, repoRoot: REPO_ROOT }),
      createSupervisor: async () =>
        createPostgresSupervisor({
          runtimeDir,
          binaries: binaries(),
          ensurePasswordFile: async () => (await getPgPassword(renderDeps())).composePath,
        }),
      runTool: runPgTool,
      ...overrides,
    });
  }

  async function nativeSupervisor(runtimeDir: string): Promise<{ port: number; stop: () => Promise<unknown> }> {
    const s = createPostgresSupervisor({
      runtimeDir,
      binaries: binaries(),
      ensurePasswordFile: async () => (await getPgPassword(renderDeps())).composePath,
    });
    const started = await s.start();
    expect(started.kind, started.message).toBe("running");
    return { port: started.connection?.pgPort ?? 0, stop: () => s.stop() };
  }

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "vex migration ë-"));
    configDir = path.join(root, "config");

    // ── The previous release: db up, 169 migrations, data, stopped. ──
    const startedAt = Date.now();
    release = await createPreviousRelease({ configDir });
    ({ installId, project, volumes, sourcePort } = release);
    const seeded = await release.seed();
    password = release.password();
    evidence["migrationsApplied"] = seeded.migrationsApplied;
    seededVectors = seeded.vectors;
    seededMessages = seeded.messages;
    evidence["seeded"] = seeded.counts;
    evidence["sourceDatabaseSize"] = seeded.databaseSize;
    evidence["sourceSetupMs"] = Date.now() - startedAt;
    expect(volumeExists(volumes[0] as string)).toBe(true);
  }, 600_000);

  afterAll(async () => {
    for (const child of orphans) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGQUIT");
    }
    // Only this test's own project and volumes, by their migtest- names.
    release?.removeAll();
    // The measurements, for whoever runs this by hand (sizes, timings, the report).
    const evidenceFile = process.env["VEX_MIGRATION_E2E_EVIDENCE"];
    if (evidenceFile !== undefined && path.isAbsolute(evidenceFile)) {
      writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }, 180_000);

  const runtimeDirs = {
    happy: (): string => path.join(root, "runtime-happy"),
    crash: (): string => path.join(root, "runtime-crash"),
    verify: (): string => path.join(root, "runtime-verify"),
    fail: (): string => path.join(root, "runtime-fail"),
  };

  it("detects the stopped Docker install as pending", { timeout: STEP_TIMEOUT_MS }, async () => {
    expect(await migration(runtimeDirs.happy()).detect()).toEqual({ kind: "pending", installId, resumeStep: null, lastFailure: null });
  });

  it("migrates: verified, provider flipped, the volume kept, the stack stopped", { timeout: STEP_TIMEOUT_MS }, async () => {
    const runtimeDir = runtimeDirs.happy();
    const marks: Record<string, number> = {};
    let dumpBytes = 0;
    const startedAt = Date.now();
    const m = migration(runtimeDir, {
      runTool: async (command, args, options) => {
        const result = await runPgTool(command, args, options);
        if (command.endsWith("pg_dump") && result.code === 0) dumpBytes = statSync(args[args.indexOf("-f") + 1] as string).size;
        return result;
      },
    });
    const result = await m.migrate({
      onProgress: (p) => {
        marks[p.phase] ??= Date.now() - startedAt;
      },
    });
    evidence["happyTotalMs"] = Date.now() - startedAt;
    evidence["happyPhaseStartMs"] = marks;
    evidence["dumpBytes"] = dumpBytes;
    expect(result.kind, JSON.stringify(result)).toBe("migrated");
    if (result.kind !== "migrated") return;
    evidence["report"] = result.report;
    expect(result.report).toMatchObject({ ok: true, schemaVersion: 177, sampledVectors: 64 });
    expect(result.report?.vectors).toBe(SEED.knowledge);
    expect(result.oldStackStopped).toBe(true);

    const state = await readRuntimeState(runtimeStatePath(runtimeDir));
    expect(state.provider).toBe("native");
    expect(state.migration).toMatchObject({ installId, step: "completed", outcome: "migrated", dump: null });
    expect(readdirSync(path.join(runtimeDir, "migration"))).toEqual([]);
    // The Docker volume is untouched and the stack is stopped, not removed.
    expect(volumeExists(volumes[0] as string)).toBe(true);
    expect(runningContainers()).toEqual([]);
    expect(docker(["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"]).stdout).toContain("db");
    expect(await m.detect()).toEqual({ kind: "not_needed", reason: "migrated" });
  });

  it("the native cluster serves the migrated data", { timeout: STEP_TIMEOUT_MS }, async () => {
    const native = await nativeSupervisor(runtimeDirs.happy());
    try {
      await withClient(native.port, async (c) => {
        const counts = await c.query<{ s: string; m: string; k: string; w: string; v: number }>(
          `SELECT (SELECT count(*) FROM sessions)::text AS s, (SELECT count(*) FROM messages)::text AS m,
                  (SELECT count(*) FROM knowledge_entries)::text AS k, (SELECT count(*) FROM wallet_intents)::text AS w,
                  (SELECT max(version) FROM schema_version)::int AS v`,
        );
        expect(counts.rows[0]).toEqual({
          s: String(SEED.sessions), m: String(seededMessages), k: String(SEED.knowledge), w: String(SEED.walletIntents), v: 177,
        });
        // Every vector, exactly as the old database printed it.
        const vectors = await c.query<{ id: number; v: string }>("SELECT id, embedding::text AS v FROM knowledge_entries");
        expect(vectors.rows.length).toBe(seededVectors.size);
        for (const row of vectors.rows) expect(row.v).toBe(seededVectors.get(row.id));
        // pgvector works on the copy: the nearest neighbour of a stored vector is itself.
        const [someId, someVector] = [...seededVectors.entries()][1234] as [number, string];
        const nearest = await c.query<{ id: number }>("SELECT id FROM knowledge_entries ORDER BY embedding <=> $1::vector LIMIT 1", [someVector]);
        expect(nearest.rows[0]?.id).toBe(someId);
        const ext = await c.query<{ v: string }>("SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'");
        evidence["nativeVectorVersion"] = ext.rows[0]?.v;
        const jsonb = await c.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM messages WHERE tool_calls->0->'function'->'arguments'->'nested'->'a' = '[1, 2.5, null, true]'::jsonb",
        );
        expect(Number(jsonb.rows[0]?.n)).toBe(SEED.sessions * (SEED.messagesPerSession / 5));
        // The next insert does not collide with a migrated id.
        const next = await c.query<{ id: number }>(
          "INSERT INTO knowledge_entries (kind, title, summary, content_hash, embedding_model, embedding_dim, embedding) VALUES ('k','t','s',$1,'m',3,'[1,2,3]') RETURNING id",
          [`after-${randomUUID()}`],
        );
        expect(next.rows[0]?.id).toBeGreaterThan(Math.max(...seededVectors.keys()));
      });
      // schema_version came across: the migration runner has nothing to do.
      const pool = new pg.Pool({ host: "127.0.0.1", port: native.port, user: "vex", password, database: "vex", max: 1 });
      try {
        expect((await runMigrationsWithProgress({ pool, migrationsDir: MIGRATIONS_DIR })).applied).toBe(0);
      } finally {
        await pool.end();
      }
    } finally {
      await native.stop();
    }
  });

  it("resumes after a crash right after pg_restore committed, reaping the orphaned postmaster", { timeout: STEP_TIMEOUT_MS }, async () => {
    const runtimeDir = runtimeDirs.crash();
    const dataDir = pgDataDir(runtimeDir);
    const frozen: { supervisor: ReturnType<typeof createPostgresSupervisor> | null } = { supervisor: null };
    let reached!: () => void;
    let rejectFrozen!: (e: Error) => void;
    const frozenAt = new Promise<void>((r, reject) => {
      rejectFrozen = reject;
      reached = r;
    });
    const first = migration(runtimeDir, {
      createSupervisor: async () => {
        frozen.supervisor = createPostgresSupervisor({
          runtimeDir,
          binaries: binaries(),
          ensurePasswordFile: async () => (await getPgPassword(renderDeps())).composePath,
        });
        return frozen.supervisor;
      },
      runTool: async (command, args, options) => {
        const result = await runPgTool(command, args, options);
        if (command.endsWith("pg_restore")) {
          expect(result.code, result.stderr).toBe(0);
          reached();
          return new Promise(() => {}); // the process "dies" here
        }
        return result;
      },
    });
    void first.migrate().then((r) => rejectFrozen(new Error(`the migration settled instead of freezing: ${JSON.stringify(r)}`)));
    await frozenAt;
    expect((await readRuntimeState(runtimeStatePath(runtimeDir))).migration?.step).toBe("dumped");
    // The dead process's postmaster is gone with it; what a crashed main
    // really leaves is a postmaster nobody supervises, holding the data dir.
    if (frozen.supervisor === null) throw new Error("the migration never created its supervisor");
    await frozen.supervisor.stop();
    const state = await readRuntimeState(runtimeStatePath(runtimeDir));
    const orphan = spawn(binaries().postgres, ["-D", dataDir, "-p", String(state.pg?.lastPort ?? 0)], { stdio: "ignore" });
    orphans.push(orphan);
    for (let i = 0; i < 400; i++) {
      const lines = existsSync(path.join(dataDir, "postmaster.pid")) ? readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\n") : [];
      if (Number(lines[0]) === orphan.pid && lines[7]?.trim() === "ready") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const orphanGone = new Promise<void>((r) => orphan.once("exit", () => r()));

    expect(await migration(runtimeDir).detect()).toMatchObject({ kind: "pending", resumeStep: "dumped" });
    const startedAt = Date.now();
    const resumed = await migration(runtimeDir).migrate();
    evidence["resumeAfterRestoreMs"] = Date.now() - startedAt;
    expect(resumed.kind, JSON.stringify(resumed)).toBe("migrated");
    await orphanGone;
    expect((resumed as Extract<MigrateResult, { kind: "migrated" }>).report?.ok).toBe(true);
    expect(volumeExists(volumes[0] as string)).toBe(true);
    expect(runningContainers()).toEqual([]);
  });

  it("resumes after a crash during verification: verification only", { timeout: STEP_TIMEOUT_MS }, async () => {
    const runtimeDir = runtimeDirs.verify();
    const frozen: { supervisor: ReturnType<typeof createPostgresSupervisor> | null } = { supervisor: null };
    let reached!: () => void;
    let rejectFrozen!: (e: Error) => void;
    const frozenAt = new Promise<void>((r, reject) => {
      rejectFrozen = reject;
      reached = r;
    });
    const first = migration(runtimeDir, {
      createSupervisor: async () => {
        const s = createPostgresSupervisor({
          runtimeDir,
          binaries: binaries(),
          ensurePasswordFile: async () => (await getPgPassword(renderDeps())).composePath,
        });
        frozen.supervisor = s;
        return s;
      },
      facts: {
        openSource: (await import("../migration/database-facts.js")).pgDatabaseFactsReader.openSource,
        readTarget: () => {
          reached();
          return new Promise(() => {});
        },
      },
    });
    void first.migrate().then((r) => rejectFrozen(new Error(`the migration settled instead of freezing: ${JSON.stringify(r)}`)));
    await frozenAt;
    expect((await readRuntimeState(runtimeStatePath(runtimeDir))).migration?.step).toBe("restored");
    if (frozen.supervisor === null) throw new Error("the migration never created its supervisor");
    await frozen.supervisor.stop();

    const tools: string[] = [];
    const resumed = await migration(runtimeDir, {
      runTool: async (command, args, options) => {
        tools.push(path.basename(command));
        return runPgTool(command, args, options);
      },
    }).migrate();
    expect(resumed.kind, JSON.stringify(resumed)).toBe("migrated");
    expect(tools).toEqual([]); // no second dump, no second restore
  });

  it("a copy that lost a row and changed a vector fails verification and is dropped; the volume is untouched", { timeout: STEP_TIMEOUT_MS }, async () => {
    const runtimeDir = runtimeDirs.fail();
    const result = await migration(runtimeDir, {
      runTool: async (command, args, options) => {
        const r = await runPgTool(command, args, options);
        if (command.endsWith("pg_restore") && r.code === 0) {
          // Sabotage the COPY, never the source.
          const port = Number(args[args.indexOf("-p") + 1]);
          await withClient(port, async (c) => {
            await c.query("DELETE FROM messages WHERE id = (SELECT max(id) FROM messages)");
            await c.query("UPDATE knowledge_entries SET embedding = embedding + embedding WHERE id = (SELECT min(id) FROM knowledge_entries)");
          });
        }
        return r;
      },
    }).migrate();
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    evidence["forcedFailureMismatches"] = result.report?.mismatches;
    expect(result.reason, result.message).toBe("verify_failed");
    expect(result.report?.mismatches).toEqual(
      expect.arrayContaining([
        `table public.messages has ${String(seededMessages)} rows in the old database and ${String(seededMessages - 1)} in the new one`,
        `table public.knowledge_entries has the same ${String(SEED.knowledge)} rows but different content`,
        "vector column public.knowledge_entries.embedding: the vectors are not byte-equal",
      ]),
    );

    const state = await readRuntimeState(runtimeStatePath(runtimeDir));
    expect(state.migration).toMatchObject({ step: "started", dump: null, lastFailure: { kind: "verify_failed" } });
    expect(state.provider).toBeUndefined();
    expect(state.pg).toBeNull();
    expect(existsSync(pgDataDir(runtimeDir))).toBe(false);
    expect(readdirSync(path.join(runtimeDir, "migration"))).toEqual([]);
    expect(runningContainers()).toEqual([]);

    // The old database still holds every row.
    await bringSourceUp();
    try {
      await withClient(sourcePort, async (c) => {
        const r = await c.query<{ n: string }>("SELECT count(*)::text AS n FROM messages");
        expect(Number(r.rows[0]?.n)).toBe(seededMessages);
      });
    } finally {
      await stopSource();
    }
    expect(await migration(runtimeDir).detect()).toMatchObject({ kind: "pending", lastFailure: { kind: "verify_failed" } });
  });

  it("removes the old Docker data of this project only, once migrated", { timeout: STEP_TIMEOUT_MS }, async () => {
    expect(await migration(runtimeDirs.fail()).removeOldData()).toMatchObject({ kind: "refused", reason: "not_completed" });
    expect(volumeExists(volumes[0] as string)).toBe(true);
    const removed = await migration(runtimeDirs.happy()).removeOldData();
    expect(removed.kind, JSON.stringify(removed)).toBe("removed");
    for (const v of volumes) expect(volumeExists(v), v).toBe(false);
    expect(docker(["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"]).stdout.trim()).toBe("");
  });
});
