/**
 * The supervisor against the REAL bundled Postgres tree
 * (`native-runtime/out/<platform>-<arch>/postgres`, or VEX_NATIVE_PG_DIR),
 * with the real pg_password generator and the real `pg` client the app ships.
 *
 * One cluster, walked through its life in order: initdb into a path with a
 * space and a non-ASCII character, SCRAM login, identity, a SIGKILLed
 * postmaster restarted by supervision, fast stop, a forged identity, an
 * orphaned postmaster from a "previous session", a SIGKILLed orphan's stale
 * postmaster.pid, and a taken port.
 *
 * Skipped, visibly, when the tree has not been built on this machine
 * (`native-runtime/postgres/build.sh <target>`). The Windows path (pg_ctl) is
 * not exercised here: there is no Windows tree.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "" } }));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { locatePostgresBinaries, pgDataDir, runtimeStatePath } = await import("../runtime-paths.js");
const { createPostgresSupervisor } = await import("../native/postgres-supervisor.js");
const { checkPgIdentity } = await import("../native/pg-identity.js");
const { getPgPassword } = await import("../../compose/render.js");
const { makeElectronSecretAdapter } = await import("../../compose/electron-secret-adapter.js");
type Supervisor = ReturnType<typeof createPostgresSupervisor>;
type Health = Parameters<Parameters<Supervisor["onHealthChange"]>[0]>[0];

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");
const location = await locatePostgresBinaries({ packaged: false, repoRoot: REPO_ROOT });
const unavailable =
  process.platform === "win32"
    ? "the Windows lifecycle goes through pg_ctl and has no tree to run against here"
    : location.kind === "unavailable"
      ? location.detail
      : null;
const TITLE = "the native Postgres supervisor on the bundled tree";
const STEP_TIMEOUT_MS = 90_000;

// The reason rides in the title, so the reporter says WHY it skipped.
describe.skipIf(unavailable !== null)(unavailable === null ? TITLE : `${TITLE} (skipped: ${unavailable})`, () => {
  let root: string;
  let runtimeDir: string;
  let dataDir: string;
  let userDataDir: string;
  let password = "";
  let passwordPath = "";
  let port = 0;
  const supervisors: Supervisor[] = [];
  const orphans: ChildProcess[] = [];
  const holders: Server[] = [];

  const binaries = (): NonNullable<Extract<typeof location, { kind: "found" }>["binaries"]> => {
    if (location.kind !== "found") throw new Error("unreachable");
    return location.binaries;
  };

  function supervisor(): Supervisor {
    const s = createPostgresSupervisor({
      runtimeDir,
      binaries: binaries(),
      ensurePasswordFile: async () =>
        (
          await getPgPassword({
            userDataDir,
            secretAdapter: makeElectronSecretAdapter(),
            randomAdapter: { uuid: () => randomUUID(), randomBytes: (n) => randomBytes(n) },
            cryptoAdapter: { base64url: (b) => Buffer.from(b).toString("base64url") },
          })
        ).composePath,
    });
    supervisors.push(s);
    return s;
  }

  function client(options: { password?: string; port?: number } = {}): pg.Client {
    return new pg.Client({
      host: "127.0.0.1",
      port: options.port ?? port,
      user: "vex",
      password: options.password ?? password,
      database: "vex",
      connectionTimeoutMillis: 5_000,
    });
  }

  async function query<T>(sql: string): Promise<T[]> {
    const c = client();
    await c.connect();
    try {
      return (await c.query(sql)).rows as T[];
    } finally {
      await c.end();
    }
  }

  function pidFile(): string | null {
    const file = path.join(dataDir, "postmaster.pid");
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }

  function postmasterPid(): number {
    return Number(pidFile()?.split("\n")[0]);
  }

  function recorded(): { systemIdentifier: string; lastPort: number } {
    return JSON.parse(readFileSync(runtimeStatePath(runtimeDir), "utf8")).pg;
  }

  /** A postmaster main did not start in this session: what a crashed main leaves. */
  async function startOrphan(): Promise<ChildProcess> {
    const child = spawn(binaries().postgres, ["-D", dataDir, "-p", String(port)], { stdio: "ignore" });
    orphans.push(child);
    for (let i = 0; i < 400; i++) {
      const lines = pidFile()?.split("\n") ?? [];
      if (Number(lines[0]) === child.pid && lines[7]?.trim() === "ready") return child;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("orphan postmaster did not become ready");
  }

  function exited(child: ChildProcess): Promise<void> {
    return child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((r) => child.once("exit", () => r()));
  }

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "vex pg supervisor ü-"));
    runtimeDir = path.join(root, "Application Support", "vëx", "runtime");
    dataDir = pgDataDir(runtimeDir);
    userDataDir = path.join(root, "Application Support", "vëx");
  });

  afterAll(async () => {
    for (const s of supervisors) await s.stop({ deadlineMs: 10_000 }).catch(() => {});
    for (const child of orphans) {
      if (child.exitCode === null && child.signalCode === null) {
        // Immediate, not SIGKILL: SIGKILL leaks SysV IPC on macOS.
        child.kill("SIGQUIT");
        await Promise.race([exited(child), new Promise((r) => setTimeout(r, 10_000))]);
      }
    }
    await Promise.all(holders.map((h) => new Promise((r) => h.close(r))));
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the cluster on first start and serves vex over SCRAM", { timeout: STEP_TIMEOUT_MS }, async () => {
    const result = await supervisor().start();
    expect(result.kind, result.message).toBe("running");
    expect(result.connection?.host).toBe("127.0.0.1");
    port = result.connection?.pgPort ?? 0;
    passwordPath = result.connection?.pgPasswordPath ?? "";
    // The existing generator's file, under CONFIG_DIR/local-infra/secrets.
    expect(passwordPath).toBe(path.join(userDataDir, "local-infra", "secrets", "pg_password"));
    password = readFileSync(passwordPath, "utf8").trim();

    expect(readFileSync(path.join(dataDir, "PG_VERSION"), "utf8").trim()).toBe("18");
    // The pwfile and the initdb staging dir are gone.
    expect(existsSync(path.join(runtimeDir, ".initdb-pwfile"))).toBe(false);
    expect(existsSync(`${dataDir}.initdb`)).toBe(false);

    const [who] = await query<{ db: string; usr: string; super: boolean; enc: string; prov: string }>(
      "SELECT current_database() AS db, current_user AS usr, rolsuper AS super, "
        + "pg_encoding_to_char(encoding) AS enc, datlocprovider AS prov "
        + "FROM pg_roles, pg_database WHERE rolname = current_user AND datname = current_database()",
    );
    expect(who).toEqual({ db: "vex", usr: "vex", super: true, enc: "UTF8", prov: "b" });
    const [method] = await query<{ v: string }>("SELECT setting AS v FROM pg_settings WHERE name = 'password_encryption'");
    expect(method?.v).toBe("scram-sha-256");

    const wrong = client({ password: "not-the-password" });
    await expect(wrong.connect()).rejects.toMatchObject({ code: "28P01" });
    await wrong.end().catch(() => {});

    await query("CREATE TABLE survives (id int PRIMARY KEY)");
    await query("INSERT INTO survives VALUES (1)");
  });

  it("records the identity both sources agree on, and it checks out", { timeout: STEP_TIMEOUT_MS }, async () => {
    const [row] = await query<{ id: string }>("SELECT system_identifier::text AS id FROM pg_control_system()");
    expect(recorded().systemIdentifier).toBe(row?.id);
    expect(recorded().lastPort).toBe(port);
    expect(await checkPgIdentity(port, password, recorded().systemIdentifier)).toEqual({ kind: "usable" });
    expect((await checkPgIdentity(port, password, "1")).kind).toBe("foreign_listener");
  });

  it("restarts a SIGKILLed postmaster, with the committed row recovered", { timeout: STEP_TIMEOUT_MS }, async () => {
    const s = supervisors[0];
    if (s === undefined) throw new Error("no supervisor");
    const health: Health[] = [];
    s.onHealthChange((h) => health.push(h));
    const killed = postmasterPid();
    process.kill(killed, "SIGKILL");
    for (let i = 0; i < 600 && !health.some((h) => h.kind !== "restarting"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(health[0]).toEqual({ kind: "restarting", attempt: 1 });
    const up = health.find((h) => h.kind !== "restarting");
    expect(up?.kind).toBe("running");
    if (up?.kind === "running") port = up.connection.pgPort;
    expect(postmasterPid()).not.toBe(killed);
    expect(await query<{ id: number }>("SELECT id FROM survives")).toEqual([{ id: 1 }]);
  });

  it("fast stop leaves no postmaster.pid", { timeout: STEP_TIMEOUT_MS }, async () => {
    const result = await supervisors[0]?.stop({ deadlineMs: 15_000 });
    expect(result).toMatchObject({ kind: "stopped", mode: "fast" });
    expect(pidFile()).toBeNull();
  });

  it("a wrong recorded system_identifier is foreign_listener, and our postmaster is stopped", { timeout: STEP_TIMEOUT_MS }, async () => {
    const statePath = runtimeStatePath(runtimeDir);
    const original = readFileSync(statePath, "utf8");
    const state = JSON.parse(original);
    writeFileSync(statePath, JSON.stringify({ ...state, pg: { ...state.pg, systemIdentifier: "1" } }));
    try {
      const result = await supervisor().start();
      expect(result.kind, result.message).toBe("foreign_listener");
      expect(result.connection).toBeNull();
      expect(pidFile()).toBeNull();
    } finally {
      writeFileSync(statePath, original);
    }
  });

  it("a new session stops an orphaned postmaster and reuses the cluster (no initdb)", { timeout: STEP_TIMEOUT_MS }, async () => {
    const versionBefore = readFileSync(path.join(dataDir, "PG_VERSION"));
    const identityBefore = recorded().systemIdentifier;
    const orphan = await startOrphan();
    const result = await supervisor().start();
    expect(result.kind, result.message).toBe("running");
    await exited(orphan);
    // Fast shutdown, not a kill.
    expect(orphan.exitCode).toBe(0);
    expect(postmasterPid()).not.toBe(orphan.pid);
    expect(recorded().systemIdentifier).toBe(identityBefore);
    expect(readFileSync(path.join(dataDir, "PG_VERSION"))).toEqual(versionBefore);
    expect(await query<{ id: number }>("SELECT id FROM survives")).toEqual([{ id: 1 }]);
    expect((await supervisors.at(-1)?.stop())?.kind).toBe("stopped");
  });

  it("starts over a SIGKILLed postmaster's stale postmaster.pid", { timeout: STEP_TIMEOUT_MS }, async () => {
    const orphan = await startOrphan();
    await query("INSERT INTO survives VALUES (2)");
    orphan.kill("SIGKILL");
    await exited(orphan);
    // The file stays behind, still naming the dead PID as ready.
    expect(postmasterPid()).toBe(orphan.pid);
    expect(pidFile()?.split("\n")[7]?.trim()).toBe("ready");

    const result = await supervisor().start();
    expect(result.kind, result.message).toBe("running");
    expect(postmasterPid()).not.toBe(orphan.pid);
    expect(await query<{ id: number }>("SELECT id FROM survives ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
    expect((await supervisors.at(-1)?.stop())?.kind).toBe("stopped");
  });

  it("picks another port when the last one is held by another listener", { timeout: STEP_TIMEOUT_MS }, async () => {
    const held = recorded().lastPort;
    const holder = createServer();
    holders.push(holder);
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.listen(held, "127.0.0.1", () => resolve());
    });
    const result = await supervisor().start();
    expect(result.kind, result.message).toBe("running");
    port = result.connection?.pgPort ?? 0;
    expect(port).not.toBe(held);
    expect(recorded().lastPort).toBe(port);
    expect(await query<{ id: number }>("SELECT count(*)::int AS id FROM survives")).toEqual([{ id: 2 }]);
    expect((await supervisors.at(-1)?.stop())?.kind).toBe("stopped");
    expect(pidFile()).toBeNull();
  });
});
