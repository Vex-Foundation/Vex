#!/usr/bin/env node
// node smoke.mjs <target> <tree> <model.gguf>
//
// Exercises a SHIPPED llama-server tree (out/<target>/llama) the way Vex will
// launch it (plan section 7), and exits non-zero on any failure.
//
//   1. Copies the tree to a temp directory whose path contains a space and
//      runs it from there with cwd=/ , so libraries and the CPU backend must
//      be found relative to the executable.
//   2. Run A, the production launch: --port 0, the bound port parsed from the
//      "server is listening on" line. Checks auth, the embeddings contract
//      (alias, 768 dims, finite, L2 norm), the 1440-char document budget, an
//      oversized input, latency, RSS, and SIGTERM shutdown.
//   3. Run B, readiness: /health polled from the moment of spawn must answer
//      503 while the model loads and 200 after.
//
// darwin-* targets run natively (darwin-x64 under Rosetta on Apple Silicon).
// linux-x64 runs inside an ubuntu:22.04 linux/amd64 container (glibc 2.35, the
// oldest supported distro). There Run A listens on 0.0.0.0:8080 so Docker can
// publish it to the host (the one deviation from the production flags), and
// Run B keeps --host 127.0.0.1 --port 0 and is probed from inside the
// container. Timings from an emulated container are not representative.
// win32-* run natively on Windows (win32-arm64 on an arm64 machine). The tree
// AND the model are placed under a path with spaces and a non-ASCII component
// (a user profile like C:\Users\Zoë\...); "SIGTERM" is TerminateProcess
// there (the server is stateless, plan section 7).

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { peInfo } from "../lib/pe.mjs";

const ALIAS = "ai/embeddinggemma:300M-Q8_0";
const DIM = 768;
const DOC_MAX_CHARS = 1440; // src/vex-agent/embeddings/document-size-budget.ts
const UBUNTU_IMAGE =
  "ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401";
const LISTEN_RE = /^main: server is listening on http:\/\/([^:\s]+):(\d+)\s*$/;
const LOAD_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 10_000;

const [target, treeArg, modelArg] = process.argv.slice(2);
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64", "win32-arm64"];
if (!TARGETS.includes(target) || !treeArg || !modelArg) {
  console.error(`usage: node smoke.mjs <${TARGETS.join("|")}> <tree> <model.gguf>`);
  process.exit(2);
}
const tree = path.resolve(treeArg);
const srcModel = path.resolve(modelArg);
const inContainer = target === "linux-x64";
const win = target.startsWith("win32");
const exeName = win ? "llama-server.exe" : "llama-server";
for (const p of [path.join(tree, exeName), srcModel]) {
  if (!fs.existsSync(p)) fail(`missing ${p}`);
}
if (win && process.platform !== "win32") fail(`${target} smoke needs Windows`);
const ps = (cmd) => execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd]).toString().trim();

// Threads as plan D9: min(4, physical cores / 2). In the container the
// relevant count is the Docker VM's CPUs.
function physicalCores() {
  if (process.platform === "darwin") return Number(execFileSync("sysctl", ["-n", "hw.physicalcpu"]).toString());
  if (process.platform === "win32") return Number(ps("(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum"));
  return os.availableParallelism();
}
const threads = Math.max(1, Math.min(4, Math.floor(physicalCores() / 2)));

const results = { target, threads, checks: [], metrics: {}, notes: [] };
const cleanups = [];
const vectors = {};
let failed = false;

