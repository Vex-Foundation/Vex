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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, _electron, type ElectronApplication, type Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the built main bundle. Tests assume `pnpm run build`
 * has already produced `dist/main/index.js`; CI orders the e2e job
 * after the build job to enforce this.
 */
const MAIN_BUNDLE = path.resolve(__dirname, "../../dist/main/index.js");

/** How long the shell window may take to appear before the app counts as wedged. */
const SHELL_WINDOW_DEADLINE_MS = 30_000;

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
async function selectShellWindow(app: ElectronApplication): Promise<Page> {
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

export interface VexElectronFixture {
  readonly app: ElectronApplication;
  readonly firstWindow: Page;
  readonly configDir: string;
}

export const test = base.extend<{ vexApp: VexElectronFixture }>({
  vexApp: async ({}, use) => {
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

    try {
      await app.close();
    } catch {
      /* main may already be torn down on cancel paths */
    }
    rmSync(configDir, { recursive: true, force: true });
  },
});

export const expect = test.expect;
