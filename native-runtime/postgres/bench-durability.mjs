#!/usr/bin/env node
// bench-durability.mjs <tree> [wal_sync_method ...]
//
// The cost of durability settings on THIS machine, measured on a shipped tree,
// to decide plan 6.3's wal_sync_method (macOS: plain fsync does not flush the
// drive cache; fsync_writethrough does, for WAL and for data-file syncs).
//
// For each method: a fresh cluster with the 6.3 settings, then
//   - commit latency: 1000 sequential single-row autocommit INSERTs,
//   - checkpoint: ~64 MB of rows written, then CHECKPOINT timed,
//   - fast stop: ~16 MB more rows, then SIGINT until the postmaster exits.
// Prints one JSON line per method.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pg = createRequire(path.join(repoRoot, "vex-app", "package.json"))("pg");

const tree = process.argv[2];
const methods = process.argv.slice(3);
if (!tree || !fs.existsSync(path.join(tree, "bin", "postgres"))) {
  console.error("usage: bench-durability.mjs <tree> [wal_sync_method ...]");
  process.exit(2);
}
if (methods.length === 0) methods.push(...(process.platform === "darwin" ? ["fsync", "fsync_writethrough"] : ["fdatasync"]));

const bin = (name) => path.join(tree, "bin", name);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitReady(child, dataDir) {
  for (let i = 0; i < 1200; i++) {
    if (child.exitCode !== null) throw new Error(`postgres exited ${child.exitCode}`);
    // Never create the file: an empty postmaster.pid is a lock Postgres refuses.
    let pid = [];
    try {
      pid = fs.readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\n");
    } catch {}
    if (pid[0] === String(child.pid) && pid[7]?.trim() === "ready") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("postgres not ready in 30 s");
}

const quantile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];

async function bench(method) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vex-bench-"));
  const dataDir = path.join(root, "pg18");
  const password = randomBytes(16).toString("hex");
  fs.writeFileSync(path.join(root, "pw"), password, { mode: 0o600 });
  const init = spawnSync(bin("initdb"), [
    "-D", dataDir, "-U", "vex", `--pwfile=${path.join(root, "pw")}`, "-E", "UTF8",
    "--locale=C", "--locale-provider=builtin", "--builtin-locale=C.UTF-8",
    "--auth-local=scram-sha-256", "--auth-host=scram-sha-256",
  ], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(init.stderr);
  fs.appendFileSync(path.join(dataDir, "postgresql.conf"), [
    "", "listen_addresses = '127.0.0.1'", "unix_socket_directories = ''",
    "max_connections = 40", "shared_buffers = 128MB", "wal_level = minimal", "max_wal_senders = 0",
    "max_wal_size = 512MB", "min_wal_size = 80MB", "wal_compression = on", "checkpoint_timeout = 10min",
    "fsync = on", "full_page_writes = on", "synchronous_commit = on",
    `wal_sync_method = ${method}`, "",
  ].join("\n"));
  fs.writeFileSync(path.join(dataDir, "pg_hba.conf"), "host all vex 127.0.0.1/32 scram-sha-256\n");

  const port = await freePort();
  const child = spawn(bin("postgres"), ["-D", dataDir, "-p", String(port)], { stdio: "ignore" });
  try {
    await waitReady(child, dataDir);
    const c = new pg.Client({ host: "127.0.0.1", port, user: "vex", password, database: "postgres" });
    await c.connect();
    const active = (await c.query("SHOW wal_sync_method")).rows[0].wal_sync_method;
    await c.query("CREATE TABLE t (id bigserial PRIMARY KEY, payload text)");

    const lat = [];
    for (let i = 0; i < 1000; i++) {
      const t0 = performance.now();
      await c.query("INSERT INTO t (payload) VALUES ($1)", ["x".repeat(200)]);
      lat.push(performance.now() - t0);
    }

    await c.query("INSERT INTO t (payload) SELECT repeat(md5(g::text), 32) FROM generate_series(1, 60000) g");
    let t0 = performance.now();
    await c.query("CHECKPOINT");
    const checkpointMs = performance.now() - t0;

    await c.query("INSERT INTO t (payload) SELECT repeat(md5(g::text), 32) FROM generate_series(1, 15000) g");
    const dbSize = (await c.query("SELECT pg_size_pretty(pg_database_size('postgres')) AS s")).rows[0].s;
    await c.end();

    const exited = new Promise((r) => child.once("exit", r));
    t0 = performance.now();
    child.kill("SIGINT");
    await exited;
    const fastStopMs = performance.now() - t0;

    return {
      method: active,
      commit_ms: { p50: +quantile(lat, 0.5).toFixed(2), p99: +quantile(lat, 0.99).toFixed(2), mean: +(lat.reduce((s, x) => s + x, 0) / lat.length).toFixed(2) },
      commits_per_s: Math.round(1000 / (lat.reduce((s, x) => s + x, 0) / lat.length)),
      checkpoint_ms: Math.round(checkpointMs),
      fast_stop_ms: Math.round(fastStopMs),
      db_size: dbSize,
    };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const m of methods) console.log(JSON.stringify(await bench(m)));