function fail(msg) {
  console.error(`FAIL ${msg}`);
  failed = true;
  throw new Error(msg);
}
function check(cond, msg) {
  if (!cond) fail(msg);
  results.checks.push(msg);
  console.log(`ok   ${msg}`);
}
function note(msg) {
  results.notes.push(msg);
  console.log(`note ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------- relocation

const tmpRoot = fs.mkdtempSync(path.join(win ? fs.realpathSync.native(os.tmpdir()) : os.tmpdir(), "vex llama smoke "));
cleanups.push(() => fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
const home = win ? path.join(tmpRoot, "vex ünïcode δοκιμή test") : tmpRoot;
const relocated = path.join(home, "runtime dir", "llama");
// Windows: fs.cpSync (Node 22) copies nothing into a destination whose path
// has non-ASCII characters, without an error; copy file by file instead.
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(path.join(src, e.name), path.join(dst, e.name));
    else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}
if (win) copyTree(tree, relocated);
else fs.cpSync(tree, relocated, { recursive: true, verbatimSymlinks: true });
const exe = path.join(relocated, exeName);
const cacheDir = path.join(tmpRoot, "llama cache");
// Windows: the model too, as it will sit under the user's profile.
let model = srcModel;
if (win) {
  model = path.join(home, "models", path.basename(srcModel));
  fs.mkdirSync(path.dirname(model), { recursive: true });
  fs.copyFileSync(srcModel, model);
  console.log(`model copied to "${model}"`);
}
const launchedPids = [];
const containerTree = "/opt/vex runtime/llama";
const containerModel = `/models/${path.basename(model)}`;
console.log(`tree copied to "${relocated}"`);

// --------------------------------------------------------------- launching

function serverArgs({ host, port }) {
  return [
    "--model", inContainer ? containerModel : model,
    "--embeddings",
    "--alias", ALIAS,
    "--host", host,
    "--port", String(port),
    "--device", "none",
    "-ngl", "0",
    "-np", "1",
    "-t", String(threads),
    "-tb", String(threads),
    "--no-webui",
    "--offline",
  ];
}

// Starts the server; returns a handle with its log lines, a way to wait for a
// log line, RSS, and stop().
function launch({ name, host, port, publish, apiKey }) {
  let child;
  let containerName = null;
  const args = serverArgs({ host, port });
  // Only what the server needs: llama-server also reads LLAMA_ARG_* and
  // AIP_* from the environment, so the developer's shell must not leak in.
  // LLAMA_CACHE is required: with neither it nor HOME set, b9115 on macOS
  // dereferences getenv("HOME") == NULL at startup (common/common.cpp
  // fs_get_cache_directory) and dies with SIGSEGV. Nothing may be written
  // there (checked after the runs).
  // Windows: SystemRoot is needed by Winsock; nothing else is inherited.
  const env = win
    ? { SystemRoot: process.env.SystemRoot, LLAMA_API_KEY: apiKey, LLAMA_CACHE: cacheDir }
    : { PATH: "/usr/bin:/bin", LLAMA_API_KEY: apiKey, LLAMA_CACHE: inContainer ? "/tmp/llama-cache" : cacheDir };
  if (!inContainer) {
    // cwd is a directory without the tree in it (the filesystem root), so the
    // DLLs and CPU backends must be found next to the executable.
    child = spawn(exe, args, { cwd: path.parse(exe).root, env, stdio: ["ignore", "pipe", "pipe"] });
    launchedPids.push(child.pid);
  } else {
    containerName = `vex-llama-smoke-${name}-${randomBytes(4).toString("hex")}`;
    const dargs = [
      "run", "--platform", "linux/amd64", "--name", containerName, "-w", "/",
      "--mount", `type=bind,source=${relocated},target=${containerTree},readonly`,
      "--mount", `type=bind,source=${path.dirname(model)},target=/models,readonly`,
      "-e", "LLAMA_API_KEY", "-e", `LLAMA_CACHE=${env.LLAMA_CACHE}`,
    ];
    if (publish) dargs.push("-p", `127.0.0.1:${publish}:${port}`);
    dargs.push(UBUNTU_IMAGE, `${containerTree}/llama-server`, ...args);
    child = spawn("docker", dargs, { env: { ...process.env, LLAMA_API_KEY: apiKey }, stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(() => {
      try { execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" }); } catch {}
    });
  }
  const t0 = performance.now();
  const lines = [];
  const waiters = [];
  let exited = null;
  const onData = (stream) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ""); // Windows writes CRLF
        buf = buf.slice(i + 1);
        lines.push({ t: performance.now() - t0, line });
        for (const w of [...waiters]) if (w.re.test(line)) { waiters.splice(waiters.indexOf(w), 1); w.resolve({ t: performance.now() - t0, line }); }
      }
    });
  };
  onData(child.stdout);
  onData(child.stderr);
  const exitP = new Promise((resolve) => child.on("exit", (code, signal) => { exited = { code, signal, t: performance.now() }; resolve(exited); }));
  cleanups.push(() => { if (!exited) try { child.kill("SIGKILL"); } catch {} });

  const h = {
    child, lines, t0, containerName, exitP,
    get exited() { return exited; },
    waitFor(re, timeoutMs) {
      const hit = lines.find((l) => re.test(l.line));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { re, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timed out waiting for ${re}`)), timeoutMs).unref();
        exitP.then((e) => reject(new Error(`server exited (${JSON.stringify(e)}) before ${re}\n${tail(lines)}`)));
      });
    },
    // RSS counts the clean, reclaimable pages of the mmap'd model, so on macOS
    // it swings by hundreds of MiB; phys_footprint (what Activity Monitor
    // shows) is the stable number there.
    memory() {
      if (inContainer) {
        const st = execFileSync("docker", ["exec", containerName, "cat", "/proc/1/status"]).toString();
        return { rssMiB: Math.round(Number(/VmRSS:\s+(\d+)/.exec(st)[1]) / 1024) };
      }
      if (win) {
        // Working set (the RSS analogue) and private bytes (the commit charge,
        // the stable number, like macOS's phys_footprint).
        const [ws, priv] = ps(`$p = Get-Process -Id ${child.pid}; "$($p.WorkingSet64) $($p.PrivateMemorySize64)"`).split(/\s+/).map(Number);
        return { rssMiB: Math.round(ws / 1048576), privateMiB: Math.round(priv / 1048576) };
      }
      const rssMiB = Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)]).toString().trim()) / 1024);
      const fp = /phys_footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(execFileSync("footprint", ["-p", String(child.pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString());
      const footprintMiB = fp ? Math.round(Number(fp[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[fp[2]]) : null;
      return { rssMiB, footprintMiB };
    },
    async stop() {
      const t = performance.now();
      if (!inContainer) child.kill("SIGTERM");
      else execFileSync("docker", ["kill", "--signal", "TERM", containerName], { stdio: "ignore" });
      const timer = sleep(STOP_TIMEOUT_MS).then(() => null);
      const e = await Promise.race([exitP, timer]);
      if (!e) fail(`${name}: did not exit within ${STOP_TIMEOUT_MS} ms of SIGTERM`);
      let code = e.code;
      if (inContainer) {
        const st = JSON.parse(execFileSync("docker", ["inspect", "--format", "{{json .State}}", containerName]).toString());
        if (st.Running) fail(`${name}: container still running after SIGTERM`);
        code = st.ExitCode;
      }
      return { ms: Math.round(e.t - t), code, signal: e.signal };
    },
  };
  return h;
}

const tail = (lines, n = 25) => lines.slice(-n).map((l) => l.line).join("\n");

function noOrphans() {
  if (inContainer) {
    const left = execFileSync("docker", ["ps", "-q", "--filter", "name=vex-llama-smoke-"]).toString().trim();
    return left === "";
  }
  if (win) {
    // The server starts no processes of its own: every PID we launched is gone.
    return launchedPids.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } });
  }
  const psOut = execFileSync("ps", ["-axo", "pid=,command="]).toString();
  return !psOut.split("\n").some((l) => l.includes(relocated));
}

