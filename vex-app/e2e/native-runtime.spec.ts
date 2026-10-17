/**
 * The native runtime, end to end, against the BUILT app: a first run with
 * `VEX_RUNTIME=native` gets from System Check through migrations on the
 * bundled Postgres to the setup wizard, without any container, and quitting
 * the app stops the bundled servers cleanly.
 *
 * Uses the trees `native-runtime/<component>/build.sh` produced and the
 * gates' verified model, hard-linked into the fresh config dir so the run
 * does not download 333 MB (the download itself is covered by the model
 * store's tests). Skipped, visibly, when any of them is missing.
 */

import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron, expect, test } from "@playwright/test";
import { APP_DIR, MAIN_BUNDLE, selectShellWindow } from "./fixtures/electron-app.js";

const REPO = path.resolve(APP_DIR, "..");
const TARGET = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const PG_DIR = path.join(REPO, "native-runtime/out", TARGET, "postgres");
const LLAMA_DIR = path.join(REPO, "native-runtime/out", TARGET, "llama");
const MODEL_FILE = "embeddinggemma-300M-Q8_0.gguf";
const MODEL = path.join(REPO, "native-runtime/.work/models", MODEL_FILE);

test.skip(
  !existsSync(PG_DIR) || !existsSync(LLAMA_DIR) || !existsSync(MODEL),
  `needs ${PG_DIR}, ${LLAMA_DIR} and ${MODEL} (native-runtime build + llama/fetch-model.sh)`,
);

test("native runtime: a first run reaches the wizard on the bundled Postgres, and quit stops it", async () => {
  test.setTimeout(240_000);
  const configDir = mkdtempSync(path.join(tmpdir(), "vex-e2e-native-"));
  const runtimeDir = path.join(configDir, "runtime");
  mkdirSync(path.join(runtimeDir, "models"), { recursive: true });
  linkSync(MODEL, path.join(runtimeDir, "models", MODEL_FILE));

  const app = await _electron.launch({
    args: [MAIN_BUNDLE],
    env: {
      ...process.env,
      VEX_CONFIG_DIR: configDir,
      VEX_E2E_LOAD_BUILT: "1",
      VEX_RUNTIME: "native",
      VEX_NATIVE_PG_DIR: PG_DIR,
      VEX_NATIVE_LLAMA_DIR: LLAMA_DIR,
    },
  });
  try {
    const window = await selectShellWindow(app);
    await window.waitForLoadState("domcontentloaded");

    const runtime = await window.evaluate(() =>
      (window as unknown as { vex: { system: { runtime: () => Promise<unknown> } } }).vex.system.runtime(),
    );
    expect(runtime).toEqual({ ok: true, data: { native: true } });

    // First run: System Check, whose Continue now leads to migrations.
    await expect(window.locator('[data-vex-screen="systemCheck"]')).toBeVisible({ timeout: 30_000 });
    const continueSetup = window.getByRole("button", { name: "Continue setup" });
    await expect(continueSetup).toBeEnabled({ timeout: 30_000 });
    await continueSetup.click();

    // Migrations join main's boot start of the native runtime, then apply
    // the full chain to the bundled cluster.
    await expect(window.locator('[data-vex-screen="migrations"]')).toBeVisible({ timeout: 30_000 });
    const toWizard = window.getByRole("button", { name: "Continue to setup wizard" });
    await expect(toWizard).toBeVisible({ timeout: 180_000 });
    await toWizard.click();
    await expect(window.locator('[data-vex-screen="wizard"]')).toBeVisible({ timeout: 30_000 });

    // The cluster was created under this config dir and its identity recorded.
    const state = JSON.parse(readFileSync(path.join(runtimeDir, "runtime-state.json"), "utf8")) as {
      pg: { systemIdentifier: string; lastPort: number } | null;
    };
    expect(state.pg?.systemIdentifier).toMatch(/^\d+$/);
    expect(existsSync(path.join(runtimeDir, "pg18", "postmaster.pid"))).toBe(true);
  } finally {
    await app.close();
  }

  // The ordered quit stopped Postgres with a fast shutdown.
  expect(existsSync(path.join(runtimeDir, "pg18", "postmaster.pid"))).toBe(false);
  rmSync(configDir, { recursive: true, force: true });
});
