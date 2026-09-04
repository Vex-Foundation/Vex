#!/usr/bin/env node
/**
 * HOW LONG DOES ONE COLD `pg.Client` CONNECT TAKE ON THIS MACHINE?
 *
 * Every one of vex-app's main-process database modules opens a FRESH
 * `pg.Client` per call and closes it again (`src/main/database/sessions/
 * connection.ts` -> `withClient`), with `connectionTimeoutMillis` at 2000 ms.
 * On Linux against a loopback Postgres that is a sub-millisecond TCP connect
 * plus a SCRAM handshake and nobody notices. On Windows the same connect
 * traverses Docker Desktop's WSL2 port proxy, and the leading hypothesis for
 * the Studio black screen is that this per-call cost is large enough that a
 * burst of them stalls the main process (or trips the 2000 ms ceiling) while
 * the window is still waiting for its first payload.
 *
 * THIS SCRIPT IS THE INSTRUMENT, NOT THE FIX. The shared bounded pool is
 * implemented only if these numbers say the mechanism is real. So the script
 * measures exactly what `withClient` pays and nothing else:
 *
 *     connectMs   `new Client(...)` -> `connect()` resolved (TCP + startup +
 *                 SCRAM auth). This is the number the hypothesis is about.
 *     queryMs     a single `SELECT 1`, so a connect number can be read against
 *                 the round trip it was supposed to be amortising.
 *     endMs       `client.end()`, because withClient pays that per call too.
 *
 * Attempts run SEQUENTIALLY with a gap between them (rule 10 politeness): the
 * default target is the developer's own live database, and a probe must not
 * become the load it is measuring. Traffic is READ-ONLY: connect, `SELECT 1`,
 * one `SHOW server_version`, disconnect. Nothing is written.
 *
 * PROOF OF TARGET. The script refuses to report against a port it cannot prove
 * is a Vex Postgres. The proof is the handshake itself: SCRAM authentication as
 * role `vex` into database `vex` with the password from this install's secret
 * file. Nothing else on the machine can satisfy that, and a wrong port fails
 * the FIRST attempt, before any measurement is recorded.
 *
 * THE PASSWORD IS NEVER PRINTED and never enters the JSON artifact; only the
 * path it was read from is reported.
 *
 * ## The two mirrors, and why they are mirrors
 *
 * This script deliberately does NOT import main-process TypeScript. It has to
 * run from a bare `node` on the owner's Windows machine, against an installed
 * Vex, without a build step, a tsx loader or an Electron context, so importing
 * `src/main/...` would make the instrument depend on the thing it is measuring
 * being buildable. Two values are therefore restated here:
 *
 *   1. the CONFIG_DIR resolution rules of `src/main/paths/config-dir.ts`
 *      (VEX_CONFIG_DIR / XDG_CONFIG_HOME / APPDATA, absolute-only), the
 *      password file location, and the `vex` / `vex` / 127.0.0.1 triple from
 *      `src/main/database/db-config.ts`;
 *   2. {@link PRODUCT_CONNECT_TIMEOUT_MS}, the private `CONNECT_TIMEOUT_MS` of
 *      `sessions/connection.ts`, which exports nothing.
 *
 * A silent mirror is a lie waiting to happen, so BOTH are pinned by a drift
 * test that reads the real modules and fails when they disagree
 * (`src/main/studio/__tests__/pg-connect-latency-probe.test.ts`). The mirror is
 * allowed to exist; it is not allowed to drift unnoticed.
 *
 * ## Usage
 *
 *     node scripts/probes/pg-connect-latency.mjs
 *     node scripts/probes/pg-connect-latency.mjs --runs 30 --gap-ms 100
 *     node scripts/probes/pg-connect-latency.mjs --port 55123 --label isolated
 *     node scripts/probes/pg-connect-latency.mjs --json artifacts/run.json
 *
 * See `scripts/probes/README.md` for the owner-facing runbook.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Mirrors `src/shared/local-service-ports.ts`. Pinned by the drift test. */
export const DEFAULT_PG_PORT = 27432;

/** Mirrors `src/main/database/db-config.ts`. Pinned by the drift test. */
export const PG_HOST = "127.0.0.1";
export const PG_DATABASE = "vex";
export const PG_USER = "vex";

