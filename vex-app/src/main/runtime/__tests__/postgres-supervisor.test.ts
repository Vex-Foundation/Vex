/**
 * The supervisor's decisions, against scripted postmasters: readiness, the
 * failed-start ladder, identity, the reaper, the restart budget and the stop
 * escalation. The data dir is a real temp directory (the supervisor reads
 * postmaster.pid, PG_VERSION, the conf files and log/ from disk); the
 * processes, the identity probe and the clock are injected.
 *
 * The same paths against the real bundled Postgres are in
 * `postgres-supervisor.real.test.ts`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "" } }));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  createPostgresSupervisor,
  judgeLivePostmaster,
  PG_MAX_RESTARTS,
  postgresChildEnv,
} = await import("../native/postgres-supervisor.js");
type Supervisor = ReturnType<typeof createPostgresSupervisor>;
type Health = Parameters<Parameters<Supervisor["onHealthChange"]>[0]>[0];
import type { PgChild, ProcessProbe } from "../native/postgres-supervisor.js";
import type { PgIdentityResult } from "../native/pg-identity.js";

const SYSID = "7697576143254888004";

/* ------------------------------ fixture ------------------------------ */

let root: string;
let runtimeDir: string;
let dataDir: string;
let passwordFile: string;

function writeState(pg: unknown): void {
  writeFileSync(path.join(runtimeDir, "runtime-state.json"), JSON.stringify({ pg }));
}

function readState(): { pg: { lastPort: number | null; systemIdentifier: string } | null } {
  return JSON.parse(readFileSync(path.join(runtimeDir, "runtime-state.json"), "utf8"));
}

