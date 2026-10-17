/**
 * The native runtime, end to end, against the BUILT app: a first run with
 * `VEX_RUNTIME=native` gets from System Check through migrations on the
 * bundled Postgres to the setup wizard, without any container, quitting the
 * app stops the bundled servers cleanly, and a relaunch on the same profile
 * comes back up on the same cluster without downloading the model again.
 * While it runs, the OS must show the postmaster and llama-server as the
 * app's own binaries; after each quit, nothing the app ships may still run.
 *
 * Two modes:
 *
 *   - Development (default): the built `dist/` bundle with the trees
 *     `native-runtime/<component>/build.sh` produced, and the gates' verified
 *     model hard-linked into the fresh config dir so the run does not
 *     download 333 MB (the download is covered by the model store's tests).
 *     Skipped, visibly, when any of them is missing.
 *   - Installed app (`VEX_E2E_APP_EXECUTABLE=<path to the packaged app's
 *     executable>`): the clean-machine release gate. The app uses only the
 *     binaries it ships and downloads the model like a user's first run.
 *
 * DRIVING AN INSTALLED APP. Playwright's `_electron.launch` reaches the main
 * process through Node's inspector, and a packaged Vex has
 * `EnableNodeCliInspectArguments` fused OFF (build/afterPack.mjs), so it would
 * wait forever for an inspector that never opens. Chromium's DevTools endpoint
 * is not behind a fuse: the installed app is started as a plain process with
 * `--remote-debugging-port=0` and its renderer driven over CDP, so the gate
 * runs the shipped binary exactly as shipped. It quits the way a user does:
 * on macOS the app is told to quit (SIGTERM, which Electron answers with
 * `app.quit()`, the path Cmd+Q takes); on Windows and Linux its window is
 * closed.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron, chromium, expect, test, type Page, type TestInfo } from "@playwright/test";
import { APP_DIR, isShellUrl, MAIN_BUNDLE, selectShellWindow } from "./fixtures/electron-app.js";

const REPO = path.resolve(APP_DIR, "..");
const TARGET = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const PG_DIR = path.join(REPO, "native-runtime/out", TARGET, "postgres");
const LLAMA_DIR = path.join(REPO, "native-runtime/out", TARGET, "llama");
const MODEL_FILE = "embeddinggemma-300M-Q8_0.gguf";
const MODEL = path.join(REPO, "native-runtime/.work/models", MODEL_FILE);
const INSTALLED_APP = process.env["VEX_E2E_APP_EXECUTABLE"];

/** How long a quit may take before the app counts as wedged on the way out. */
const QUIT_DEADLINE_MS = 60_000;

/**
 * Where the servers the app runs must come from: the packaged app's resources
 * (`postgres/`, `llama/`), or in development the trees the build produced.
 */
const BUNDLE_DIR =
  INSTALLED_APP === undefined
    ? path.join(REPO, "native-runtime/out", TARGET)
    : process.platform === "darwin"
      ? path.resolve(INSTALLED_APP, "..", "..", "Resources")
      : path.join(path.dirname(INSTALLED_APP), "resources");

interface OsProcess {
  readonly pid: number;
  readonly executable: string;
}

/** Every running process whose executable lives under `dir`, as the OS reports it. */
function processesUnder(dir: string): OsProcess[] {
  let all: OsProcess[];
  if (process.platform === "win32") {
    const listing = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object ExecutablePath | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)\" }",
      ],
      { encoding: "utf8" },
    ).stdout;
    all = listing.split(/\r?\n/).flatMap((line) => {
      const [pid, executable] = line.split("\t");
      return pid !== undefined && executable !== undefined ? [{ pid: Number(pid), executable }] : [];
    });
  } else if (process.platform === "linux") {
    all = readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .flatMap((pid) => {
        try {
          return [{ pid: Number(pid), executable: readlinkSync(`/proc/${pid}/exe`) }];
        } catch {
          return []; // gone, or not ours to read
        }
      });
  } else {
    // macOS `comm` is the executable's path (Postgres retitles its argv, not this).
    all = spawnSync("ps", ["-A", "-o", "pid=,comm="], { encoding: "utf8" })
      .stdout.split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        return match?.[1] !== undefined && match[2] !== undefined ? [{ pid: Number(match[1]), executable: match[2] }] : [];
      });
  }
  const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
  const root = fold(path.resolve(dir) + path.sep);
  return all.filter((entry) => fold(path.resolve(entry.executable)).startsWith(root));
}