/**
 * The private `CONNECT_TIMEOUT_MS` of `src/main/database/sessions/
 * connection.ts`, restated because that module exports nothing and this script
 * must not import it (see the header). The verdict thresholds are expressed
 * against this value, so a drift here would silently move the finish line; the
 * drift test reads the real constant out of that source and fails on a
 * mismatch.
 */
export const PRODUCT_CONNECT_TIMEOUT_MS = 2_000;

/**
 * A connect slower than this is already user-visible: it is half the product
 * ceiling, and `withClient` pays it on EVERY call, so a screen assembling from
 * a handful of queries pays it a handful of times before it can paint.
 */
export const SLOW_CONNECT_MS = 1_000;

/** Bounds on the sample count. Enough to see a tail; never enough to be load. */
export const MIN_RUNS = 1;
export const MAX_RUNS = 500;

const DEFAULT_RUNS = 20;
const DEFAULT_GAP_MS = 50;

/** Relative location of the Postgres password inside a config dir. */
export const PG_PASSWORD_RELATIVE_PATH = path.join(
  "local-infra",
  "secrets",
  "pg_password",
);

/** Relative location of the rendered compose file inside a config dir. */
export const COMPOSE_RELATIVE_PATH = path.join("compose", "docker-compose.yml");

// ── Config resolution (mirror of main; see header) ────────────────────────

/**
 * A directory environment variable is USABLE only when it is non-empty AND
 * absolute, exactly as `main/paths/config-dir.ts` decides it: a relative value
 * would put this probe's idea of the install in whatever directory the owner
 * happened to run it from, which is how a probe reports on the wrong machine
 * state and nobody notices.
 */
function usableDirEnv(value, target) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!target.isAbsolute(value)) return null;
  return value;
}

/** Mirror of `resolveConfigDir`. Pure, and platform is an input, not ambient. */
export function resolveConfigDir({ platform, homedir, env }) {
  const target = platform === "win32" ? path.win32 : path.posix;

  const override = usableDirEnv(env["VEX_CONFIG_DIR"], target);
  if (override !== null) return override;

  if (platform === "win32") {
    const appData =
      usableDirEnv(env["APPDATA"], target)
      ?? target.join(homedir, "AppData", "Roaming");
    return target.join(appData, "vex");
  }

  if (platform === "darwin") {
    return target.join(homedir, "Library", "Application Support", "vex");
  }

  const xdgConfig =
    usableDirEnv(env["XDG_CONFIG_HOME"], target) ?? target.join(homedir, ".config");
  return target.join(xdgConfig, "vex");
}

/** Where the password file lives inside a config dir. */
export function pgPasswordPathFor(configDir) {
  return path.join(configDir, PG_PASSWORD_RELATIVE_PATH);
}

/** Where the rendered compose file lives inside a config dir. */
export function composePathFor(configDir) {
  return path.join(configDir, COMPOSE_RELATIVE_PATH);
}

/**
 * The host port the rendered compose publishes Postgres on, or `null`.
 *
 * `main/compose/render.ts` emits ONE shape (the long form, with an explicit
 * `target: 5432` and a quoted `published`), so that is what this recognises;
 * the classic short form is recognised too because a hand-edited compose is a
 * realistic thing to find on a developer machine. Anything else returns `null`
 * and the caller falls back to the default port, which is honest: an
 * unrecognised file must not silently produce a confident wrong number, and
 * `--port` always wins over both.
 *
 * This is a targeted scan rather than a YAML parse on purpose - the probe must
 * run from a bare `node` with no dependency beyond `pg`.
 */
export function parsePublishedPgPort(composeYaml) {
  const long = /-\s*target:\s*5432\b[\s\S]{0,200}?published:\s*"?(\d{1,5})"?/.exec(
    composeYaml,
  );
  if (long !== null) return Number(long[1]);

  const short = /-\s*"?(?:127\.0\.0\.1:|localhost:)?(\d{1,5}):5432"?\s*$/m.exec(
    composeYaml,
  );
  if (short !== null) return Number(short[1]);

  return null;
}