// ------------------------------------------------------------------ client

// Windows: the memory probe (PowerShell) can take longer than cpp-httplib's
// 5 s keep-alive on a small runner, and the next request then goes out on a
// pooled socket the server already closed. Retry such a request once.
async function http(base, method, p, opts = {}) {
  try {
    return await httpOnce(base, method, p, opts);
  } catch (e) {
    if (!win || !["UND_ERR_SOCKET", "ECONNRESET"].includes(e?.cause?.code)) throw e;
    results.metrics.staleSocketRetries = (results.metrics.staleSocketRetries ?? 0) + 1;
    return httpOnce(base, method, p, opts);
  }
}

async function httpOnce(base, method, p, { key, body, timeoutMs = 60_000 } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (key) headers.Authorization = `Bearer ${key}`;
  const t = performance.now();
  const res = await fetch(base + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const ms = performance.now() - t;
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, ms };
}

const embed = (base, key, input) => http(base, "POST", "/v1/embeddings", { key, body: { input, model: ALIAS } });

function vectorOf(r) {
  const v = r.json?.data?.[0]?.embedding;
  if (!Array.isArray(v)) fail(`no embedding in response: ${r.text.slice(0, 300)}`);
  return v;
}

// Inputs shaped like the app's (client.ts formatQueryInput / formatDocumentInput).
const PROSE =
  "Vex keeps a local memory of what the user worked on so that later questions can be answered with context. " +
  "Each entry is summarised, embedded and stored next to its source, and recall ranks entries by cosine similarity. " +
  "The embedding runtime runs on the CPU, loads a small quantised model once, and answers requests over loopback HTTP. " +
  "Documents are capped by characters because the tokenizer is not shipped with the app, and the cap is conservative. ";