const programName = (executable: string): string => path.basename(executable).replace(/\.exe$/i, "");

/**
 * The servers running are the app's own: postmaster.pid says the postmaster
 * is up and ready, and that PID is the bundled `postgres`; a bundled
 * `llama-server` is running too. Nothing on the machine's PATH could pass.
 */
function expectBundledRuntimeUp(runtimeDir: string): void {
  const pidFile = readFileSync(path.join(runtimeDir, "pg18", "postmaster.pid"), "utf8").split(/\r?\n/);
  expect(pidFile[7]?.trim(), "postmaster.pid line 8 (status)").toBe("ready");
  const running = processesUnder(BUNDLE_DIR);
  const postmaster = running.find((entry) => entry.pid === Number(pidFile[0]));
  expect(postmaster && programName(postmaster.executable), `postmaster ${String(pidFile[0])} is the bundled postgres`).toBe(
    "postgres",
  );
  expect(
    running.some((entry) => programName(entry.executable) === "llama-server"),
    `a bundled llama-server is running (bundled processes: ${JSON.stringify(running)})`,
  ).toBe(true);
}

/** After a quit, nothing the app ships is still running (bounded grace for the OS to reap). */
async function expectNoBundledProcess(): Promise<void> {
  const deadline = Date.now() + 15_000;
  let left = processesUnder(BUNDLE_DIR);
  while (left.length > 0 && Date.now() < deadline) {
    await delay(500);
    left = processesUnder(BUNDLE_DIR);
  }
  expect(left, "bundled processes still running after the app quit").toEqual([]);
}

test.skip(
  INSTALLED_APP === undefined && (!existsSync(PG_DIR) || !existsSync(LLAMA_DIR) || !existsSync(MODEL)),
  `needs ${PG_DIR}, ${LLAMA_DIR} and ${MODEL} (native-runtime build + llama/fetch-model.sh), or VEX_E2E_APP_EXECUTABLE`,
);

/** A launched app, whichever way it was launched. */
interface RunningApp {
  readonly window: Page;
  /** Quit the way a user does; resolves once the process has exited. */
  quit(): Promise<void>;
  /** Last resort when a test fails with the app still up. */
  kill(): void;
  /** What the process printed (installed mode only). */
  output(): string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchDevelopment(env: NodeJS.ProcessEnv): Promise<RunningApp> {
  const app = await _electron.launch({
    args: [MAIN_BUNDLE],
    env: { ...env, VEX_E2E_LOAD_BUILT: "1", VEX_NATIVE_PG_DIR: PG_DIR, VEX_NATIVE_LLAMA_DIR: LLAMA_DIR },
  });
  try {
    const window = await selectShellWindow(app);
    return {
      window,
      quit: () => app.close(),
      kill: () => app.process().kill("SIGKILL"),
      output: () => "",
    };
  } catch (cause) {
    app.process().kill("SIGKILL");
    throw cause;
  }
}

async function launchInstalled(executable: string, env: NodeJS.ProcessEnv): Promise<RunningApp> {
  const child = spawn(executable, ["--remote-debugging-port=0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let printed = "";
  const record = (chunk: Buffer): void => {
    // Bounded: the head says how the boot went, the tail how it ended.
    printed = (printed + chunk.toString("utf8")).slice(-1_000_000);
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  let exit: string | undefined;
  const exited = new Promise<string>((resolve) => {
    child.once("exit", (code, signal) => {
      exit = signal ?? `code ${String(code)}`;
      resolve(exit);
    });
  });

  try {
    const endpoint = await (async () => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(printed);
        if (match?.[1] !== undefined) return match[1];
        if (spawnError !== undefined) throw spawnError;
        if (exit !== undefined) throw new Error(`the app exited (${exit}) before its DevTools endpoint opened:\n${printed}`);
        if (Date.now() > deadline) throw new Error(`no DevTools endpoint within 60 s:\n${printed}`);
        await delay(100);
      }
    })();
    const browser = await chromium.connectOverCDP(endpoint);

    // The shell, by its document URL: the DexScreener bridge opens a hidden
    // window at boot too (see selectShellWindow).
    const deadline = Date.now() + 30_000;
    let window: Page | undefined;
    while (window === undefined) {
      window = browser.contexts().flatMap((context) => context.pages()).find((page) => isShellUrl(page.url()));
      if (window !== undefined) break;
      if (Date.now() > deadline) throw new Error("no shell window within 30 s of the DevTools endpoint opening");
      await delay(250);
    }
    const shell = window;

    return {
      window: shell,
      async quit() {
        if (process.platform === "darwin") child.kill("SIGTERM");
        else await shell.evaluate(() => window.close()).catch(() => undefined);
        let timer: NodeJS.Timeout | undefined;
        const how = await Promise.race([
          exited,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), QUIT_DEADLINE_MS);
          }),
        ]);
        clearTimeout(timer);
        await browser.close().catch(() => undefined);
        if (how === null) {
          throw new Error(`the app was still running ${String(QUIT_DEADLINE_MS / 1000)} s after the user's quit`);
        }
        if (how !== "code 0") throw new Error(`the app's quit ended with ${how}, not a clean exit`);
      },
      kill: () => child.kill("SIGKILL"),
      output: () => printed,
    };
  } catch (cause) {
    child.kill("SIGKILL");
    throw cause;
  }
}

