/**
 * Moving a previous release's Docker data into the native runtime, end to
 * end, against the BUILT app with `VEX_RUNTIME=native`:
 *
 *   1. Move my data: a disposable previous-release install (a `migtest-`
 *      compose project, all migrations, realistic data, stopped) is offered
 *      for migration on the first launch, main has NOT started the native
 *      runtime, Move my data walks the rows, then the runtime screen and the
 *      migrations lead to the wizard. A relaunch never offers it again.
 *   2. Start fresh: another such install, the typed confirmation, a new
 *      empty cluster through the same screens; the old volume is kept.
 *
 * The install is seeded by the engine's real-test helpers
 * (`src/main/runtime/__tests__/previous-release.seed.real.test.ts`), so this
 * spec and the engine's own real test exercise the same previous release.
 * Every container and volume it creates carries the `migtest-` id and is
 * removed afterwards; nothing else in Docker is read or touched.
 *
 * Skipped, visibly, without Docker and the pinned image, or without the
 * native trees and the verified model (hard-linked into each config dir, as
 * `native-runtime.spec.ts` does). `VEX_NATIVE_PG_DIR` / `VEX_NATIVE_LLAMA_DIR`
 * point at trees outside the repo; `VEX_E2E_MIGRATION_SHOTS=<abs dir>` saves
 * a screenshot of every screen.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { APP_DIR, MAIN_BUNDLE, selectShellWindow } from "./fixtures/electron-app.js";

const REPO = path.resolve(APP_DIR, "..");
const TARGET = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const PG_DIR = process.env["VEX_NATIVE_PG_DIR"] ?? path.join(REPO, "native-runtime/out", TARGET, "postgres");
const LLAMA_DIR = process.env["VEX_NATIVE_LLAMA_DIR"] ?? path.join(REPO, "native-runtime/out", TARGET, "llama");
const MODEL_FILE = "embeddinggemma-300M-Q8_0.gguf";
const MODEL = path.join(REPO, "native-runtime/.work/models", MODEL_FILE);
const SHOTS = process.env["VEX_E2E_MIGRATION_SHOTS"];
const SEED_SPEC = "src/main/runtime/__tests__/previous-release.seed.real.test.ts";
const IMAGE =
  /image: (pgvector\/pgvector:[^\s]+)/.exec(
    readFileSync(path.join(APP_DIR, "resources/compose/docker-compose.template.yml"), "utf8"),
  )?.[1] ?? "";

function dockerMissing(): string | null {
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 20_000 });
  if (info.status !== 0) return "docker does not answer";
  const image = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8", timeout: 20_000 });
  return image.status === 0 ? null : `the pinned image ${IMAGE} is not present locally`;
}

const missing =
  process.platform === "win32"
    ? "no Windows tree to run against here"
    : !existsSync(PG_DIR) || !existsSync(LLAMA_DIR) || !existsSync(MODEL)
      ? `needs ${PG_DIR}, ${LLAMA_DIR} and ${MODEL}`
      : !existsSync(MAIN_BUNDLE)
        ? `needs the built app (${MAIN_BUNDLE})`
        : dockerMissing();
test.skip(missing !== null, missing ?? "");
test.describe.configure({ mode: "serial" });

interface Install {
  readonly configDir: string;
  readonly runtimeDir: string;
  readonly installId: string;
  readonly project: string;
  readonly volumes: readonly string[];
  readonly seeded: Record<string, unknown>;
}

function docker(args: readonly string[], cwd?: string): { status: number | null; stdout: string } {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000, ...(cwd !== undefined ? { cwd } : {}) });
  return { status: r.status, stdout: r.stdout };
}

/** A stopped previous-release install, seeded by the engine's real-test helpers. */
function seedInstall(): Install {
  const configDir = mkdtempSync(path.join(tmpdir(), "vex-e2e-migration-"));
  const installId = `migtest-${randomUUID()}`;
  const report = path.join(configDir, "..", `${path.basename(configDir)}-seed.json`);
  const seed = spawnSync("pnpm", ["exec", "vitest", "run", SEED_SPEC], {
    cwd: APP_DIR,
    encoding: "utf8",
    timeout: 600_000,
    env: {
      ...process.env,
      VEX_SEED_PREVIOUS_RELEASE_CONFIG_DIR: configDir,
      VEX_SEED_PREVIOUS_RELEASE_INSTALL_ID: installId,
      VEX_SEED_PREVIOUS_RELEASE_REPORT: report,
    },
  });
  if (seed.status !== 0 || !existsSync(report)) {
    throw new Error(`seeding failed (${String(seed.status)}):\n${(seed.stdout + seed.stderr).slice(-3_000)}`);
  }
  const seeded = JSON.parse(readFileSync(report, "utf8")) as Record<string, unknown>;
  rmSync(report, { force: true });
  const runtimeDir = path.join(configDir, "runtime");
  // The verified model, so the run does not download 333 MB; the model
  // store still checks it before llama-server may load it.
  mkdirSync(path.join(runtimeDir, "models"), { recursive: true });
  linkSync(MODEL, path.join(runtimeDir, "models", MODEL_FILE));
  return {
    configDir,
    runtimeDir,
    installId,
    project: `vex-${installId}`,
    volumes: [`vex-postgres-data-${installId}`, `vex-embed-models-${installId}`],
    seeded,
  };
}

