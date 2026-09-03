/**
 * Playwright test fixture: launches the *built* Electron app against a
 * fresh per-spec tmpdir, hands the test back the `ElectronApplication`
 * + its first window, then tears everything down on completion.
 *
 * Per-spec isolation strategy:
 *   - mint a tmpdir with `mkdtempSync`
 *   - set `VEX_CONFIG_DIR=<tmpdir>` in the launched env (honoured by
 *     both `vex-app/src/main/paths/config-dir.ts` and the root
 *     `src/config/paths.ts`)
 *   - on teardown, close the Electron app + remove the tmpdir
 *
 * We do NOT set `NODE_ENV=test` — Codex S2 turn 2 review: keep the
 * launch as close to the built-app default as possible; only the
 * `VEX_CONFIG_DIR` override is intentional.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  test as base,
  _electron,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the built main bundle. Tests assume `pnpm run build`
 * has already produced `dist/main/index.js`; CI orders the e2e job
 * after the build job to enforce this.
 */
export const MAIN_BUNDLE = path.resolve(__dirname, "../../dist/main/index.js");

/**
 * The app PACKAGE directory (`vex-app`), whose `main` field names the same
 * bundle.
 *
 * Handed to `_electron.launch` instead of {@link MAIN_BUNDLE} when a spec needs
 * `app.getAppPath()` to be the package rather than `dist/main`: Electron sets
 * the app path from what it is given, and main resolves development-mode
 * sibling assets (the Studio bridge binary) relative to it.
 */
export const APP_DIR = path.resolve(__dirname, "../..");

/** How long the shell window may take to appear before the app counts as wedged. */
const SHELL_WINDOW_DEADLINE_MS = 30_000;

/**
 * How long `app.close()` may take before the app counts as wedged on the way
 * OUT. Not a widened budget: it is SHORTER than the spec timeouts it used to
 * blow through, and it exists so the failure arrives as a named quit
 * participant plus the main-process log rather than as
 * `Tearing down "vexApp" exceeded the test timeout`, which says nothing about
 * which owner never returned. The app's own quit backstop
 * (`main/lifecycle/quit-stage.ts`) is well under this.
 */
const APP_CLOSE_DEADLINE_MS = 30_000;

/**
 * Read the app's quit trace out of its own log: every `[quit] begin <name>`
 * with no matching `end`/`TIMED OUT` is a participant that never returned.
 *
 * This is the diagnosis the previous teardown timeout could not give. The
 * whole log is attached alongside it; this line is only the headline.
 */
function unfinishedQuitStages(mainLog: string): string {
  const begun: string[] = [];
  const settled = new Set<string>();
  for (const line of mainLog.split("\n")) {
    const begin = /\[quit\] begin (\S+)/.exec(line);
    if (begin?.[1] !== undefined) begun.push(begin[1]);
    const end = /\[quit\] (?:end|TIMED OUT) (\S+)/.exec(line);
    if (end?.[1] !== undefined) settled.add(end[1]);
  }
  if (begun.length === 0) return "the quit never reached a single cleanup participant";
  const unfinished = begun.filter((name) => !settled.has(name));
  return unfinished.length === 0
    ? "every quit participant finished; the process itself did not exit"
    : `quit participants that never returned: ${unfinished.join(", ")}`;
}

/**
 * Close the app under a deadline and, when it will not go, PRESERVE THE
 * EVIDENCE: the whole main-process log is attached to the test and the wedged
 * participant is named in the thrown error. The process is then killed so the
 * Playwright worker is not stranded behind it.
 *
 * Returns the failure message, or `null` when the app exited normally.
 */
async function closeAppWithEvidence(
  app: ElectronApplication,
  configDir: string,
  testInfo: TestInfo,
): Promise<string | null> {
  let timedOut = false;
  let releaseDeadline: () => void = () => undefined;
  // Armed BEFORE the close is awaited, so a close that never settles is still
  // bounded.
  const deadline = new Promise<void>((resolve) => {
    releaseDeadline = resolve;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    releaseDeadline();
  }, APP_CLOSE_DEADLINE_MS);
  try {
    // `close()` rejects when main has already exited on a cancel path; that is
    // not a wedge.
    await Promise.race([app.close().catch(() => undefined), deadline]);
  } finally {
    clearTimeout(timer);
    releaseDeadline();
  }
  if (!timedOut) return null;

  let diagnosis = "no main-process log was written";
  try {
    const mainLog = readFileSync(
      path.join(configDir, ".electron-state", "logs", "main.log"),
      "utf8",
    );
    // The WHOLE log, never a tail: the boot lines are what say which
    // subsystems were live when the quit began.
    await testInfo.attach("wedged-quit-main.log", {
      body: mainLog,
      contentType: "text/plain",
    });
    diagnosis = unfinishedQuitStages(mainLog);
  } catch {
    /* the diagnosis stays the default */
  }
  try {
    app.process().kill("SIGKILL");
  } catch {
    /* already gone */
  }
  return (
    `the Electron app did not exit within ${String(APP_CLOSE_DEADLINE_MS)}ms of `
    + `app.close(): ${diagnosis}. The full main-process log is attached as `
    + "`wedged-quit-main.log`."
  );
}

/**
 * The app shell's document, in both load modes: `app://vex/index.html` when
 * the built renderer is loaded, the Vite origin in dev.
 */
function isShellUrl(url: string): boolean {
  return url.endsWith("/index.html") || url.startsWith("http://127.0.0.1:5173");
}

/**
 * Resolve the SHELL window by URL. `firstWindow()` is a race against every
 * hidden helper window the main process opens at boot; the shell is the one
 * window whose identity is a contract.
 */