const queryInput = (i) => `task: search result | query: how did we rotate the database credentials last week (${i})`;
function docInput(i, chars = DOC_MAX_CHARS) {
  const head = `title: Session notes ${i} | text: `;
  let body = "";
  while (head.length + body.length < chars) body += PROSE;
  return (head + body).slice(0, chars);
}
// The densest document the app produces by construction: a session-memory
// chunk at its 800-char model budget (theme + happened/did/tried + five
// outstanding texts, MEMORY_CHUNK_MODEL_BUDGET_CHARS) rendered exactly as
// session-memories/types.ts renderBodyMd does (UUID + ISO timestamp per item)
// and wrapped by formatDocumentInput.
function sessionMemoryInput() {
  const fill = (n, seed) => { let s = ""; while (s.length < n) s += PROSE; return s.slice(seed, seed + n).trim(); };
  const theme = fill(40, 0);
  const texts = Array.from({ length: 5 }, (_, i) => fill(40, 37 * (i + 1)));
  const [happened, did, tried] = [fill(187, 11), fill(187, 101), fill(186, 203)];
  const lines = ["## What happened", happened, "", "## What I did", did, "", "## What I tried", tried, "", "## Outstanding"];
  for (const t of texts) lines.push(`- [${randomUUID()}] ${t} (created ${new Date().toISOString()}) — UNRESOLVED`);
  return { input: `title: ${theme} | text: ${lines.join("\n")}`, modelChars: theme.length + texts.join("").length + happened.length + did.length + tried.length };
}

// -------------------------------------------------------------------- runs