/** Every file directly in `dir`, attached to the test as `<label>/<name>`. */
async function attachDirectory(testInfo: TestInfo, dir: string, label: string): Promise<void> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isFile()) await testInfo.attach(`${label}/${name}`, { path: file, contentType: "text/plain" });
  }
}

let configDir: string | undefined;
let running: RunningApp | undefined;

// On a failure (a timeout included, which never reaches the test's own
// `finally`) the app's own logs are the evidence: main's log, the bundled
// Postgres's server log, the runtime's state, and what the process printed.
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && configDir !== undefined) {
    const runtimeDir = path.join(configDir, "runtime");
    await attachDirectory(testInfo, path.join(configDir, ".electron-state", "logs"), "app-logs");
    await attachDirectory(testInfo, path.join(runtimeDir, "pg18", "log"), "postgres-log");
    const state = path.join(runtimeDir, "runtime-state.json");
    if (existsSync(state)) await testInfo.attach("runtime-state.json", { path: state, contentType: "application/json" });
    const output = running?.output() ?? "";
    if (output !== "") await testInfo.attach("app-output.txt", { body: output, contentType: "text/plain" });
  }
  running?.kill();
  running = undefined;
});

test("native runtime: a first run reaches the wizard on the bundled Postgres, quit stops it, and a relaunch resumes it", async ({}, testInfo) => {
  // An installed app downloads the 333 MB model on its first run.
  test.setTimeout(INSTALLED_APP === undefined ? 240_000 : 900_000);
  configDir = mkdtempSync(path.join(tmpdir(), "vex-e2e-native-"));
  const runtimeDir = path.join(configDir, "runtime");
  const modelPath = path.join(runtimeDir, "models", MODEL_FILE);
  if (INSTALLED_APP === undefined) {
    mkdirSync(path.join(runtimeDir, "models"), { recursive: true });
    linkSync(MODEL, modelPath);
  }

  // First-run timings, for the gate's report. The model is fetched by main's
  // boot start of the runtime, so its download is watched from launch: bytes
  // land in `<model>.part`, which is renamed into place once verified.
  const launchedAt = Date.now();
  const timings: Record<string, number> = {};
  const seconds = (at: number): number => Math.round((at - launchedAt) / 100) / 10;
  const modelWatch = setInterval(() => {
    if (timings["modelDownloadStarted"] === undefined && existsSync(`${modelPath}.part`)) {
      timings["modelDownloadStarted"] = seconds(Date.now());
    }
    if (timings["modelVerified"] === undefined && existsSync(modelPath)) timings["modelVerified"] = seconds(Date.now());
  }, 250);

  const env = { ...process.env, VEX_CONFIG_DIR: configDir, VEX_RUNTIME: "native" };
  const launch = (): Promise<RunningApp> =>
    INSTALLED_APP === undefined ? launchDevelopment(env) : launchInstalled(INSTALLED_APP, env);
  const readState = (): { pg: { systemIdentifier: string; lastPort: number } | null } =>
    JSON.parse(readFileSync(path.join(runtimeDir, "runtime-state.json"), "utf8")) as {
      pg: { systemIdentifier: string; lastPort: number } | null;
    };
  let systemIdentifier: string | undefined;
  try {
    running = await launch();
    const { window } = running;
    await window.waitForLoadState("domcontentloaded");

    const runtime = await window.evaluate(() =>
      (window as unknown as { vex: { system: { runtime: () => Promise<unknown> } } }).vex.system.runtime(),
    );
    expect(runtime).toEqual({ ok: true, data: { native: true } });

    // First run: System Check, whose Continue now leads to migrations.
    await expect(window.locator('[data-vex-screen="systemCheck"]')).toBeVisible({ timeout: 30_000 });
    const continueSetup = window.getByRole("button", { name: "Continue setup" });
    await expect(continueSetup).toBeEnabled({ timeout: 30_000 });
    timings["systemCheckPassed"] = seconds(Date.now());
    await continueSetup.click();

    // Migrations join main's boot start of the native runtime, then apply
    // the full chain to the bundled cluster.
    await expect(window.locator('[data-vex-screen="migrations"]')).toBeVisible({ timeout: 30_000 });
    await window.evaluate(() => {
      const w = window as unknown as {
        vex: { database: { onProgress: (cb: () => void) => unknown } };
        vexGateMigrations?: { first: number; last: number };
      };
      w.vex.database.onProgress(() => {
        const now = Date.now();
        w.vexGateMigrations = { first: w.vexGateMigrations?.first ?? now, last: now };
      });
    });
    const toWizard = window.getByRole("button", { name: "Continue to setup wizard" });
    await expect(toWizard).toBeVisible({ timeout: INSTALLED_APP === undefined ? 180_000 : 840_000 });
    timings["migrationsDone"] = seconds(Date.now());
    const migrations = await window.evaluate(
      () => (window as unknown as { vexGateMigrations?: { first: number; last: number } }).vexGateMigrations,
    );
    if (migrations !== undefined) timings["migrationsSeconds"] = Math.round((migrations.last - migrations.first) / 100) / 10;
    await toWizard.click();
    await expect(window.locator('[data-vex-screen="wizard"]')).toBeVisible({ timeout: 30_000 });
    timings["wizard"] = seconds(Date.now());

    // The cluster was created under this config dir and its identity recorded.
    systemIdentifier = readState().pg?.systemIdentifier;
    expect(systemIdentifier).toMatch(/^\d+$/);
    expect(existsSync(modelPath)).toBe(true);
    expectBundledRuntimeUp(runtimeDir);
  } finally {
    clearInterval(modelWatch);
    const summary = `first run (s since launch): ${JSON.stringify(timings)}`;
    console.log(summary);
    testInfo.annotations.push({ type: "timings", description: summary });
  }

  const quitting = Date.now();
  await running.quit();
  running = undefined;
  console.log(`quit took ${String(Math.round((Date.now() - quitting) / 100) / 10)} s`);

  // The ordered quit stopped Postgres with a fast shutdown, and left nothing
  // the app ships running.
  expect(existsSync(path.join(runtimeDir, "pg18", "postmaster.pid"))).toBe(false);
  await expectNoBundledProcess();

  // Relaunch on the same profile. The second boot runs on what the first
  // left behind: the same cluster (its identity unchanged), the verified model
  // (no second download), and a schema already up to date, so migrations have
  // nothing to apply and hand over to the wizard on their own.
  const modelWritten = statSync(modelPath).mtimeMs;
  running = await launch();
  const second = running.window;
  await second.waitForLoadState("domcontentloaded");
  await expect(second.locator('[data-vex-screen="systemCheck"]')).toBeVisible({ timeout: 30_000 });
  const continueAgain = second.getByRole("button", { name: "Continue setup" });
  await expect(continueAgain).toBeEnabled({ timeout: 30_000 });
  await continueAgain.click();
  await expect(second.locator('[data-vex-screen="wizard"]')).toBeVisible({ timeout: 120_000 });
  expect(readState().pg?.systemIdentifier).toBe(systemIdentifier);
  expect(existsSync(`${modelPath}.part`)).toBe(false);
  expect(statSync(modelPath).mtimeMs).toBe(modelWritten);
  expectBundledRuntimeUp(runtimeDir);
  await running.quit();
  running = undefined;
  expect(existsSync(path.join(runtimeDir, "pg18", "postmaster.pid"))).toBe(false);
  await expectNoBundledProcess();

  rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
});
