/**
 * A throwaway cluster on the BUNDLED native Postgres (native-runtime/out/...),
 * for `VEX_TEST_PG=native` runs of the integration and Studio Postgres lanes.
 * The point is to test what Vex ships rather than a container image: the same
 * binaries, the same initdb flags and the same server settings the native
 * runtime uses (plan sections 6.2 to 6.4).
 *
 * The tree defaults to `native-runtime/out/<platform>-<arch>/postgres` and can
 * be pointed elsewhere with VEX_NATIVE_PG_DIR.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";

const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;

export interface NativePostgres {
  readonly url: string;
  stop(): Promise<void>;
}

function defaultTreeDir(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return resolve(import.meta.dirname, "../../../../native-runtime/out", `${process.platform}-${arch}`, "postgres");
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

export async function startNativePostgres(database: string): Promise<NativePostgres> {
  const treeDir = process.env.VEX_NATIVE_PG_DIR ?? defaultTreeDir();
  const bin = (name: string): string =>
    join(treeDir, "bin", process.platform === "win32" ? `${name}.exe` : name);
  if (!existsSync(bin("postgres"))) {
    throw new Error(
      `VEX_TEST_PG=native but no bundled Postgres at ${treeDir}. ` +
        "Build it with native-runtime/postgres/build.sh <target> or set VEX_NATIVE_PG_DIR.",
    );
  }

  const root = await mkdtemp(join(tmpdir(), "vex-native-pg-"));
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

  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGINT"); // fast shutdown
      const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    }
    await rm(root, { recursive: true, force: true });
  };

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
  return { url: url.toString(), stop };
}