/**
 * Everything needed to open one connection, plus WHERE each value came from.
 *
 * The provenance is not decoration: a latency number is only interpretable
 * against a known target, and "which port did this actually measure" is the
 * first question the owner's artifact has to answer without a second run.
 *
 * @throws when the password file is absent or empty - that is an install that
 *   has never composed, and there is nothing to measure.
 */
export function resolvePgTarget({
  platform = process.platform,
  homedir = os.homedir(),
  env = process.env,
  portOverride = null,
  readFile = (file) => readFileSync(file, "utf8"),
  fileExists = (file) => existsSync(file),
} = {}) {
  const configDir = resolveConfigDir({ platform, homedir, env });
  const passwordPath = pgPasswordPathFor(configDir);
  const composePath = composePathFor(configDir);

  let port;
  let portSource;
  if (portOverride !== null) {
    port = portOverride;
    portSource = "--port";
  } else {
    const fromCompose = fileExists(composePath)
      ? parsePublishedPgPort(readFile(composePath))
      : null;
    if (fromCompose !== null) {
      port = fromCompose;
      portSource = "compose";
    } else {
      port = DEFAULT_PG_PORT;
      portSource = "default";
    }
  }

  if (!fileExists(passwordPath)) {
    throw new Error(
      `no Postgres password at ${passwordPath}. This install has never rendered a `
        + "compose stack, so there is no database to measure. Start Vex once (or pass "
        + "--config-dir / VEX_CONFIG_DIR pointing at the install you meant).",
    );
  }
  const password = readFile(passwordPath).trim();
  if (password.length === 0) {
    throw new Error(
      `the Postgres password file ${passwordPath} is empty; refusing to attempt an `
        + "authentication that cannot succeed.",
    );
  }

  return {
    configDir,
    composePath,
    passwordPath,
    host: PG_HOST,
    port,
    portSource,
    database: PG_DATABASE,
    user: PG_USER,
    password,
  };
}

// ── Statistics ────────────────────────────────────────────────────────────

/**
 * Nearest-rank percentile on a sorted copy: `p95` is the smallest sample at or
 * above which 95% of the samples fall, i.e. `sorted[ceil(p * n) - 1]`.
 *
 * Nearest-rank rather than an interpolating variant because every reported
 * value is then a MEASUREMENT that actually happened, which is what a latency
 * artifact has to be able to claim. With the default 20 runs an interpolated
 * p95 would be a number no connect ever took.
 */
