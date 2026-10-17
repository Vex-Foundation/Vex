#!/usr/bin/env node
// smoke.mjs <tree> [target]
//
// Exercises a SHIPPED Postgres tree (native-runtime/out/<target>/postgres) the
// way Vex will run it (plan 6.2 to 6.5), using the exact `pg` client the app
// ships (vex-app/node_modules/pg):
//
//   relocate the tree into a path with spaces; initdb per 6.2; write the 6.3
//   settings and replace pg_hba.conf per 6.4; spawn `postgres -D -p` directly;
//   SCRAM login over 127.0.0.1; CREATE DATABASE vex; pgvector HNSW search;
//   gen_random_uuid(); encoding/timezone; system_identifier vs pg_controldata;
//   pg_dump -Fc | pg_restore; SIGINT fast stop; SIGKILL + crash recovery;
//   start on a taken port.
//
// darwin-*: everything runs on this Mac (darwin-x64 runs under Rosetta 2).
// linux-x64: the server-side binaries run inside an ubuntu:22.04 linux/amd64
// container (glibc 2.35, the oldest supported distro); the Node client stays
// on the host. Postgres keeps the exact 6.3/6.4 configuration (listen on
// 127.0.0.1, hba 127.0.0.1/32 only): a socat forwarder inside the container
// relays the published port to 127.0.0.1:<port>, so connections reach
// Postgres from 127.0.0.1 and no setting is overridden for the container.
// win32-*: on this Windows host, the tree and data dir under a path with
// spaces AND a non-ASCII component. postgres.exe refuses to run with
// administrative rights (CI runners are elevated; checked explicitly), so the
// server is driven the way Vex will on Windows (plan 6.5): `pg_ctl start -w
// -o "-p <port>"` (pg_ctl runs it under a restricted token), `pg_ctl stop -m
// fast|immediate`, and TerminateProcess for the crash test. win32-arm64 runs
// the x64 tree under the OS's x64 emulation.
//
// Exits non-zero on any failure; always tears down processes, the container
// and temp dirs.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { peInfo } from '../lib/pe.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const appRequire = createRequire(path.join(repoRoot, 'vex-app', 'package.json'));
const pg = appRequire('pg');
const pgVersion = appRequire('pg/package.json').version;

const UBUNTU_IMAGE =
  'ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401';
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64', 'win32-arm64'];
const PG_USER = 'vex';
const READY_TIMEOUT_MS = 120_000;

// ---- small utilities -------------------------------------------------------

const log = (...a) => console.log('[smoke]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class SmokeError extends Error {}
function check(cond, msg) {
  if (!cond) throw new SmokeError(msg);
  log(`ok  ${msg}`);
}

// Run a program (no shell) and collect its output.
function run(cmd, args, { env, input, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input ?? '');
  });
}
async function runOk(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    throw new SmokeError(`${cmd} ${args.join(' ')} exited ${r.code ?? r.signal}\n${r.stdout}${r.stderr}`);
  }
  return r;
}

function freeHostPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// ---- runners: where the shipped binaries execute ---------------------------

// Host runner: macOS, the tree copied to <tmp>/Vex Runtime/postgres.
class HostRunner {
  constructor(base, tree) {
    this.label = 'host';
    this.treeDir = tree;
    this.workDir = path.join(base, 'Vex Data');
    this.dataDir = path.join(this.workDir, 'pg18');
    fs.mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
  }
  bin(name) {
    return path.join(this.treeDir, 'bin', name);
  }
  exec(name, args, opts) {
    return run(this.bin(name), args, opts);
  }
  spawnServer(args) {
    return spawn(this.bin('postgres'), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  async readFile(p) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  }
  async writeFile(p, s, mode = 0o600) {
    fs.writeFileSync(p, s, { mode });
  }
  async appendFile(p, s) {
    fs.appendFileSync(p, s);
  }
  async rm(p) {
    fs.rmSync(p, { force: true });
  }
  async exists(p) {
    return fs.existsSync(p);
  }
  async readLogs() {
    const dir = path.join(this.dataDir, 'log');
    if (!fs.existsSync(dir)) return '';
    return fs
      .readdirSync(dir)
      .sort()
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('');
  }
  async signal(pid, sig) {
    process.kill(pid, sig);
  }
  async alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  async pickPort() {
    return freeHostPort();
  }
  clientPort(port) {
    return port;
  }
  async holdPort(port) {
    const s = net.createServer();
    await new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen(port, '127.0.0.1', resolve);
    });
    return async () => new Promise((r) => s.close(r));
  }
  async close() {}
}

// Windows runner: the host runner, with the server lifecycle through pg_ctl
// (see the header). The postmaster is not our child, so its exit is observed
// through its PID; a stop's outcome is pg_ctl's exit code.
class WindowsRunner extends HostRunner {
  constructor(base, tree) {
    super(base, tree);
    this.label = 'windows host (pg_ctl)';
    this.pgctlLog = path.join(this.workDir, 'pg_ctl.log');
    this.stopping = null;
    this.lastStop = null;
  }
  bin(name) {
    return path.join(this.treeDir, 'bin', `${name}.exe`);
  }
  spawnServer() {
    throw new SmokeError('on Windows postgres.exe is started through pg_ctl');
  }
  async signal(pid, sig) {
    if (sig === 'SIGKILL') {
      process.kill(pid, 'SIGKILL'); // TerminateProcess
      return;
    }
    const mode = { SIGINT: 'fast', SIGQUIT: 'immediate' }[sig];
    if (!mode) throw new SmokeError(`no pg_ctl equivalent of ${sig}`);
    this.stopping = this.exec('pg_ctl', ['stop', '-D', this.dataDir, '-m', mode, '-w', '-t', '60']).then((res) => {
      this.lastStop = { pid, mode, code: res.code, out: `${res.stdout}${res.stderr}`.trim() };
      return res;
    });
    const res = await this.stopping;
    if (res.code !== 0) throw new SmokeError(`pg_ctl stop -m ${mode} exited ${res.code}: ${this.lastStop.out}`);
  }
}