export async function selectShellWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + SHELL_WINDOW_DEADLINE_MS;
  for (;;) {
    for (const candidate of app.windows()) {
      if (isShellUrl(candidate.url())) return candidate;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no shell window within ${SHELL_WINDOW_DEADLINE_MS}ms; saw: ${app
          .windows()
          .map((w) => w.url())
          .join(", ") || "none"}`,
      );
    }
    const next = await Promise.race([
      app.waitForEvent("window", { timeout: deadline - Date.now() }).catch(() => null),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 500);
      }),
    ]);
    if (next !== null && isShellUrl(next.url())) return next;
  }
}

/**
 * A RELAUNCHED app: the second boot, and the shell window inside it.
 *
 * The caller OWNS it. Nothing in this module closes it, because nothing here
 * knows when the test is done with it - see {@link relaunchApp}.
 */
export interface RelaunchedVexApp {
  readonly app: ElectronApplication;
  readonly shell: Page;
}

/**
 * QUIT THE APP AND START IT AGAIN ON THE SAME PROFILE.
 *
 * This is the one thing a single-launch fixture cannot do and the only way to
 * prove a restore: what a workspace, a layout or a selection claims to persist
 * is only persisted if a SECOND process reads it back off the same disk. VS
 * Code's own smoke suite has exactly this instrument -
 * `Application.restart()` (`test/automation/src/application.ts:85`) is `stop()`
 * then `_start()` against the same user data dir - and its data-loss tests
 * ("verifies opened editors are restored") are what it exists for.
 *
 * ## What travels, and what does not
 *
 * The SAME `VEX_CONFIG_DIR` and the same extra environment, because that
 * directory holds everything a restore reads: the config, the terminal
 * snapshots, and the Chromium profile whose localStorage carries the renderer's
 * own `vex-ui` payload. Anything else the first launch was given - the database
 * door's port and password file, for instance - is passed through `env` by the
 * caller, since this module cannot know what stack the app was launched
 * against.
 *
 * ## Two ownerships that must not be confused
 *
 *  - THE CONFIG DIR belongs to whoever created it (the fixture below, or the
 *    isolated stack). This function neither creates nor deletes it: deleting it
 *    here would take the profile out from under the very relaunch it just
 *    performed, and the owning teardown removes it at the end of the test
 *    either way.
 *  - THE RETURNED APP belongs to the CALLER, which must close it - a
 *    `try`/`finally` around the second half of the test is the shape - because
 *    the fixture's own teardown closes the FIRST app and has never heard of
 *    this one.
 *
 * The quit goes through {@link closeAppWithEvidence}, so a relaunch whose first
 * half will not exit produces the named wedged quit participant and the
 * attached main-process log rather than a bare timeout.
 *
 * @throws when the first app will not exit, with the wedge diagnosis.
 */
export async function relaunchApp(
  app: ElectronApplication,
  configDir: string,
  testInfo: TestInfo,
  options: {
    /** What the first launch was given. Defaults to the main bundle. */
    readonly args?: readonly string[];
    /** The first launch's extra environment (the database door, typically). */
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): Promise<RelaunchedVexApp> {
  const wedged = await closeAppWithEvidence(app, configDir, testInfo);
  if (wedged !== null) throw new Error(wedged);

  const relaunched = await _electron.launch({
    args: [...(options.args ?? [MAIN_BUNDLE])],
    env: {
      ...process.env,
      ...options.env,
      // The SAME profile: this is the whole point of the instrument.
      VEX_CONFIG_DIR: configDir,
      VEX_E2E_LOAD_BUILT: "1",
    },
  });
  try {
    return { app: relaunched, shell: await selectShellWindow(relaunched) };
  } catch (cause) {
    // The second boot never showed a window. Close it rather than stranding a
    // second Electron behind the worker, and let the caller see the cause.
    try {
      await relaunched.close();
    } catch {
      /* best-effort */
    }
    throw cause;
  }
}

export interface VexElectronFixture {
  readonly app: ElectronApplication;
  readonly firstWindow: Page;
  readonly configDir: string;
}

export const test = base.extend<{ vexApp: VexElectronFixture }>({
  vexApp: async ({}, use, testInfo) => {
    const configDir = mkdtempSync(path.join(tmpdir(), "vex-e2e-"));
    const app = await _electron.launch({
      args: [MAIN_BUNDLE],
      env: {
        ...process.env,
        VEX_CONFIG_DIR: configDir,
        // Force the production renderer load path even though
        // `app.isPackaged` is false when launching `dist/main/index.js`
        // directly. Without this, main would try `http://127.0.0.1:5173/`
        // (Vite dev server) which CI does not run.
        VEX_E2E_LOAD_BUILT: "1",
      },
    });
    let firstWindow: Page;
    try {
      // THE SHELL, not whichever BrowserWindow happens to be created first.
      // Window creation order is not a contract: the DexScreener site bridge
      // opens a hidden `app://vex/dexscreener-bridge` window when the market
      // widget's boot refresh runs, and on a fast boot it wins the race.
      // Select the shell by its document URL instead.
      firstWindow = await selectShellWindow(app);
    } catch (cause) {
      // If the window never arrives the app is wedged — close + clean
      // before re-throwing so the test failure is the real signal, not
      // a leak.
      try {
        await app.close();
      } catch {
        /* best-effort */
      }
      rmSync(configDir, { recursive: true, force: true });
      throw cause;
    }

    await use({ app, firstWindow, configDir });

    // The evidence is read out of the config dir, so the close is resolved
    // BEFORE the directory goes.
    const wedged = await closeAppWithEvidence(app, configDir, testInfo);
    rmSync(configDir, { recursive: true, force: true });
    if (wedged !== null) throw new Error(wedged);
  },
});

export const expect = test.expect;