async function runA() {
  const key = randomBytes(24).toString("hex");
  const publish = inContainer ? await freePort() : null;
  const s = launch({ name: "a", host: inContainer ? "0.0.0.0" : "127.0.0.1", port: inContainer ? 8080 : 0, publish, apiKey: key });
  const listen = await s.waitFor(LISTEN_RE, LOAD_TIMEOUT_MS);
  const loaded = s.lines.find((l) => /^main: model loaded\s*$/.test(l.line));
  const m = LISTEN_RE.exec(listen.line);
  results.metrics.listeningLine = listen.line;
  results.metrics.msToListeningLine = Math.round(listen.t);
  check(loaded && loaded.t <= listen.t, `run A: "main: model loaded" precedes "${listen.line}"`);
  const loggedPort = Number(m[2]);
  if (!inContainer) check(loggedPort > 0, `run A: --port 0 bound and logged port ${loggedPort}`);
  const base = `http://127.0.0.1:${inContainer ? publish : loggedPort}`;

  const backendLine = s.lines.find((l) => l.line.startsWith("load_backend: loaded CPU backend from"))?.line ?? "";
  const sysInfo = s.lines.find((l) => l.line.startsWith("system_info:"))?.line ?? "";
  results.metrics.backendLine = backendLine;
  results.metrics.systemInfo = sysInfo;
  const backendDir = inContainer ? containerTree : relocated;
  const backendPrefix = win ? path.join(backendDir, "ggml-cpu") : `${backendDir}/libggml-cpu`;
  check(backendLine.includes(backendPrefix), `CPU backend loaded from the relocated tree: ${backendLine.replace(/^.*from /, "")}`);

  // Public endpoints and auth.
  const health = await http(base, "GET", "/health");
  check(health.status === 200, `GET /health without key -> ${health.status}`);
  const models = await http(base, "GET", "/v1/models");
  check(models.status === 200 && models.json?.data?.[0]?.id === ALIAS, `GET /v1/models without key -> ${models.status}, id ${models.json?.data?.[0]?.id}`);
  const noKey = await embed(base, null, "vex");
  check(noKey.status === 401, `POST /v1/embeddings without key -> ${noKey.status} ${noKey.text}`);
  const badKey = await embed(base, "not-the-key", "vex");
  check(badKey.status === 401, `POST /v1/embeddings with a wrong key -> ${badKey.status}`);

  // The embeddings contract.
  const probe = await embed(base, key, "vex");
  check(probe.status === 200, `POST /v1/embeddings with key -> ${probe.status}`);
  check(probe.json.model === ALIAS, `response.model is "${probe.json.model}"`);
  const v = vectorOf(probe);
  check(v.length === DIM, `embedding length ${v.length}`);
  check(v.every(Number.isFinite), "every embedding value is finite");
  const norm = Math.hypot(...v);
  results.metrics.l2Norm = norm;
  check(Math.abs(norm - 1) < 1e-3, `L2 norm ${norm.toFixed(6)} (normalised)`);
  results.metrics.probeFirst8 = v.slice(0, 8);
  vectors.probe = v;

  // Warm up, then RSS.
  for (let i = 0; i < 3; i++) await embed(base, key, queryInput(`warm${i}`));
  results.metrics.memoryAfterWarmup = s.memory();

  // Latency: short query.
  const q = [];
  for (let i = 0; i < 20; i++) {
    const r = await embed(base, key, queryInput(i));
    if (r.status !== 200 || vectorOf(r).length !== DIM) fail(`query ${i} -> ${r.status}`);
    q.push(r.ms);
  }
  results.metrics.queryMs = { p50: +median(q).toFixed(1), p90: +pct(q, 90).toFixed(1), max: +Math.max(...q).toFixed(1), n: q.length };
  check(true, `short query latency p50 ${median(q).toFixed(1)} ms over ${q.length} calls`);

  // The app's maximum document.
  const d = [];
  let docTokens = null;
  for (let i = 0; i < 5; i++) {
    const input = docInput(i);
    if (input.length !== DOC_MAX_CHARS) fail(`doc input is ${input.length} chars`);
    const r = await embed(base, key, input);
    check(r.status === 200 && vectorOf(r).length === DIM && vectorOf(r).every(Number.isFinite), `${DOC_MAX_CHARS}-char document #${i} embedded (${r.json?.usage?.prompt_tokens} tokens)`);
    docTokens = r.json?.usage?.prompt_tokens ?? null;
    d.push(r.ms);
    if (i === 0) vectors.doc0 = vectorOf(r);
  }
  results.metrics.docMs = { p50: +median(d).toFixed(1), max: +Math.max(...d).toFixed(1), n: d.length, promptTokens: docTokens };

  // The tokenizer and batch limit are the same C++ as the Docker image, so
  // this reports the app's budget rather than gating the runtime.
  const sm = sessionMemoryInput();
  if (sm.input.length > DOC_MAX_CHARS) fail(`session-memory input is ${sm.input.length} chars, over the budget`);
  const dense = await embed(base, key, sm.input);
  results.metrics.sessionMemoryDoc = {
    chars: sm.input.length, modelChars: sm.modelChars, status: dense.status,
    promptTokens: dense.json?.usage?.prompt_tokens ?? null, error: dense.status === 200 ? null : dense.text.slice(0, 300),
  };
  note(`worst-case session-memory document (${sm.input.length} chars, ${sm.modelChars} model chars, 5 UUID items) -> HTTP ${dense.status}` +
    (dense.status === 200 ? ` (${dense.json?.usage?.prompt_tokens} tokens)` : `: ${dense.text.slice(0, 200)}`));

  // Far over the budget: report the error shape, and the server must survive it.
  const big = await embed(base, key, docInput("big", 8000));
  results.metrics.oversized = { chars: 8000, status: big.status, body: big.text.slice(0, 400) };
  if (big.status === 200) note(`8000-char input returned 200 (${big.json?.usage?.prompt_tokens} tokens): the 512-token ceiling did not apply`);
  else note(`8000-char input -> HTTP ${big.status}: ${big.text.slice(0, 300)}`);
  const after = await embed(base, key, "vex");
  check(after.status === 200 && vectorOf(after).length === DIM, "server still serves embeddings after the oversized request");

  // Find the largest prose input that still fits, to place the budget.
  let lo = DOC_MAX_CHARS, hi = 8000;
  while (hi - lo > 50) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await embed(base, key, docInput("edge", mid));
    if (r.status === 200) lo = mid; else hi = mid;
  }
  results.metrics.largestProseCharsAccepted = `~${lo} (rejected at ${hi})`;
  note(`largest accepted prose input ~${lo} chars (rejected at ${hi})`);

  results.metrics.memoryAfterAll = s.memory();

  const stop = await s.stop();
  results.metrics.sigterm = stop;
  check(stop.ms < STOP_TIMEOUT_MS, `SIGTERM: exited in ${stop.ms} ms (code ${stop.code}, signal ${stop.signal})`);
  await sleep(300);
  check(noOrphans(), "no llama-server process left behind");
}