// `pg_ctl start -w`: returns once the server is ready (or has failed). Only
// the port goes through -o; every setting is in postgresql.conf (plan 6.3).
async function startServerWin(r, port) {
  const t0 = performance.now();
  const logOffset = fs.existsSync(r.pgctlLog) ? fs.statSync(r.pgctlLog).size : 0;
  // pg_ctl creates the server with handle inheritance on, so the server keeps
  // whatever stdout/stderr pg_ctl had: a pipe would stay open (and 'close'
  // never fire) until the server exits. Give pg_ctl a file and wait for exit.
  const outFile = path.join(r.workDir, 'pg_ctl-start.out');
  const fd = fs.openSync(outFile, 'w');
  const child = spawn(r.bin('pg_ctl'), ['start', '-w', '-t', '60', '-D', r.dataDir, '-l', r.pgctlLog, '-o', `-p ${port}`],
    { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const res = { code, stdout: fs.readFileSync(outFile, 'utf8'), stderr: '' };
  const ms = performance.now() - t0;
  // Early messages (before the logging collector takes over) land in -l.
  const early = fs.existsSync(r.pgctlLog) ? fs.readFileSync(r.pgctlLog).subarray(logOffset).toString('utf8') : '';
  const srv = { child: null, stderr: `${res.stdout}${res.stderr}${early}`, exited: null, port };
  if (res.code !== 0) {
    srv.exited = { code: res.code, signal: null, via: 'pg_ctl start' };
    srv.exitPromise = Promise.resolve(srv.exited);
    return { srv, ready: false, ms };
  }
  const lines = (await r.readFile(path.join(r.dataDir, 'postmaster.pid')))?.split('\n') ?? [];
  const pid = Number(lines[0]);
  if (!(lines.length > 7 && lines[7].trim() === 'ready' && (await r.alive(pid)))) {
    throw new SmokeError(`pg_ctl start succeeded but postmaster.pid is not ready: ${JSON.stringify(lines)}`);
  }
  srv.pid = pid;
  srv.exitPromise = (async () => {
    while (await r.alive(pid)) await sleep(25);
    const stop = r.stopping ? await r.stopping.then(() => r.lastStop, () => r.lastStop) : null;
    srv.exited = stop?.pid === pid
      ? { code: stop.code, signal: null, via: `pg_ctl stop -m ${stop.mode}` }
      : { code: null, signal: 'terminated' };
    return srv.exited;
  })();
  return { srv, ready: true, ms };
}

// Container runner: ubuntu:22.04 linux/amd64, tree bind-mounted read-only at
// "/opt/Vex Runtime/postgres", data dir on the container's own filesystem
// (Postgres insists the data dir is owned by the server's uid, which a
// macOS bind mount cannot promise).
class DockerRunner {
  static FORWARD_PORT = 15432;
  constructor(hostTree) {
    this.label = 'ubuntu:22.04 container';
    this.hostTree = hostTree;
    this.treeDir = '/opt/Vex Runtime/postgres';
    this.workDir = '/home/vexsmoke/Vex Data';
    this.dataDir = `${this.workDir}/pg18`;
    this.name = `vex-pg-smoke-${crypto.randomBytes(4).toString('hex')}`;
    this.forwarder = null;
  }
  async start() {
    await runOk('docker', [
      'run', '-d', '--rm', '--init', '--platform', 'linux/amd64', '--name', this.name,
      '-p', `127.0.0.1::${DockerRunner.FORWARD_PORT}`,
      '--mount', `type=bind,src=${this.hostTree},dst=${this.treeDir},readonly`,
      UBUNTU_IMAGE, 'sleep', 'infinity',
    ]);
    // socat is the port forwarder (see header); the server never links it.
    await runOk('docker', ['exec', this.name, 'bash', '-c',
      'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && ' +
      'apt-get install -y -qq --no-install-recommends socat >/dev/null && useradd -m vexsmoke'],
    { timeoutMs: 600_000 });
    await this.sh(`mkdir -m 700 -p "${this.workDir}"`);
    const glibc = (await this.sh('ldd --version | head -1')).stdout.trim();
    log(`container glibc: ${glibc}`);
    const ldd = (await this.sh(`ldd "${this.treeDir}/bin/postgres" "${this.treeDir}/bin/pg_dump"`)).stdout;
    log(`container ldd:\n${ldd.trimEnd()}`);
    if (/not found/.test(ldd)) throw new SmokeError('unresolved shared library in the container');
    const mapped = (await runOk('docker', ['port', this.name, String(DockerRunner.FORWARD_PORT)])).stdout;
    this.hostPort = Number(mapped.trim().split('\n')[0].split(':').pop());
  }
  // Run a bash snippet in the container as the unprivileged user.
  sh(script, { user = 'vexsmoke', input } = {}) {
    return runOk('docker', ['exec', '-i', '-u', user, this.name, 'bash', '-c', script], { input });
  }
  bin(name) {
    return `${this.treeDir}/bin/${name}`;
  }
  exec(name, args, { env } = {}) {
    const envArgs = Object.entries(env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    return run('docker', ['exec', '-u', 'vexsmoke', ...envArgs, this.name, this.bin(name), ...args]);
  }
  spawnServer(args) {
    return spawn('docker', ['exec', '-u', 'vexsmoke', this.name, this.bin('postgres'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  async readFile(p) {
    const r = await run('docker', ['exec', '-u', 'vexsmoke', this.name, 'cat', p]);
    return r.code === 0 ? r.stdout : null;
  }
  async writeFile(p, s) {
    await runOk('docker', ['exec', '-i', '-u', 'vexsmoke', this.name, 'bash', '-c',
      'umask 077 && cat > "$1"', '_', p], { input: s });
  }
  async appendFile(p, s) {
    await runOk('docker', ['exec', '-i', '-u', 'vexsmoke', this.name, 'bash', '-c',
      'cat >> "$1"', '_', p], { input: s });
  }
  async rm(p) {
    await runOk('docker', ['exec', '-u', 'vexsmoke', this.name, 'rm', '-f', p]);
  }
  async exists(p) {
    return (await run('docker', ['exec', this.name, 'test', '-e', p])).code === 0;
  }
  async readLogs() {
    const r = await run('docker', ['exec', '-u', 'vexsmoke', this.name, 'bash', '-c',
      'cat "$1"/log/* 2>/dev/null', '_', this.dataDir]);
    return r.stdout;
  }
  async signal(pid, sig) {
    await runOk('docker', ['exec', '-u', 'vexsmoke', this.name, 'bash', '-c',
      `kill -${sig.replace(/^SIG/, '')} "$1"`, '_', String(pid)]);
  }
  async alive(pid) {
    const r = await run('docker', ['exec', '-u', 'vexsmoke', this.name, 'bash', '-c',
      'kill -0 "$1" 2>/dev/null && ! grep -q "^State:.*Z" /proc/"$1"/status', '_', String(pid)]);
    return r.code === 0;
  }
  async pickPort() {
    // A fresh network namespace: nothing listens except the forwarder.
    return 20000 + crypto.randomInt(30000);
  }
  async forward(port) {
    if (this.forwarder) return;
    const r = await this.sh(
      `nohup socat TCP-LISTEN:${DockerRunner.FORWARD_PORT},fork,reuseaddr TCP:127.0.0.1:${port} ` +
        '>/dev/null 2>&1 & echo $!');
    this.forwarder = Number(r.stdout.trim());
  }
  clientPort() {
    return this.hostPort;
  }
  async holdPort(port) {
    const r = await this.sh(
      `nohup socat TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr SYSTEM:true >/dev/null 2>&1 & ` +
        `echo $!; for i in $(seq 50); do (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && exit 0; sleep 0.1; done; exit 1`);
    const pid = Number(r.stdout.trim().split('\n')[0]);
    return async () => {
      await this.signal(pid, 'SIGTERM');
    };
  }
  async close() {
    await run('docker', ['rm', '-f', this.name]);
  }
}

// ---- server lifecycle ------------------------------------------------------

// Spawn `postgres -D <data> -p <port>` and wait until it is ready. Readiness is
// the postmaster.pid status line (what `pg_ctl -w` waits for); the stderr text
// is also recorded, because with logging_collector = on the "ready to accept
// connections" line goes to log/, not to stderr.
const seenPostmasters = new Set();
async function startServer(r, port) {
  if (r instanceof WindowsRunner) return startServerWin(r, port);
  const t0 = performance.now();
  const child = r.spawnServer(['-D', r.dataDir, '-p', String(port)]);
  const srv = { child, stderr: '', exited: null, port };
  child.stderr.on('data', (d) => (srv.stderr += d));
  child.stdout.on('data', (d) => (srv.stderr += d));
  srv.exitPromise = new Promise((resolve) =>
    child.on('close', (code, signal) => {
      srv.exited = { code, signal };
      resolve(srv.exited);
    }));
  while (performance.now() - t0 < READY_TIMEOUT_MS) {
    if (srv.exited) return { srv, ready: false, ms: performance.now() - t0 };
    const pid = await r.readFile(path.posix.join(r.dataDir, 'postmaster.pid'));
    const lines = pid?.split('\n') ?? [];
    // A SIGKILLed postmaster leaves its file behind still saying "ready", so
    // the file must name the postmaster we just spawned (on the host that is
    // our child; in the container, a pid we have not started before).
    const filePid = Number(lines[0]);
    const ours = r instanceof HostRunner ? filePid === child.pid : !seenPostmasters.has(filePid);
    if (lines.length > 7 && lines[7].trim() === 'ready' && ours && (await r.alive(filePid))) {
      srv.pid = filePid;
      seenPostmasters.add(filePid);
      const ms = performance.now() - t0;
      if (r instanceof DockerRunner) await r.forward(port);
      return { srv, ready: true, ms };
    }
    await sleep(25);
  }
  throw new SmokeError(`server not ready after ${READY_TIMEOUT_MS} ms; stderr:\n${srv.stderr}`);
}

async function startOrDie(r, port, what) {
  const { srv, ready, ms } = await startServer(r, port);
  if (!ready) {
    throw new SmokeError(`${what}: postgres exited ${JSON.stringify(srv.exited)}\nstderr:\n${srv.stderr}\nlog:\n${await r.readLogs()}`);
  }
  log(`${what}: ready in ${ms.toFixed(0)} ms (postmaster pid ${srv.pid})`);
  return { srv, ms };
}

async function waitExit(srv, timeoutMs) {
  const res = await Promise.race([srv.exitPromise, sleep(timeoutMs).then(() => null)]);
  if (!res) throw new SmokeError(`postmaster did not exit within ${timeoutMs} ms`);
  return res;
}

// ---- client helpers --------------------------------------------------------

const openClients = new Set();
async function connect(r, port, database, password, { retryMs = 15_000 } = {}) {
  const t0 = performance.now();
  for (;;) {
    const c = new pg.Client({
      host: '127.0.0.1', port: r.clientPort(port), user: PG_USER, password, database,
      connectionTimeoutMillis: 5_000,
    });
    // A server stopped under an open client must not crash the smoke with an
    // unhandled 'error' event; the failure surfaces on the next query.
    c.on('error', (e) => log(`client error (${database}): ${e.message}`));
    openClients.add(c);
    try {
      await c.connect();
      await c.query('SELECT 1');
      return c;
    } catch (e) {
      await c.end().catch(() => {});
      // Auth or missing-database errors are real failures; only retry the
      // window where the port forwarder or the server is not accepting yet.
      if (e.code || performance.now() - t0 > retryMs) throw e;
      await sleep(100);
    }
  }
}

async function one(c, sql, params) {
  const res = await c.query(sql, params);
  return res.rows[0];
}

// Deterministic vectors so the expected nearest neighbours can be computed
// here, independently of pgvector.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DIM = 768;
function makeVector(rand) {
  return Array.from({ length: DIM }, () => Math.fround(rand() * 2 - 1));
}
const vecText = (v) => `[${v.join(',')}]`;
function cosineDistance(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return 1 - dot / Math.sqrt(na * nb);
}

// ---- the smoke -------------------------------------------------------------

async function main() {
  const [treeArg, targetArg] = process.argv.slice(2);
  if (!treeArg) throw new SmokeError('usage: node smoke.mjs <tree> [target]');
  const srcTree = path.resolve(treeArg);
  const target = targetArg ?? TARGETS.find((t) => srcTree.split(path.sep).includes(t));
  if (!TARGETS.includes(target)) throw new SmokeError(`cannot tell the target of ${srcTree}; pass it`);
  const win = target.startsWith('win32');
  const pgExe = path.join(srcTree, 'bin', win ? 'postgres.exe' : 'postgres');
  if (!fs.existsSync(pgExe)) throw new SmokeError(`${srcTree} has no ${path.relative(srcTree, pgExe)}`);
  if (target.startsWith('darwin') && process.platform !== 'darwin') throw new SmokeError(`${target} smoke needs macOS`);
  if (win && process.platform !== 'win32') throw new SmokeError(`${target} smoke needs Windows`);
  log(`target ${target}, tree ${srcTree}, node ${process.version} (${process.arch}), pg client ${pgVersion}`);

  const results = { target };
  if (win) {
    // Both Windows runtimes ship the x64 tree (win32-arm64: under emulation).
    const machine = peInfo(pgExe)?.machine;
    check(machine === 'x64', `bin/postgres.exe is an x64 PE (${machine})`);
    results.host = { arch: os.arch(), cpu: os.cpus()[0]?.model, emulated: os.arch() !== 'x64' };
    log(`host ${os.arch()} (${results.host.cpu}): ${os.arch() === 'x64' ? 'native x64' : 'x64 binaries run under Windows x64 emulation'}`);
  } else {
    const fileOut = (await runOk('file', ['-b', pgExe])).stdout.trim();
    log(`bin/postgres: ${fileOut}`);
  }
  if (target === 'darwin-x64') {
    const archs = (await runOk('lipo', ['-archs', path.join(srcTree, 'bin', 'postgres')])).stdout.trim();
    const hostArch = (await runOk('uname', ['-m'])).stdout.trim();
    check(archs === 'x86_64', `darwin-x64 binaries are x86_64 only (lipo: ${archs})`);
    log(`host is ${hostArch}: ${hostArch === 'arm64' ? 'x86_64 binaries run under Rosetta 2' : 'native x86_64'}`);
  }

  // Size of the shipped tree, uncompressed and as the archives we might ship.
  if (win) {
    // No du/tar/xz outside Git Bash; the workflow's pack step prints those.
    const bytes = fs.readdirSync(srcTree, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile()).reduce((n, e) => n + fs.statSync(path.join(e.parentPath, e.name)).size, 0);
    results.size = { bytes };
    log(`tree size: ${(bytes / 1048576).toFixed(1)} MiB (file bytes)`);
  } else {
    const du = (await runOk('du', ['-sk', srcTree])).stdout.split('\t')[0];
    const gz = (await runOk('bash', ['-c', 'tar -C "$1" -cf - . | gzip -9 | wc -c', '_', srcTree])).stdout.trim();
    const xz = (await runOk('bash', ['-c', 'tar -C "$1" -cf - . | xz -9 | wc -c', '_', srcTree])).stdout.trim();
    results.size = { du_kib: Number(du), tar_gz_9_bytes: Number(gz), tar_xz_9_bytes: Number(xz) };
    log(`tree size: ${(du / 1024).toFixed(1)} MiB on disk, tar.gz -9 ${(gz / 1048576).toFixed(1)} MiB, tar.xz -9 ${(xz / 1048576).toFixed(1)} MiB`);
  }

  // Relocate: a fresh directory whose path contains spaces. On Windows also a
  // non-ASCII component (a user profile path like C:\Users\Zoë\...), with
  // the 8.3 short form %TEMP% often has on CI expanded to the long one.
  const tmp = win ? fs.realpathSync.native(os.tmpdir()) : os.tmpdir();
  const base = fs.mkdtempSync(path.join(tmp, 'vex pg smoke '));
  const home = win ? path.join(base, 'vex ünïcode test') : base;
  const cleanup = [];
  cleanup.push(async () => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const servers = [];
  let r;
  try {
    const tree = path.join(home, 'Vex Runtime', 'postgres');
    fs.cpSync(srcTree, tree, { recursive: true, verbatimSymlinks: true });
    log(`relocated tree to "${tree}"`);

    if (target === 'linux-x64') {
      r = new DockerRunner(tree);
      cleanup.unshift(() => r.close());
      await r.start();
    } else if (win) {
      r = new WindowsRunner(home, tree);
    } else {
      r = new HostRunner(base, tree);
    }
    // On failure, stop any server we left running with an immediate shutdown
    // and give it time to exit: a SIGKILLed postmaster leaves its SysV
    // semaphores and shm segment behind, and on macOS those outlive the
    // deleted data dir until reboot.
    cleanup.unshift(async () => {
      for (const oc of openClients) await oc.end().catch(() => {});
      for (const s of servers) {
        if (s.exited) continue;
        if (s.pid && (await r.alive(s.pid))) {
          await r.signal(s.pid, 'SIGQUIT').catch(() => {});
          await Promise.race([s.exitPromise, sleep(10_000)]);
        }
        if (!s.exited) {
          console.error(`[smoke] cleanup: postmaster ${s.pid} ignored SIGQUIT; killing it (its SysV IPC may leak)`);
          if (s.pid) await r.signal(s.pid, 'SIGKILL').catch(() => {});
          s.child?.kill('SIGKILL');
        }
      }
    });
    log(`runner: ${r.label}; data dir "${r.dataDir}"`);

    // -- 6.2 initdb ---------------------------------------------------------
    const password = crypto.randomBytes(24).toString('base64url');
    const pwfile = path.posix.join(r.workDir, 'pwfile');
    await r.writeFile(pwfile, `${password}\n`);
    let t0 = performance.now();
    const init = await r.exec('initdb', [
      '-D', r.dataDir, '-U', PG_USER, `--pwfile=${pwfile}`, '-E', 'UTF8',
      '--locale=C', '--locale-provider=builtin', '--builtin-locale=C.UTF-8',
      '--auth-local=scram-sha-256', '--auth-host=scram-sha-256',
    ]);
    results.initdb_ms = Math.round(performance.now() - t0);
    await r.rm(pwfile);
    if (init.code !== 0) throw new SmokeError(`initdb failed (${init.code}):\n${init.stdout}${init.stderr}`);
    check(!(await r.exists(pwfile)), 'pwfile deleted after initdb');
    log(`initdb: ${results.initdb_ms} ms`);
    check(/Data page checksums are enabled/.test(init.stdout), 'initdb enabled data checksums (PG18 default)');

    // -- 6.3 postgresql.conf, 6.4 pg_hba.conf ------------------------------
    // port is passed as -p at launch (6.3 "chosen at launch, passed as -p").
    const conf = [
      '', '# --- Vex (plan 6.3) ---',
      "listen_addresses = '127.0.0.1'",
      "unix_socket_directories = ''",
      'password_encryption = scram-sha-256',
      'max_connections = 40',
      'superuser_reserved_connections = 2',
      'shared_buffers = 128MB',
      'work_mem = 8MB',
      'maintenance_work_mem = 128MB',
      'effective_cache_size = 1GB',
      'wal_level = minimal',
      'max_wal_senders = 0',
      'max_wal_size = 512MB',
      'min_wal_size = 80MB',
      'wal_compression = on',
      'checkpoint_timeout = 10min',
      'max_worker_processes = 4',
      'max_parallel_workers_per_gather = 1',
      'autovacuum_worker_slots = 4',
      'jit = off',
      'huge_pages = off',
      "timezone = 'UTC'",
      "log_timezone = 'UTC'",
      "lc_messages = 'C'",
      'logging_collector = on',
      "log_directory = 'log'",
      'log_rotation_size = 10MB',
      'log_truncate_on_rotation = on',
      'fsync = on',
      'full_page_writes = on',
      'synchronous_commit = on',
      ...(target.startsWith('darwin') ? ['wal_sync_method = fsync_writethrough'] : []),
      '',
    ].join('\n');
    await r.appendFile(path.posix.join(r.dataDir, 'postgresql.conf'), conf);
    await r.writeFile(path.posix.join(r.dataDir, 'pg_hba.conf'),
      'host  all  vex  127.0.0.1/32  scram-sha-256\nhost  all  vex  ::1/128       scram-sha-256\n');

    // -- 6.6 semaphores and shared memory (runtime-computed: server stopped) -
    // On Windows -C must come first: only then does postgres.exe skip its
    // refusal to run with administrative rights (main.c do_check_root).
    const cfg = async (name) => {
      const res = await r.exec('postgres', win ? ['-C', name, '-D', r.dataDir] : ['-D', r.dataDir, '-C', name]);
      if (res.code !== 0) throw new SmokeError(`postgres -C ${name} failed:\n${res.stderr}`);
      return res.stdout.trim();
    };
    results.num_os_semaphores = await cfg('num_os_semaphores');
    results.shared_memory_size = await cfg('shared_memory_size');
    log(`postgres -C num_os_semaphores = ${results.num_os_semaphores}, shared_memory_size = ${results.shared_memory_size}`);

    // -- start --------------------------------------------------------------
    const port = await r.pickPort();
    if (r instanceof WindowsRunner) {
      // The reason Vex must use pg_ctl on Windows, shown on this machine.
      const groups = (await runOk('whoami', ['/groups'])).stdout;
      results.elevated = /S-1-16-12288/.test(groups); // High Mandatory Level
      if (results.elevated) {
        const direct = await r.exec('postgres', ['-D', r.dataDir, '-p', String(port)], { timeoutMs: 60_000 });
        check(direct.code !== 0 &&
          /Execution of PostgreSQL by a user with administrative permissions is not\s+permitted/.test(direct.stderr),
        `elevated: postgres.exe started directly refuses to run (exit ${direct.code}), so it is started through pg_ctl`);
        check(!(await r.exists(path.join(r.dataDir, 'postmaster.pid'))), 'the refused direct start left no postmaster.pid');
      } else {
        log('not elevated: skipping the direct-start refusal check (CI runners are elevated)');
      }
    }
    let { srv, ms } = await startOrDie(r, port, 'first start');
    servers.push(srv);
    results.start_to_ready_ms = Math.round(ms);
    results.stderr_on_start = srv.stderr.trim();
    log(`server stderr: ${JSON.stringify(srv.stderr.trim())}`);
    // The syslogger writes asynchronously, so give the line a moment to land.
    let readyLogged = false;
    for (let i = 0; i < 50 && !readyLogged; i++) {
      readyLogged = /ready to accept connections/.test(await r.readLogs());
      if (!readyLogged) await sleep(100);
    }
    check(readyLogged, '"ready to accept connections" is in log/ (logging_collector), not on stderr');
    results.ready_line_on_stderr = /ready to accept connections/.test(srv.stderr);

    // -- auth ---------------------------------------------------------------
    let bad = null;
    try {
      const c = await connect(r, port, 'postgres', `${password}x`);
      await c.end();
    } catch (e) {
      bad = e;
    }
    check(bad?.code === '28P01', `wrong password is refused (${bad?.code} ${bad?.message})`);

    let c = await connect(r, port, 'postgres', password);
    const who = await one(c, `SELECT current_setting('data_directory') AS dir, current_setting('port') AS port`);
    // Windows: the server reports data_directory with forward slashes, and in
    // the ANSI code page (Postgres uses the -A file APIs), so to a UTF8 client
    // each non-ASCII character of the path arrives as U+FFFD.
    const wantDir = win ? r.dataDir.replace(/\\/g, '/') : r.dataDir;
    const acpDir = wantDir.replace(/[^\x00-\x7f]/g, '\ufffd');
    check((who.dir === wantDir || (win && who.dir === acpDir)) && who.port === String(port),
      `connected to the smoke server ("${who.dir}", port ${who.port})`);
    if (who.dir !== wantDir) {
      results.data_directory_as_reported = who.dir;
      log('note: data_directory comes back in the ANSI code page, not UTF-8 (non-ASCII characters arrive as U+FFFD)');
    }
    const authRow = await one(c, `SELECT rolpassword LIKE 'SCRAM-SHA-256$%' AS scram FROM pg_authid WHERE rolname = 'vex'`);
    check(authRow.scram === true, 'vex password is stored as a SCRAM-SHA-256 verifier');
    const hba = await c.query('SELECT type, user_name, address, auth_method FROM pg_hba_file_rules ORDER BY rule_number');
    check(hba.rows.length === 2 && hba.rows.every((x) => x.type === 'host' && x.auth_method === 'scram-sha-256'),
      `pg_hba has exactly the two 6.4 rules (${JSON.stringify(hba.rows)})`);
    const ssl = await one(c, `SELECT current_setting('ssl_library') AS lib, current_setting('ssl') AS ssl`);
    check(ssl.lib === '' && ssl.ssl === 'off', `server built without OpenSSL (ssl_library='${ssl.lib}'), SCRAM login worked`);
    const sv = await one(c, 'SELECT version() AS v');
    log(`server: ${sv.v}`);
    await c.query('CREATE DATABASE vex OWNER vex');
    await c.end();

    // -- the vex database ---------------------------------------------------
    c = await connect(r, port, 'vex', password);
    await c.query('CREATE EXTENSION vector');
    const ext = await one(c, `SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
    check(ext.extversion === '0.8.7', `pgvector ${ext.extversion} installed`);

    const rand = rng(20261017);
    const rows = Array.from({ length: 300 }, () => makeVector(rand));
    await c.query('CREATE TABLE items (id int PRIMARY KEY, embedding vector(768) NOT NULL)');
    await c.query('CREATE INDEX items_embedding_hnsw ON items USING hnsw (embedding vector_cosine_ops)');
    await c.query('BEGIN');
    for (let i = 0; i < rows.length; i++) {
      await c.query('INSERT INTO items VALUES ($1, $2::vector)', [i, vecText(rows[i])]);
    }
    await c.query('COMMIT');
    const qrand = rng(7);
    const query = rows[42].map((x) => Math.fround(x + (qrand() - 0.5) * 0.2));
    const expected = rows
      .map((v, id) => ({ id, d: cosineDistance(query, v) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
    await c.query('SET enable_seqscan = off');
    const plan = await c.query('EXPLAIN SELECT id FROM items ORDER BY embedding <=> $1::vector LIMIT 5', [vecText(query)]);
    check(plan.rows.some((x) => /Index Scan using items_embedding_hnsw/.test(x['QUERY PLAN'])), 'the <=> query uses the HNSW index');
    const got = await c.query(
      'SELECT id, embedding <=> $1::vector AS d FROM items ORDER BY embedding <=> $1::vector LIMIT 5', [vecText(query)]);
    await c.query('RESET enable_seqscan');
    check(got.rows[0].id === 42, `nearest neighbour is row 42 (got ${got.rows[0].id})`);
    check(
      got.rows.every((x, i) => x.id === expected[i].id && Math.abs(x.d - expected[i].d) < 1e-5),
      `HNSW top-5 ${JSON.stringify(got.rows.map((x) => x.id))} matches the exact cosine top-5 ${JSON.stringify(expected.map((x) => x.id))}`);

    const uuid = await one(c, 'SELECT gen_random_uuid()::text AS a, gen_random_uuid()::text AS b');
    check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid.a) && uuid.a !== uuid.b,
      `gen_random_uuid() works without OpenSSL (${uuid.a})`);
    const settings = await one(c, `SELECT current_setting('server_encoding') AS enc, current_setting('timezone') AS tz,
      current_setting('data_checksums') AS sums, current_setting('wal_sync_method') AS wsm,
      current_setting('max_connections') AS maxc, d.datlocprovider AS prov, d.datlocale AS loc, d.datcollate AS coll
      FROM pg_database d WHERE d.datname = current_database()`);
    check(settings.enc === 'UTF8', `server_encoding = ${settings.enc}`);
    check(settings.tz === 'UTC', `timezone = ${settings.tz}`);
    check(settings.sums === 'on', `data_checksums = ${settings.sums}`);
    check(settings.prov === 'b' && settings.loc === 'C.UTF-8' && settings.coll === 'C',
      `database locale: provider ${settings.prov}, locale ${settings.loc}, collate ${settings.coll}`);
    check(settings.maxc === '40', `max_connections = ${settings.maxc}`);
    if (target.startsWith('darwin')) check(settings.wsm === 'fsync_writethrough', `wal_sync_method = ${settings.wsm}`);
    else log(`wal_sync_method = ${settings.wsm} (platform default)`);
    // A timestamptz literal through the bundled tz database.
    const tzr = await one(c, `SELECT ('2026-07-01 12:00:00+00'::timestamptz AT TIME ZONE 'Europe/Warsaw')::text AS t`);
    check(tzr.t === '2026-07-01 14:00:00', `bundled timezone data resolves Europe/Warsaw (${tzr.t})`);

    // Encoding conversion modules and snowball + tsearch_data, loaded on use.
    const conv = await one(c, `SELECT encode(convert_to('zażółć', 'LATIN2'), 'hex') AS l2,
      encode(convert_to('日本', 'SJIS'), 'hex') AS sjis, to_tsvector('english', 'The running dogs')::text AS ts`);
    check(conv.l2 === '7a61bff3b3e6' && conv.sjis === '93fa967b',
      `encoding conversion modules load (LATIN2 ${conv.l2}, SJIS ${conv.sjis})`);
    check(conv.ts === `'dog':3 'run':2`, `snowball stemmer + english stopwords work (${conv.ts})`);

    const sysid = (await one(c,'SELECT system_identifier::text AS id FROM pg_control_system()')).id;
    const cd = await r.exec('pg_controldata', ['-D', r.dataDir]);
    const cdId = /Database system identifier:\s+(\d+)/.exec(cd.stdout)?.[1];
    check(cd.code === 0 && cdId === sysid, `system_identifier ${sysid} matches pg_controldata`);
    results.system_identifier = sysid;

    const fingerprint = `SELECT count(*)::int AS n, md5(string_agg(id || ':' || embedding::text, ',' ORDER BY id)) AS h FROM items`;
    const before = await one(c, fingerprint);

    // -- pg_dump -Fc | pg_restore ------------------------------------------
    const dump = path.posix.join(r.workDir, 'vex.dump');
    const pgEnv = { PGPASSWORD: password };
    const connArgs = ['-h', '127.0.0.1', '-p', String(port), '-U', PG_USER];
    t0 = performance.now();
    const d = await r.exec('pg_dump', [...connArgs, '-d', 'vex', '-Fc', '-f', dump], { env: pgEnv });
    if (d.code !== 0) throw new SmokeError(`pg_dump failed:\n${d.stderr}`);
    await c.query('CREATE DATABASE vex_restore OWNER vex');
    const rs = await r.exec('pg_restore', [...connArgs, '-d', 'vex_restore', '--exit-on-error', dump], { env: pgEnv });
    if (rs.code !== 0) throw new SmokeError(`pg_restore failed:\n${rs.stderr}`);
    results.dump_restore_ms = Math.round(performance.now() - t0);
    const c2 = await connect(r, port, 'vex_restore', password);
    const restored = await one(c2, fingerprint);
    const ridx = await one(c2, `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'items_embedding_hnsw'`);
    await c2.end();
    check(restored.n === before.n && restored.h === before.h && ridx.n === 1,
      `pg_dump -Fc / pg_restore round trip: ${restored.n} rows, same content hash, HNSW index restored`);
    await r.rm(dump);
    await c.end();

    // -- fast stop (SIGINT) -------------------------------------------------
    const pidFile = path.posix.join(r.dataDir, 'postmaster.pid');
    t0 = performance.now();
    await r.signal(srv.pid, 'SIGINT');
    let ex = await waitExit(srv, 30_000);
    results.fast_stop_ms = Math.round(performance.now() - t0);
    check(ex.code === 0, `SIGINT fast stop: exit ${ex.code} in ${results.fast_stop_ms} ms`);
    check(!(await r.exists(pidFile)), 'postmaster.pid is gone after the fast stop');

    // -- restart ------------------------------------------------------------
    ({ srv, ms } = await startOrDie(r, port, 'restart after fast stop'));
    servers.push(srv);
    results.restart_ms = Math.round(ms);
    c = await connect(r, port, 'vex', password);
    const afterRestart = await one(c, fingerprint);
    check(afterRestart.h === before.h, 'data intact after restart');
    // A committed row right before the crash must survive it (synchronous_commit = on).
    await c.query(`INSERT INTO items SELECT 1000, embedding FROM items WHERE id = 0`);
    const beforeCrash = await one(c, fingerprint);
    await c.end().catch(() => {});

    // -- SIGKILL the postmaster, then crash recovery ------------------------
    await r.signal(srv.pid, 'SIGKILL');
    ex = await waitExit(srv, 10_000);
    log(`postmaster SIGKILLed (exit ${JSON.stringify(ex)})`);
    // Its children notice postmaster death and exit on their own; until they
    // have, a new postmaster refuses the data dir ("pre-existing shared memory
    // block is still in use"). Retry like the app's restart path would.
    t0 = performance.now();
    let attempts = 0;
    for (;;) {
      attempts++;
      const res = await startServer(r, port);
      if (res.ready) {
        srv = res.srv;
        servers.push(srv);
        ms = res.ms;
        break;
      }
      const why = res.srv.stderr + (await r.readLogs());
      if (!/pre-existing shared memory block|lock file .* already exists|is another postmaster/.test(res.srv.stderr) ||
          performance.now() - t0 > 30_000) {
        throw new SmokeError(`restart after SIGKILL failed (attempt ${attempts}):\n${why}`);
      }
      log(`restart attempt ${attempts} refused while orphans exit: ${res.srv.stderr.trim().split('\n')[0]}`);
      await sleep(250);
    }
    results.crash_restart = { attempts, total_ms: Math.round(performance.now() - t0), last_start_to_ready_ms: Math.round(ms) };
    log(`restart after SIGKILL: ready after ${attempts} attempt(s), ${results.crash_restart.total_ms} ms total`);
    const logs = await r.readLogs();
    check(/database system was interrupted|not properly shut down; automatic recovery in progress/.test(logs) &&
      /redo (starts|done)/.test(logs), 'server log shows crash recovery (redo)');
    c = await connect(r, port, 'vex', password);
    const afterCrash = await one(c, fingerprint);
    check(afterCrash.n === beforeCrash.n && afterCrash.h === beforeCrash.h,
      `data intact after crash recovery (${afterCrash.n} rows incl. the last committed one)`);
    await c.end();
    await r.signal(srv.pid, 'SIGINT');
    ex = await waitExit(srv, 30_000);
    check(ex.code === 0 && !(await r.exists(pidFile)), 'clean fast stop after recovery');

    // -- start on a taken port ---------------------------------------------
    const release = await r.holdPort(port);
    let conflict;
    try {
      conflict = await startServer(r, port);
      if (conflict.ready) servers.push(conflict.srv);
    } finally {
      await release();
    }
    check(!conflict.ready && conflict.srv.exited.code !== 0,
      `start on a taken port fails: exit ${JSON.stringify(conflict.srv.exited)}`);
    const conflictLog = await r.readLogs();
    const msgRe = win
      ? /could not bind IPv4 address "127\.0\.0\.1": [^\n]*[\s\S]*could not create any TCP\/IP sockets/
      : /could not bind IPv4 address "127\.0\.0\.1": Address already in use[\s\S]*could not create any TCP\/IP sockets/;
    results.port_conflict = {
      exit: conflict.srv.exited,
      stderr: conflict.srv.stderr.trim(),
      message_on_stderr: msgRe.test(conflict.srv.stderr),
      message_in_log: msgRe.test(conflictLog),
    };
    check(results.port_conflict.message_on_stderr || results.port_conflict.message_in_log,
      `the bind error is reported (stderr: ${results.port_conflict.message_on_stderr}, log/: ${results.port_conflict.message_in_log})`);
    log(`port-conflict stderr: ${JSON.stringify(conflict.srv.stderr.trim())}`);
    check(!(await r.exists(pidFile)), 'no postmaster.pid left behind by the failed start');

    if (r instanceof HostRunner && !(r instanceof WindowsRunner)) {
      // Every postmaster we ran, including the SIGKILLed one (its successor
      // reclaims the same IPC keys), must have released its SysV segment.
      const ours = new Set(servers.map((s) => s.child.pid).concat(conflict.srv.child.pid));
      const leaked = (await runOk('ipcs', ['-m', '-p'])).stdout.split('\n')
        .filter((l) => l.startsWith('m')).filter((l) => ours.has(Number(l.trim().split(/\s+/)[6])));
      check(leaked.length === 0, `no SysV shared memory left behind by our postmasters${leaked.length ? `: ${leaked}` : ''}`);
    }

    if (r instanceof WindowsRunner) {
      // Not a gate, a measurement for the app: Postgres reaches files through
      // the ANSI code page, so a data dir path with characters outside it
      // (here Greek, on a Western code page) is the case to know about.
      const acp = (await run('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'])).stdout;
      const odd = path.join(base, 'δοκιμή', 'pg18');
      fs.mkdirSync(path.dirname(odd), { recursive: true });
      const pw2 = path.join(path.dirname(odd), 'pwfile');
      fs.writeFileSync(pw2, `${password}\n`);
      const res = await r.exec('initdb', ['-D', odd, '-U', PG_USER, `--pwfile=${pw2}`, '-E', 'UTF8',
        '--locale=C', '--locale-provider=builtin', '--builtin-locale=C.UTF-8', '-A', 'scram-sha-256']);
      results.non_acp_path_initdb = {
        acp: /ACP\s+REG_SZ\s+(\d+)/.exec(acp)?.[1] ?? null, exit: res.code,
        tail: `${res.stdout}${res.stderr}`.trim().split('\n').slice(-3).join(' | '),
      };
      log(`note: initdb under a path outside the ANSI code page (ACP ${results.non_acp_path_initdb.acp}): exit ${res.code}: ${results.non_acp_path_initdb.tail}`);
    }

    log('RESULTS ' + JSON.stringify(results, null, 2));
    log(`PASS ${target}`);
  } catch (e) {
    const logs = r ? await r.readLogs().catch(() => '') : '';
    if (logs) console.error(`[smoke] server log/ at failure (last 40 lines):\n${logs.trimEnd().split('\n').slice(-40).join('\n')}`);
    throw e;
  } finally {
    for (const fn of cleanup) {
      try {
        await fn();
      } catch (e) {
        console.error('[smoke] cleanup:', e.message);
      }
    }
  }
}

main().catch((e) => {
  console.error(`[smoke] FAIL: ${e instanceof SmokeError ? e.message : e.stack}`);
  process.exitCode = 1;
});