/** This install's project and volumes only, by their migtest- names. */
function removeInstall(install: Install): void {
  if (!install.installId.startsWith("migtest-")) return;
  const composeDir = path.join(install.configDir, "compose");
  if (existsSync(path.join(composeDir, "docker-compose.yml"))) {
    docker(["compose", "-p", install.project, "down", "--volumes", "--remove-orphans"], composeDir);
  }
  for (const v of install.volumes) if (v.includes("-migtest-")) docker(["volume", "rm", "-f", v]);
  rmSync(install.configDir, { recursive: true, force: true });
}

function launch(install: Install): Promise<ElectronApplication> {
  return _electron.launch({
    args: [MAIN_BUNDLE],
    env: {
      ...process.env,
      VEX_CONFIG_DIR: install.configDir,
      VEX_RUNTIME: "native",
      VEX_E2E_LOAD_BUILT: "1",
      VEX_NATIVE_PG_DIR: PG_DIR,
      VEX_NATIVE_LLAMA_DIR: LLAMA_DIR,
    },
  });
}

async function shot(window: Page, name: string): Promise<void> {
  if (SHOTS !== undefined && path.isAbsolute(SHOTS)) {
    mkdirSync(SHOTS, { recursive: true });
    await window.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  }
}

/** Every state a screen's rows show, recorded as it changes (a poll can miss one). */
async function recordRows(window: Page, screen: string): Promise<void> {
  await window.evaluate((s) => {
    const seen: string[] = [];
    (window as unknown as { vexE2eRows: string[] }).vexE2eRows = seen;
    new MutationObserver(() => {
      const rows = document.querySelectorAll(`[data-vex-screen="${s}"] [data-step]`);
      const state = Array.from(rows, (r) => `${r.getAttribute("data-step") ?? ""}:${r.getAttribute("data-status") ?? ""}`).join(" ");
      if (state !== "" && seen.at(-1) !== state) seen.push(state);
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  }, screen);
}

async function continueFromSystemCheck(window: Page): Promise<void> {
  await expect(window.locator('[data-vex-screen="systemCheck"]')).toBeVisible({ timeout: 30_000 });
  const continueSetup = window.getByRole("button", { name: "Continue setup" });
  await expect(continueSetup).toBeEnabled({ timeout: 30_000 });
  await continueSetup.click();
}

type RuntimeState = {
  provider?: string;
  pg: { systemIdentifier: string } | null;
  migration?: { step: string; outcome: string | null; installId: string };
};

function runtimeState(install: Install): RuntimeState {
  return JSON.parse(readFileSync(path.join(install.runtimeDir, "runtime-state.json"), "utf8")) as RuntimeState;
}

async function nativeRuntimePhase(window: Page): Promise<unknown> {
  return window.evaluate(async () => {
    const vex = (window as unknown as { vex: { system: { runtimeStatus: () => Promise<{ ok: boolean; data?: { phase: string } }> } } }).vex;
    return (await vex.system.runtimeStatus()).data?.phase;
  });
}

test("move my data: the previous release's data reaches the wizard on the native runtime, and is not offered again", async () => {
  test.setTimeout(1_200_000);
  const install = seedInstall();
  const timings: Record<string, number> = {};
  try {
    let app = await launch(install);
    try {
      const window = await selectShellWindow(app);
      await window.waitForLoadState("domcontentloaded");
      await continueFromSystemCheck(window);

      const screen = window.locator('[data-vex-screen="runtimeMigration"]');
      await expect(screen).toBeVisible({ timeout: 30_000 });
      const move = window.getByRole("button", { name: "Move my data" });
      await expect(move).toBeVisible({ timeout: 30_000 });
      await expect(screen).toContainText("Vex no longer needs Docker");
      // The gate held the native runtime back: nothing started, no cluster.
      expect(await nativeRuntimePhase(window)).toBe("idle");
      expect(existsSync(path.join(install.runtimeDir, "pg18"))).toBe(false);
      await shot(window, "01-migration-pending");

      await recordRows(window, "runtimeMigration");
      const startedAt = Date.now();
      await move.click();
      await expect(window.locator('[data-vex-screen="runtimeMigration"] [data-step="source"]')).toBeVisible();
      await shot(window, "02-migration-moving");
      // The copy takes seconds on this seed: catch its readout when it can.
      const copying = window.locator('[data-vex-screen="runtimeMigration"] [data-step="copy"][data-status="active"]');
      if (await copying.waitFor({ timeout: 60_000 }).then(() => true, () => false)) {
        await shot(window, "02b-migration-copying");
      }
      await expect(window.getByText("Your data is moved")).toBeVisible({ timeout: 600_000 });
      timings["moveMs"] = Date.now() - startedAt;
      await shot(window, "03-migration-done");
      const rows = await window.evaluate(() => (window as unknown as { vexE2eRows: string[] }).vexE2eRows);
      expect(rows.length, "the migration screen never showed its rows").toBeGreaterThan(1);
      expect(rows.some((r) => r.includes("copy:active"))).toBe(true);
      expect(rows.some((r) => r.includes("verify:active"))).toBe(true);
      expect(rows.at(-1)).toBe("source:ready copy:ready restore:ready verify:ready finish:ready");

      // Then the runtime screen watches main start the runtime on the
      // migrated cluster, and the migrations find nothing to apply.
      await expect(window.locator('[data-vex-screen="runtimeBootstrap"]')).toBeVisible({ timeout: 30_000 });
      await shot(window, "04-runtime-bootstrap");
      await expect(window.locator('[data-vex-screen="wizard"]')).toBeVisible({ timeout: 180_000 });
      timings["toWizardMs"] = Date.now() - startedAt;
      await shot(window, "05-wizard");

      const state = runtimeState(install);
      expect(state.provider).toBe("native");
      expect(state.migration).toMatchObject({ installId: install.installId, step: "completed", outcome: "migrated" });
      expect(state.pg?.systemIdentifier).toMatch(/^\d+$/);
      // The Docker volume stays as the backup; its stack was stopped.
      expect(docker(["volume", "inspect", install.volumes[0] as string]).status).toBe(0);
      expect(
        docker(["ps", "--filter", `label=com.docker.compose.project=${install.project}`, "--filter", "status=running", "-q"]).stdout.trim(),
      ).toBe("");
    } finally {
      await app.close();
    }
    expect(existsSync(path.join(install.runtimeDir, "pg18", "postmaster.pid"))).toBe(false);

    // Relaunch: nothing to move, straight to the runtime screen.
    app = await launch(install);
    try {
      const window = await selectShellWindow(app);
      await window.waitForLoadState("domcontentloaded");
      await continueFromSystemCheck(window);
      await expect(window.locator('[data-vex-screen="runtimeBootstrap"]')).toBeVisible({ timeout: 30_000 });
      await expect(window.locator('[data-vex-screen="wizard"]')).toBeVisible({ timeout: 180_000 });
      await shot(window, "06-relaunch-wizard");
      const offered = await window.evaluate(async () => {
        const vex = (window as unknown as { vex: { system: { runtimeMigrationStatus: () => Promise<unknown> } } }).vex;
        return vex.system.runtimeMigrationStatus();
      });
      expect(offered).toEqual({ ok: true, data: { kind: "not_needed" } });
      expect(await window.locator('[data-vex-screen="runtimeMigration"]').count()).toBe(0);
    } finally {
      await app.close();
    }
    const evidence = JSON.stringify({ seeded: install.seeded, timings });
    test.info().annotations.push({ type: "evidence", description: evidence });
    console.log(`[native-migration] ${evidence}`);
  } finally {
    removeInstall(install);
  }
});

test("start fresh: a typed confirmation, then an empty native database; the old volume is kept", async () => {
  test.setTimeout(1_200_000);
  const install = seedInstall();
  try {
    const app = await launch(install);
    try {
      const window = await selectShellWindow(app);
      await window.waitForLoadState("domcontentloaded");
      await continueFromSystemCheck(window);
      await expect(window.getByRole("button", { name: "Move my data" })).toBeVisible({ timeout: 30_000 });

      await window.getByRole("button", { name: "Start fresh instead" }).click();
      const confirm = window.getByRole("button", { name: "Start fresh without my data" });
      await expect(confirm).toBeDisabled();
      await window.getByLabel('Type "start fresh" to confirm').fill("start fresh");
      await expect(confirm).toBeEnabled();
      await shot(window, "07-start-fresh-confirm");
      const startedAt = Date.now();
      await confirm.click();

      await expect(window.getByText("A new local database is ready")).toBeVisible({ timeout: 120_000 });
      await expect(window.locator('[data-vex-screen="runtimeBootstrap"]')).toBeVisible({ timeout: 30_000 });
      // An empty cluster: the migrations apply the whole chain.
      const toWizard = window.getByRole("button", { name: "Continue to setup wizard" });
      await expect(toWizard).toBeVisible({ timeout: 240_000 });
      await shot(window, "08-start-fresh-migrations");
      await toWizard.click();
      await expect(window.locator('[data-vex-screen="wizard"]')).toBeVisible({ timeout: 30_000 });
      console.log(`[native-migration] ${JSON.stringify({ startFreshToWizardMs: Date.now() - startedAt })}`);

      const state = runtimeState(install);
      expect(state.provider).toBe("native");
      expect(state.migration).toMatchObject({ installId: install.installId, step: "completed", outcome: "fresh" });
      expect(docker(["volume", "inspect", install.volumes[0] as string]).status).toBe(0);
    } finally {
      await app.close();
    }
  } finally {
    removeInstall(install);
  }
});