async function runB() {
  const key = randomBytes(24).toString("hex");
  if (!inContainer) {
    // Native: a known port so /health can be polled from the instant of spawn.
    const port = await freePort();
    const s = launch({ name: "b", host: "127.0.0.1", port, apiKey: key });
    const base = `http://127.0.0.1:${port}`;
    const seen = [];
    let first200 = null;
    while (performance.now() - s.t0 < LOAD_TIMEOUT_MS) {
      if (s.exited) fail(`run B: server exited during load\n${tail(s.lines)}`);
      let st = "conn-refused";
      try {
        const r = await http(base, "GET", "/health", { timeoutMs: 2000 });
        st = r.status;
        if (st === 503 && !seen.includes(503)) results.metrics.health503Body = r.text;
      } catch {}
      if (seen[seen.length - 1] !== st) seen.push(st);
      if (st === 200) { first200 = performance.now() - s.t0; break; }
      await sleep(5);
    }
    results.metrics.healthSequence = seen;
    results.metrics.msToHealth200 = first200 && Math.round(first200);
    check(seen.includes(503) && seen.indexOf(503) < seen.indexOf(200), `run B: /health went ${seen.join(" -> ")} (200 after ${Math.round(first200)} ms)`);
    const stop = await s.stop();
    check(stop.ms < STOP_TIMEOUT_MS, `run B: SIGTERM exit in ${stop.ms} ms`);
  } else {
    // Container: the production --host 127.0.0.1 --port 0, probed from inside
    // the container through bash's /dev/tcp (the image has no curl).
    const s = launch({ name: "b", host: "127.0.0.1", port: 0, apiKey: key });
    // Poll the 503 phase over the container's own loopback as soon as the
    // port is visible in /proc/net/tcp (the server binds before it loads).
    const seen = [];
    let port = null;
    while (performance.now() - s.t0 < LOAD_TIMEOUT_MS && port === null) {
      if (s.exited) fail(`run B: server exited during load\n${tail(s.lines)}`);
      try {
        // Fails until the container exists; that is expected while polling.
        const tcp = execFileSync("docker", ["exec", s.containerName, "cat", "/proc/net/tcp"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
        const row = tcp.split("\n").find((l) => / 0100007F:([0-9A-F]{4}) 00000000:0000 0A /.test(l));
        if (row) port = parseInt(/ 0100007F:([0-9A-F]{4}) /.exec(row)[1], 16);
      } catch {}
      if (port === null) await sleep(100);
    }
    if (port === null) fail("run B: never saw a listening socket");
    const probe = () => {
      const out = execFileSync("docker", ["exec", s.containerName, "bash", "-c",
        `exec 3<>/dev/tcp/127.0.0.1/${port} && printf 'GET /health HTTP/1.0\\r\\nHost: x\\r\\n\\r\\n' >&3 && head -c 400 <&3`]).toString();
      return { status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(out)?.[1]), out };
    };
    while (performance.now() - s.t0 < LOAD_TIMEOUT_MS) {
      const r = probe();
      if (seen[seen.length - 1] !== r.status) seen.push(r.status);
      if (r.status === 503 && !results.metrics.health503Body) results.metrics.health503Body = r.out.split("\r\n\r\n")[1];
      if (r.status === 200) break;
      await sleep(50);
    }
    const listen = await s.waitFor(LISTEN_RE, LOAD_TIMEOUT_MS);
    results.metrics.listeningLine = listen.line;
    const logged = Number(LISTEN_RE.exec(listen.line)[2]);
    check(logged === port, `run B: --port 0 logged "${listen.line}", matches the socket bound (${port})`);
    results.metrics.healthSequence = seen;
    check(seen.includes(503) && seen.indexOf(503) < seen.indexOf(200), `run B: /health went ${seen.join(" -> ")}`);
    const stop = await s.stop();
    check(stop.ms < STOP_TIMEOUT_MS, `run B: SIGTERM exit in ${stop.ms} ms (code ${stop.code})`);
  }
}

// --------------------------------------------------------------------- main

let code = 0;
try {
  if (process.platform === "darwin") {
    results.metrics.rosetta = target === "darwin-x64" && os.arch() === "arm64";
    if (results.metrics.rosetta) note("darwin-x64 is running under Rosetta 2 on Apple Silicon");
  }
  if (inContainer) note("linux-x64 runs in a linux/amd64 container on this host: timings are emulated and not representative");
  if (win) {
    const want = target === "win32-arm64" ? "arm64" : "x64";
    const machines = [...new Set(fs.readdirSync(relocated).filter((f) => /\.(exe|dll)$/i.test(f)).map((f) => peInfo(path.join(relocated, f))?.machine))];
    check(machines.length === 1 && machines[0] === want, `every PE in the tree is ${want} (${machines.join(", ")})`);
    check(os.arch() === want, `running natively: host is ${os.arch()} (${os.cpus()[0]?.model})`);
    results.metrics.host = { arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.availableParallelism() };
  }
  const ta = performance.now();
  await runA();
  await runB();
  if (!inContainer) check(!fs.existsSync(cacheDir), "nothing was written to LLAMA_CACHE");
  results.metrics.smokeSeconds = Math.round((performance.now() - ta) / 1000);
} catch (e) {
  if (!failed) console.error(`FAIL ${e.stack || e}`);
  code = 1;
} finally {
  for (const c of cleanups.reverse()) { try { c(); } catch {} }
}
// Optional: the raw vectors for "vex" and the first 1440-char document, so
// targets (or a Docker reference) can be compared offline.
if (process.env.NR_SMOKE_VECTORS_OUT && vectors.probe) {
  fs.writeFileSync(process.env.NR_SMOKE_VECTORS_OUT, JSON.stringify({ target, backend: results.metrics.backendLine, inputs: { probe: "vex", doc0: docInput(0) }, ...vectors }));
}
console.log(JSON.stringify(results.metrics, null, 2));
console.log(code === 0 ? `PASS ${target}: ${results.checks.length} checks` : `FAILED ${target}`);
process.exit(code);
