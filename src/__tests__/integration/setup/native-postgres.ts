/**
 * A throwaway cluster on the BUNDLED native Postgres, for `VEX_TEST_PG=native`
 * runs of the integration and Studio Postgres lanes and for the Playwright
 * Studio specs (`vex-app/e2e/fixtures/vex-stack.ts`). The point is to test
 * what Vex ships rather than a container image: the same binaries, the same
 * initdb flags and the same server settings the native runtime uses (plan
 * sections 6.2 to 6.4).
 *
 * The tree is found the way the app finds it in development
 * (`vex-app/src/main/runtime/runtime-paths.ts`): a local build at
 * `native-runtime/out/<platform>-<arch>/postgres` wins when it is complete,
 * else the lock-pinned release that `pnpm dev:assets` fetches to
 * `vex-app/resources/native-runtime/<platform>-<arch>/postgres`
 * (`node scripts/fetch-native-runtime.mjs --current` from vex-app/).
 * VEX_NATIVE_PG_DIR points it anywhere else.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";

const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;

export interface NativePostgres {
  readonly url: string;
  /** The loopback port the server listens on. */
  readonly port: number;
  /** The `vex` role's password (also inside {@link url}). */
  readonly password: string;
  /** Idempotent: stops the server and removes its directory. */
  stop(): Promise<void>;
}

export interface NativePostgresOptions {
  /**
   * The directory the cluster lives in, created here and removed by `stop()`.
   * It must not exist yet. Defaults to a fresh `vex-native-pg-*` under the OS
   * temp dir.
   */
  readonly root?: string;
  /**
   * Stop the server and remove its directory when THIS process dies without
   * calling `stop()` (a killed test worker): a small watchdog process holds a
   * pipe to this one and reaps the cluster when the pipe closes. The
   * container lanes get the same backstop from testcontainers' Ryuk.
   */
  readonly reapWithParent?: boolean;
}

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/** The development tree, by the app's rule: a complete local build, else the fetched release. */
function defaultTreeDir(): string {
  const target = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  const probe = join("bin", process.platform === "win32" ? "postgres.exe" : "postgres");
  const built = join(REPO_ROOT, "native-runtime", "out", target, "postgres");
  const fetched = join(REPO_ROOT, "vex-app", "resources", "native-runtime", target, "postgres");
  return !existsSync(join(built, probe)) && existsSync(join(fetched, probe)) ? fetched : built;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * The watchdog. It reads nothing; when its stdin closes (the parent exited,
 * however it exited, or `stop()` let go) it stops the postmaster if the
 * cluster's postmaster.pid still names it, then removes the cluster's
 * directory. Checking the pid file first means a postmaster that has already
 * stopped is never signalled, so a reused pid is never hit.
 */
const WATCHDOG_SOURCE = `
const fs = require("node:fs");
const path = require("node:path");
const [pidArg, dataDir, root] = process.argv.slice(1);
const pid = Number(pidArg);
const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ours = () => {
  try { return Number(fs.readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\\n")[0]) === pid; }
  catch { return false; }
};
const done = () => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  process.exit(0);
};
let reaping = false;
const reap = () => {
  if (reaping) return;
  reaping = true;
  if (!ours()) return done();
  try { process.kill(pid, "SIGINT"); } catch {}
  const deadline = Date.now() + ${STOP_TIMEOUT_MS};
  const wait = () => {
    if (!alive()) return done();
    if (Date.now() > deadline) { try { process.kill(pid, "SIGKILL"); } catch {} return done(); }
    setTimeout(wait, 100);
  };
  wait();
};
process.stdin.on("end", reap);
process.stdin.on("close", reap);
process.stdin.on("error", reap);
process.stdin.resume();
`;

function startWatchdog(pid: number, dataDir: string, root: string): ChildProcess {
  const watchdog = spawn(process.execPath, ["-e", WATCHDOG_SOURCE, String(pid), dataDir, root], {
    stdio: ["pipe", "ignore", "ignore"],
    // Its own process group: a signal aimed at this one's group (a terminal
    // Ctrl-C) must not take the watchdog down before it has reaped.
    detached: true,
  });
  // Neither the process nor its pipe may keep this process alive.
  watchdog.unref();
  (watchdog.stdin as unknown as { unref?: () => void } | null)?.unref?.();
  return watchdog;
}

/** Settings from plan section 6.3 that change behaviour under test load. */
function serverConf(port: number): string {
  return [
    "",
    "# Vex native runtime (integration-test lane)",
    "listen_addresses = '127.0.0.1'",
    `port = ${port}`,
    "unix_socket_directories = ''",
    "password_encryption = scram-sha-256",
    "max_connections = 40",
    "superuser_reserved_connections = 2",
    "shared_buffers = 128MB",
    "work_mem = 8MB",
    "maintenance_work_mem = 128MB",
    "wal_level = minimal",
    "max_wal_senders = 0",
    "max_worker_processes = 4",
    "max_parallel_workers_per_gather = 1",
    "autovacuum_worker_slots = 4",
    "jit = off",
    "timezone = 'UTC'",
    "log_timezone = 'UTC'",
    "lc_messages = 'C'",
    "",
  ].join("\n");
}

const PG_HBA = [
  "host  all  vex  127.0.0.1/32  scram-sha-256",
  "host  all  vex  ::1/128       scram-sha-256",
  "",
].join("\n");

/**
 * Wait until the postmaster reports `ready` in postmaster.pid (line 8, the
 * PM_STATUS field), which holds whatever the server logs to.
 */
async function waitReady(child: ChildProcess, dataDir: string, stderr: () => string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`native postgres exited with code ${child.exitCode} before it was ready:\n${stderr()}`);
    }
    const pidFile = await readFile(join(dataDir, "postmaster.pid"), "utf8").catch(() => "");
    if (pidFile.split("\n")[7]?.trim() === "ready") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`native postgres was not ready within ${READY_TIMEOUT_MS}ms:\n${stderr()}`);
}