export function percentile(samples, p) {
  if (samples.length === 0) return null;
  if (!(p > 0 && p <= 1)) {
    throw new Error(`percentile expects 0 < p <= 1, received ${String(p)}`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[rank - 1];
}

/** min / p50 / p95 / max / mean over one series, or nulls when empty. */
export function summarize(samples) {
  if (samples.length === 0) {
    return { count: 0, min: null, p50: null, p95: null, max: null, mean: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: total / sorted.length,
  };
}

/**
 * Does this machine's connect cost support the pooling hypothesis?
 *
 * The classification is deliberately coarse and named, because the decision it
 * feeds is binary (build the shared pool, or do not) and a borderline number
 * must read as borderline rather than as a verdict:
 *
 *   `confirmed`   at least one connect at or over the product ceiling, i.e.
 *                 `withClient` would have FAILED there. No further argument is
 *                 needed: the mechanism is not hypothetical on this machine.
 *   `implicated`  no timeout, but at least one connect at or over
 *                 SLOW_CONNECT_MS. Per-call connects are a user-visible cost.
 *   `not-implicated`  every connect is under SLOW_CONNECT_MS. Connect latency
 *                 does not explain a black screen HERE; it says nothing about
 *                 another machine, which is the whole reason this runs on the
 *                 owner's Windows box too.
 */
export function verdict(
  connectSamples,
  { connectTimeoutMs = PRODUCT_CONNECT_TIMEOUT_MS, slowMs = SLOW_CONNECT_MS } = {},
) {
  const overSlow = connectSamples.filter((value) => value >= slowMs).length;
  const overTimeout = connectSamples.filter((value) => value >= connectTimeoutMs).length;
  const classification =
    overTimeout > 0 ? "confirmed" : overSlow > 0 ? "implicated" : "not-implicated";
  return {
    classification,
    slowMs,
    connectTimeoutMs,
    samplesAtOrOverSlow: overSlow,
    samplesAtOrOverTimeout: overTimeout,
    total: connectSamples.length,
  };
}

// ── Argument parsing ──────────────────────────────────────────────────────

function integerFlag(raw, flag, { min, max }) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${flag} expects an integer in [${min}, ${max}], received ${String(raw)}`);
  }
  return value;
}

/**
 * Parse argv. Unknown flags are REFUSED rather than ignored: a mistyped
 * `--runs` that silently measured 20 attempts instead of 200 would produce an
 * artifact that lies about its own sample size.
 */
export function parseArgs(argv) {
  const options = {
    runs: DEFAULT_RUNS,
    gapMs: DEFAULT_GAP_MS,
    port: null,
    label: null,
    json: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} expects a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case "--runs":
        options.runs = integerFlag(next(), "--runs", { min: MIN_RUNS, max: MAX_RUNS });
        break;
      case "--gap-ms":
        options.gapMs = integerFlag(next(), "--gap-ms", { min: 0, max: 60_000 });
        break;
      case "--port":
        options.port = integerFlag(next(), "--port", { min: 1, max: 65_535 });
        break;
      case "--label":
        options.label = next();
        break;
      case "--json":
        options.json = next();
        break;
      default:
        throw new Error(
          `unknown flag ${flag}. Supported: --runs --gap-ms --port --label --json`,
        );
    }
  }
  return options;
}

// ── Reporting ─────────────────────────────────────────────────────────────

function ms(value) {
  return value === null ? "-" : `${value.toFixed(1)}`;
}

/** The human table. Returned as a string so the tests can read it. */
export function renderReport({ target, samples, summaries, decision, environment }) {
  const lines = [];
  lines.push("pg connect latency probe");
  lines.push(`  target        ${target.host}:${target.port} (${target.portSource}) db=${target.database} user=${target.user}`);
  lines.push(`  password from ${target.passwordPath}`);
  lines.push(`  server        PostgreSQL ${environment.serverVersion}`);
  lines.push(`  host          ${environment.osType} ${environment.osRelease} ${environment.arch}, node ${environment.nodeVersion}`);
  lines.push(`  docker        ${environment.dockerVersion}`);
  lines.push(`  when          ${environment.timestamp}`);
  if (target.label !== null) lines.push(`  label         ${target.label}`);
  lines.push("");
  lines.push("  #     connect(ms)   query(ms)   end(ms)");
  for (const sample of samples) {
    lines.push(
      `  ${String(sample.attempt).padStart(3)}   ${ms(sample.connectMs).padStart(11)}`
        + `   ${ms(sample.queryMs).padStart(9)}   ${ms(sample.endMs).padStart(7)}`,
    );
  }
  lines.push("");
  for (const [name, summary] of Object.entries(summaries)) {
    lines.push(
      `  ${name.padEnd(8)} n=${summary.count} min=${ms(summary.min)} p50=${ms(summary.p50)}`
        + ` p95=${ms(summary.p95)} max=${ms(summary.max)} mean=${ms(summary.mean)}`,
    );
  }
  lines.push("");
  lines.push(
    `  VERDICT ${decision.classification}: ${decision.samplesAtOrOverSlow}/${decision.total} `
      + `connects >= ${decision.slowMs}ms, ${decision.samplesAtOrOverTimeout}/${decision.total} `
      + `>= the product ceiling of ${decision.connectTimeoutMs}ms `
      + "(CONNECT_TIMEOUT_MS in src/main/database/sessions/connection.ts).",
  );
  return lines.join("\n");
}

function dockerVersion() {
  const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) return "unavailable";
  return result.stdout.trim() || "unavailable";
}

const sleep = (milliseconds) =>
  milliseconds === 0
    ? Promise.resolve()
    : new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      });

// ── Measurement ───────────────────────────────────────────────────────────

/**
 * One cold round trip: a fresh client, connect, `SELECT 1`, end. Exactly what
 * `withClient` does, minus the product's own work.
 *
 * `Client` is injected so the pure report path can be exercised without a
 * database; production callers pass the real `pg.Client`.
 */
export async function measureOnce(Client, target, { attempt, collectServerVersion = false }) {
  const client = new Client({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    connectionTimeoutMillis: PRODUCT_CONNECT_TIMEOUT_MS,
  });

  const connectStart = performance.now();
  await client.connect();
  const connectMs = performance.now() - connectStart;

  let serverVersion = null;
  let queryMs = null;
  let endMs = null;
  try {
    const queryStart = performance.now();
    await client.query("SELECT 1");
    queryMs = performance.now() - queryStart;
    if (collectServerVersion) {
      const shown = await client.query("SHOW server_version");
      serverVersion = String(shown.rows[0]["server_version"]);
    }
  } finally {
    const endStart = performance.now();
    try {
      await client.end();
    } catch {
      // A failed close still costs wall time and must not lose the connect
      // measurement that is the point of the attempt.
    }
    endMs = performance.now() - endStart;
  }

  return { attempt, connectMs, queryMs, endMs, serverVersion };
}

/**
 * Run the probe.
 *
 * The FIRST attempt is the proof of target: if it cannot authenticate as `vex`
 * into `vex`, the run aborts with a named refusal and no artifact is written,
 * because a latency table for an unidentified port is worse than no table.
 */
export async function run(argv, { Client, log = console.log, error = console.error } = {}) {
  const options = parseArgs(argv);
  const target = { ...resolvePgTarget({ portOverride: options.port }), label: options.label };

  let first;
  try {
    first = await measureOnce(Client, target, { attempt: 1, collectServerVersion: true });
  } catch (cause) {
    error(
      `refusing to report: could not authenticate as role '${PG_USER}' into database `
        + `'${PG_DATABASE}' at ${target.host}:${target.port} (port from ${target.portSource}). `
        + "That handshake is the only proof this port is a Vex Postgres, so no measurement "
        + `is recorded. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return 1;
  }

  const samples = [first];
  for (let attempt = 2; attempt <= options.runs; attempt += 1) {
    await sleep(options.gapMs);
    samples.push(await measureOnce(Client, target, { attempt }));
  }

  const connectSamples = samples.map((sample) => sample.connectMs);
  const summaries = {
    connect: summarize(connectSamples),
    query: summarize(samples.map((sample) => sample.queryMs).filter((value) => value !== null)),
    end: summarize(samples.map((sample) => sample.endMs)),
  };
  const decision = verdict(connectSamples);

  const environment = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    osType: os.type(),
    osRelease: os.release(),
    arch: process.arch,
    nodeVersion: process.version,
    dockerVersion: dockerVersion(),
    serverVersion: first.serverVersion ?? "unknown",
  };

  log(renderReport({ target, samples, summaries, decision, environment }));

  if (options.json !== null) {
    // The password is resolved into `target`; the artifact carries only the
    // PATH it came from. This projection is explicit rather than a spread with
    // a delete, so a future field cannot leak by being forgotten.
    const artifact = {
      probe: "pg-connect-latency",
      artifactVersion: 1,
      label: options.label,
      runs: options.runs,
      gapMs: options.gapMs,
      target: {
        host: target.host,
        port: target.port,
        portSource: target.portSource,
        database: target.database,
        user: target.user,
        configDir: target.configDir,
        passwordPath: target.passwordPath,
      },
      productConnectTimeoutMs: PRODUCT_CONNECT_TIMEOUT_MS,
      environment,
      samples,
      summaries,
      verdict: decision,
    };
    const file = path.resolve(options.json);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    log(`\n  artifact written to ${file}`);
  }

  return 0;
}

/**
 * `fileURLToPath`, not `new URL(...).pathname`: on Windows the latter yields
 * `/C:/...`, which never equals the `C:\...` in `process.argv[1]`, and the
 * probe would import cleanly and then do nothing on exactly the platform it
 * was written for.
 */
const invokedDirectly =
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { Client } = await import("pg");
  try {
    process.exitCode = await run(process.argv.slice(2), { Client });
  } catch (cause) {
    console.error(`pg-connect-latency: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  }
}