function pidFileText(pid: number, port: number, status = "ready"): string {
  return [String(pid), dataDir, "1792231608", String(port), "", "127.0.0.1", "1   2", status.padEnd(8), ""].join("\n");
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "vex-pg-sup-"));
  runtimeDir = path.join(root, "runtime");
  dataDir = path.join(runtimeDir, "pg18");
  mkdirSync(path.join(dataDir, "log"), { recursive: true });
  // An existing, bootstrapped cluster: no initdb in these tests.
  writeFileSync(path.join(dataDir, "PG_VERSION"), "18\n");
  writeFileSync(path.join(dataDir, "postgresql.conf"), "max_connections = 100\n");
  passwordFile = path.join(root, "pg_password");
  writeFileSync(passwordFile, "s3cret");
  writeState({ systemIdentifier: SYSID, lastPort: null, major: 18 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------- scripted postmasters ------------------------- */

type Script =
  | { readonly kind: "ready" }
  /** Exits before ready, after writing `log` lines (prefixed with its pid) or `stderr`. */
  | { readonly kind: "fail"; readonly log?: string; readonly stderr?: string }
  /** Never writes postmaster.pid, then exits. */
  | { readonly kind: "silent-exit" };

class FakePostmaster implements PgChild {
  readonly signals: NodeJS.Signals[] = [];
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private stderr = "";
  exited = false;

  constructor(
    readonly pid: number,
    readonly port: number,
    private readonly diesOn: ReadonlySet<NodeJS.Signals>,
    alive: Set<number>,
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.alive = alive;
    alive.add(pid);
  }

  private readonly alive: Set<number>;

  stderrTail(): string {
    return this.stderr;
  }

  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    if (!this.diesOn.has(signal)) return;
    // Fast and immediate shutdowns remove the lock file; SIGKILL does not.
    if (signal !== "SIGKILL") rmSync(path.join(dataDir, "postmaster.pid"), { force: true });
    this.exit();
  }

  /** An unexpected death: the file stays behind, still saying ready. */
  crash(): void {
    this.exit();
  }

  run(script: Script): void {
    if (script.kind === "ready") {
      writeFileSync(path.join(dataDir, "postmaster.pid"), pidFileText(this.pid, this.port));
      return;
    }
    if (script.kind === "fail") {
      this.stderr = script.stderr ?? "";
      if (script.log !== undefined) {
        const lines = script.log.split("\n").map((l) => `2026-10-17 11:12:16.932 UTC [${String(this.pid)}] ${l}`);
        writeFileSync(path.join(dataDir, "log", `postgresql-${String(this.pid)}.log`), `${lines.join("\n")}\n`);
      }
    }
    setTimeout(() => this.exit(), 5);
  }

  private exit(): void {
    if (this.exited) return;
    this.exited = true;
    this.alive.delete(this.pid);
    this.resolveClosed();
  }
}

interface Harness {
  readonly supervisor: Supervisor;
  readonly children: FakePostmaster[];
  readonly alive: Set<number>;
  readonly signalled: Array<[number, NodeJS.Signals]>;
  readonly health: Health[];
}

function harness(options: {
  scripts?: Script[];
  diesOn?: NodeJS.Signals[];
  identity?: () => Promise<PgIdentityResult>;
  processes?: Partial<ProcessProbe>;
  getuid?: () => number;
}): Harness {
  const children: FakePostmaster[] = [];
  const alive = new Set<number>();
  const signalled: Array<[number, NodeJS.Signals]> = [];
  const scripts = [...(options.scripts ?? [])];
  let nextPid = 1000;
  const supervisor = createPostgresSupervisor({
    runtimeDir,
    binaries: { postgres: "/opt/pg/bin/postgres", initdb: "/opt/pg/bin/initdb", pgCtl: "/opt/pg/bin/pg_ctl", pgControldata: "/opt/pg/bin/pg_controldata" },
    ensurePasswordFile: async () => passwordFile,
    platform: "linux",
    spawn: (_command, args) => {
      const port = Number(args[args.indexOf("-p") + 1]);
      const child = new FakePostmaster(nextPid++, port, new Set(options.diesOn ?? ["SIGINT"]), alive);
      children.push(child);
      child.run(scripts.shift() ?? { kind: "ready" });
      return child;
    },
    runTool: async () => ({ code: 0, stdout: "", stderr: "" }),
    processes: {
      alive: (pid) => alive.has(pid),
      image: async () => null,
      cwd: async () => null,
      signal: (pid, signal) => {
        signalled.push([pid, signal]);
        if (signal === "SIGINT") {
          alive.delete(pid);
          rmSync(path.join(dataDir, "postmaster.pid"), { force: true });
        }
      },
      ...options.processes,
    },
    identity: options.identity ?? (async () => ({ kind: "usable" })),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    getuid: options.getuid ?? (() => 501),
  });
  const health: Health[] = [];
  supervisor.onHealthChange((h) => health.push(h));
  return { supervisor, children, alive, signalled, health };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(predicate()).toBe(true);
}

/* -------------------------------- start -------------------------------- */

describe("start", () => {
  it("spawns `postgres -D <pg18> -p <port>`, waits for ready, publishes loopback", async () => {
    const h = harness({});
    const result = await h.supervisor.start();
    expect(result.kind).toBe("running");
    expect(result.connection).toEqual({ host: "127.0.0.1", pgPort: h.children[0]?.port, pgPasswordPath: passwordFile });
    // The port is remembered for next launch (D5).
    expect(readState().pg?.lastPort).toBe(h.children[0]?.port);
    // The Vex conf block and hba were written.
    expect(readFileSync(path.join(dataDir, "postgresql.conf"), "utf8")).toMatch(/max_connections = 40/);
    expect(readFileSync(path.join(dataDir, "pg_hba.conf"), "utf8")).toMatch(/127\.0\.0\.1\/32\s+scram-sha-256/);
    await h.supervisor.stop();
  });

  it("a stale postmaster.pid still saying ready does not count as ready", async () => {
    // A SIGKILLed postmaster (pid 4242, dead) left this behind.
    writeFileSync(path.join(dataDir, "postmaster.pid"), pidFileText(4242, 5432));
    const h = harness({ scripts: [{ kind: "silent-exit" }] });
    const result = await h.supervisor.start();
    expect(result.kind).toBe("failed");
    expect(result.connection).toBeNull();
  });

  it("port taken (reason in log/, not stderr): retries on a different port", async () => {
    const h = harness({
      scripts: [
        {
          kind: "fail",
          stderr: "LOG:  redirecting log output to logging collector process\n",
          log: 'LOG:  could not bind IPv4 address "127.0.0.1": Address already in use\nFATAL:  could not create any TCP/IP sockets',
        },
        { kind: "ready" },
      ],
    });
    const result = await h.supervisor.start();
    expect(result.kind).toBe("running");
    expect(h.children).toHaveLength(2);
    expect(h.children[1]?.port).not.toBe(h.children[0]?.port);
    expect(readState().pg?.lastPort).toBe(h.children[1]?.port);
    await h.supervisor.stop();
  });

  it("port taken on every attempt is a bounded port_collision", async () => {
    const taken: Script = { kind: "fail", log: 'LOG:  could not bind IPv4 address "127.0.0.1": Address already in use\nFATAL:  could not create any TCP/IP sockets' };
    const h = harness({ scripts: [taken, taken, taken, taken] });
    const result = await h.supervisor.start();
    expect(result.kind).toBe("port_collision");
    expect(h.children).toHaveLength(3);
  });

  it("disk full is its own kind", async () => {
    const h = harness({
      scripts: [{ kind: "fail", log: 'FATAL:  could not write to file "pg_wal/xlogtemp.1": No space left on device' }],
    });
    expect((await h.supervisor.start()).kind).toBe("disk_full");
  });

  it("a lock still held by a crashed postmaster's children is retried on the same port", async () => {
    writeState({ systemIdentifier: SYSID, lastPort: 45999, major: 18 });
    const h = harness({
      scripts: [{ kind: "fail", stderr: 'FATAL:  lock file "postmaster.pid" already exists\n' }, { kind: "ready" }],
    });
    // Port 45999 may be taken on this machine; whatever port the first
    // attempt used, the busy retry must reuse it.
    const result = await h.supervisor.start();
    expect(result.kind).toBe("running");
    expect(h.children[1]?.port).toBe(h.children[0]?.port);
    await h.supervisor.stop();
  });

  it("any other early exit is failed, with Postgres' own reason", async () => {
    const h = harness({ scripts: [{ kind: "fail", stderr: "FATAL:  data directory has invalid permissions\n" }] });
    const result = await h.supervisor.start();
    expect(result).toMatchObject({ kind: "failed", connection: null });
    expect(result.message).toMatch(/invalid permissions/);
  });

  it("an identity mismatch is foreign_listener, and the postmaster we started is stopped", async () => {
    const h = harness({ identity: async () => ({ kind: "foreign_listener", detail: "system_identifier 1 is not 2" }) });
    const result = await h.supervisor.start();
    expect(result).toMatchObject({ kind: "foreign_listener", connection: null });
    expect(h.children[0]?.signals).toEqual(["SIGINT"]);
  });

  it("refuses a corrupt runtime-state.json without touching it or spawning", async () => {
    writeFileSync(path.join(runtimeDir, "runtime-state.json"), "{ nope");
    const h = harness({});
    const result = await h.supervisor.start();
    expect(result.kind).toBe("failed");
    expect(result.message).toMatch(/unreadable/);
    expect(h.children).toHaveLength(0);
    expect(readFileSync(path.join(runtimeDir, "runtime-state.json"), "utf8")).toBe("{ nope");
  });

  it("refuses to run as root", async () => {
    const h = harness({ getuid: () => 0 });
    const result = await h.supervisor.start();
    expect(result.kind).toBe("failed");
    expect(result.message).toMatch(/root/);
    expect(h.children).toHaveLength(0);
  });

  it("a second start while running re-proves identity and reports reused", async () => {
    const h = harness({});
    const first = await h.supervisor.start();
    const second = await h.supervisor.start();
    expect(second).toEqual({ ...first, kind: "reused", message: expect.any(String) });
    expect(h.children).toHaveLength(1);
    await h.supervisor.stop();
  });

  it("an abort before ready stops the child and rejects with AbortError", async () => {
    const controller = new AbortController();
    const h = harness({ scripts: [{ kind: "silent-exit" }] });
    // Abort while the child has not reported ready.
    const run = h.supervisor.start(controller.signal);
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });
});

/* -------------------------------- reaper -------------------------------- */

describe("boot reaper", () => {
  it("judges by the live PID's cwd: our data dir is ours, elsewhere is stale, unknown is left alone", () => {
    expect(judgeLivePostmaster({ image: "/Apps/Vex/postgres/bin/postgres", cwd: "/r/pg18" }, "/r/pg18")).toBe("ours");
    // An orphan from a previous app version or AppImage mount: other image path, still ours.
    expect(judgeLivePostmaster({ image: "/tmp/.mount_old/postgres/bin/postgres", cwd: "/r/pg18" }, "/r/pg18")).toBe("ours");
    expect(judgeLivePostmaster({ image: null, cwd: "/r/pg18" }, "/r/pg18")).toBe("ours");
    // PID reused by another program.
    expect(judgeLivePostmaster({ image: "/usr/bin/zsh", cwd: "/r/pg18" }, "/r/pg18")).toBe("foreign");
    expect(judgeLivePostmaster({ image: "/usr/lib/postgresql/16/bin/postgres", cwd: "/var/lib/pg" }, "/r/pg18")).toBe("foreign");
    expect(judgeLivePostmaster({ image: "/usr/bin/zsh", cwd: null }, "/r/pg18")).toBe("unknown");
  });

  it("fast-stops an orphaned postmaster of ours before starting", async () => {
    writeFileSync(path.join(dataDir, "postmaster.pid"), pidFileText(777, 5432));
    const h = harness({
      processes: { image: async () => "/old/postgres/bin/postgres", cwd: async () => realpathSync(dataDir) },
    });
    h.alive.add(777);
    const result = await h.supervisor.start();
    expect(h.signalled).toEqual([[777, "SIGINT"]]);
    expect(result.kind).toBe("running");
    await h.supervisor.stop();
  });

  it("removes a stale postmaster.pid whose PID now belongs to another program, without signalling it", async () => {
    writeFileSync(path.join(dataDir, "postmaster.pid"), pidFileText(888, 5432));
    const h = harness({ processes: { image: async () => "/usr/bin/zsh", cwd: async () => "/Users/someone" } });
    h.alive.add(888);
    const result = await h.supervisor.start();
    expect(h.signalled).toEqual([]);
    expect(result.kind).toBe("running");
    await h.supervisor.stop();
  });

  it("leaves the file alone when the live PID cannot be identified", async () => {
    writeFileSync(path.join(dataDir, "postmaster.pid"), pidFileText(999, 5432));
    const h = harness({ scripts: [{ kind: "fail", stderr: 'FATAL:  lock file "postmaster.pid" already exists\n' }] });
    h.alive.add(999);
    // Postgres itself refuses; the busy window then gives up. Shrink it by
    // making every attempt fail and checking the file survived the reaper.
    const run = h.supervisor.start();
    await until(() => h.children.length >= 1);
    expect(existsSync(path.join(dataDir, "postmaster.pid"))).toBe(true);
    expect(h.signalled).toEqual([]);
    await h.supervisor.stop();
    await run;
  });
});

/* ---------------------------- restart budget ---------------------------- */

describe("supervision", () => {
  it(`restarts an unexpected exit at most ${String(PG_MAX_RESTARTS)} times, never resetting, then reports unhealthy`, async () => {
    const h = harness({});
    expect((await h.supervisor.start()).kind).toBe("running");
    // Crash every postmaster as soon as it is up, including after each
    // successful restart: a counter that reset on success would loop forever.
    for (let crash = 0; crash <= PG_MAX_RESTARTS; crash++) {
      const child = h.children[crash];
      expect(child).toBeDefined();
      child?.crash();
      if (crash < PG_MAX_RESTARTS) await until(() => h.health.filter((x) => x.kind === "running").length === crash + 1);
    }
    await until(() => h.health.some((x) => x.kind === "unhealthy"));
    expect(h.children).toHaveLength(1 + PG_MAX_RESTARTS);
    expect(h.health.filter((x) => x.kind === "restarting").map((x) => (x.kind === "restarting" ? x.attempt : 0))).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(h.health.at(-1)?.kind).toBe("unhealthy");
    // Nothing else is spawned afterwards.
    await new Promise((r) => setTimeout(r, 20));
    expect(h.children).toHaveLength(1 + PG_MAX_RESTARTS);
  });

  it("failed restart attempts spend the budget too", async () => {
    const fail: Script = { kind: "fail", stderr: "FATAL:  could not open file \"global/pg_control\"\n" };
    const h = harness({ scripts: [{ kind: "ready" }, fail, fail, fail, fail, fail, fail] });
    await h.supervisor.start();
    h.children[0]?.crash();
    await until(() => h.health.some((x) => x.kind === "unhealthy"));
    expect(h.children).toHaveLength(1 + PG_MAX_RESTARTS);
  });

  it("an ordered stop is not a crash: no restart", async () => {
    const h = harness({});
    await h.supervisor.start();
    expect((await h.supervisor.stop()).kind).toBe("stopped");
    await new Promise((r) => setTimeout(r, 20));
    expect(h.health).toEqual([]);
    expect(h.children).toHaveLength(1);
  });
});

/* --------------------------------- stop --------------------------------- */

describe("stop escalation", () => {
  it("fast: SIGINT, and postmaster.pid is gone", async () => {
    const h = harness({ diesOn: ["SIGINT"] });
    await h.supervisor.start();
    const result = await h.supervisor.stop({ deadlineMs: 50 });
    expect(result).toMatchObject({ kind: "stopped", mode: "fast" });
    expect(h.children[0]?.signals).toEqual(["SIGINT"]);
    expect(existsSync(path.join(dataDir, "postmaster.pid"))).toBe(false);
  });

  it("immediate: SIGINT past the deadline, then SIGQUIT", async () => {
    const h = harness({ diesOn: ["SIGQUIT"] });
    await h.supervisor.start();
    expect(await h.supervisor.stop({ deadlineMs: 5 })).toMatchObject({ kind: "stopped", mode: "immediate" });
    expect(h.children[0]?.signals).toEqual(["SIGINT", "SIGQUIT"]);
  });

  it("SIGKILL only after SIGQUIT was ignored too, and it says the lock file remains", async () => {
    const h = harness({ diesOn: ["SIGKILL"] });
    await h.supervisor.start();
    const result = await h.supervisor.stop({ deadlineMs: 5 });
    expect(result).toMatchObject({ kind: "stopped", mode: "killed" });
    expect(result.message).toMatch(/postmaster\.pid remains/);
    expect(h.children[0]?.signals).toEqual(["SIGINT", "SIGQUIT", "SIGKILL"]);
  });

  it("a postmaster that survives even SIGKILL is a failed stop, and the connection stays", async () => {
    const h = harness({ diesOn: [] });
    await h.supervisor.start();
    expect((await h.supervisor.stop({ deadlineMs: 5 })).kind).toBe("failed");
    expect((await h.supervisor.start()).kind).toBe("reused");
  });

  it("nothing started is not_running", async () => {
    expect((await harness({}).supervisor.stop()).kind).toBe("not_running");
  });
});

describe("child environment", () => {
  it("passes nothing from main's environment on POSIX, and only the loader's needs on Windows", () => {
    const env = { PGPASSWORD: "x", DATABASE_URL: "postgres://", SystemRoot: "C:\\Windows", COMSPEC: "cmd.exe", PATH: "/bin" };
    expect(postgresChildEnv("darwin", env)).toEqual({});
    expect(postgresChildEnv("linux", env)).toEqual({});
    expect(postgresChildEnv("win32", env)).toEqual({ SystemRoot: "C:\\Windows", COMSPEC: "cmd.exe" });
  });
});