export async function startNativePostgres(
  database: string,
  options: NativePostgresOptions = {},
): Promise<NativePostgres> {
  const treeDir = process.env.VEX_NATIVE_PG_DIR ?? defaultTreeDir();
  const bin = (name: string): string =>
    join(treeDir, "bin", process.platform === "win32" ? `${name}.exe` : name);
  if (!existsSync(bin("postgres"))) {
    throw new Error(
      `No bundled Postgres at ${treeDir}. Fetch the pinned release with ` +
        "`node scripts/fetch-native-runtime.mjs --current` from vex-app/ (pnpm dev runs it), " +
        "build it with native-runtime/postgres/build.sh <target>, or set VEX_NATIVE_PG_DIR.",
    );
  }

  let root: string;
  if (options.root === undefined) {
    root = await mkdtemp(join(tmpdir(), "vex-native-pg-"));
  } else {
    // Exclusive: a directory that already exists is not ours to remove later.
    await mkdir(options.root);
    root = options.root;
  }
  const dataDir = join(root, "pg18");
  const password = randomBytes(24).toString("hex");
  const pwFile = join(root, "pwfile");
  await writeFile(pwFile, password, { mode: 0o600 });

  const initdb = spawnSync(
    bin("initdb"),
    [
      "-D", dataDir, "-U", "vex", `--pwfile=${pwFile}`, "-E", "UTF8",
      "--locale=C", "--locale-provider=builtin", "--builtin-locale=C.UTF-8",
      "--auth-local=scram-sha-256", "--auth-host=scram-sha-256",
    ],
    { encoding: "utf8" },
  );
  await rm(pwFile, { force: true });
  if (initdb.status !== 0) {
    await rm(root, { recursive: true, force: true });
    throw new Error(`initdb failed (${initdb.status}):\n${initdb.stderr}`);
  }

  const port = await freePort();
  await appendFile(join(dataDir, "postgresql.conf"), serverConf(port));
  await writeFile(join(dataDir, "pg_hba.conf"), PG_HBA);

  let stderr = "";
  const child = spawn(bin("postgres"), ["-D", dataDir, "-p", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_384);
  });
  const watchdog =
    options.reapWithParent === true && child.pid !== undefined ? startWatchdog(child.pid, dataDir, root) : null;

  let stopping: Promise<void> | null = null;
  const stopOnce = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGINT"); // fast shutdown
      const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    }
    await rm(root, { recursive: true, force: true });
    // Nothing is left to reap; closing the pipe lets the watchdog exit.
    watchdog?.stdin?.end();
  };
  const stop = (): Promise<void> => (stopping ??= stopOnce());

  try {
    await waitReady(child, dataDir, () => stderr);
    const admin = new pg.Client({ host: "127.0.0.1", port, user: "vex", password, database: "postgres" });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(database)} OWNER vex`);
    } finally {
      await admin.end();
    }
  } catch (error) {
    await stop();
    throw error;
  }

  const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  url.username = "vex";
  url.password = password;
  return { url: url.toString(), port, password, stop };
}
