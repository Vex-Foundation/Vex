/**
 * v0.4.2 release screenshots, from the real app against the production Vex
 * Inference gateway. NOT a CI gate: runs only when VEX_RELEASE_SHOTS=1 with
 * a profile and an output directory named, and does real (bounded) work on a
 * real account, so nobody runs it by accident.
 *
 *   VEX_RELEASE_SHOTS=1
 *   VEX_RELEASE_SHOTS_DIR=<where the JPEGs go>
 *   VEX_RELEASE_SHOTS_PROFILE=<a throwaway config dir, reused across runs>
 *   VEX_RELEASE_SHOTS_KEY_FILE=<a dotenv file holding the perf wallets' keys>
 *   VEX_RELEASE_SHOTS_WALLET=<which perf wallet to import, e.g. 2 for VEX_PERF_2_PRIVATE_KEY>
 *   VEX_RELEASE_SHOTS_MODEL=<a verified embeddings model to hard-link>
 *   VEX_RELEASE_SHOTS_ONLY=<comma list of stages, default: all>
 *   VEX_RELEASE_SHOTS_DEBUG=<optional: a page dump per wizard step>
 *
 * Stages, in order: provider, account (the account panel at rest), deposit,
 * auto-top-up, withdraw, chat (the one paid turn), composer, site-models,
 * site. A shot that cannot be taken is
 * logged as SKIPPED with its reason and added to the test's annotations.
 * Run it from vex-app after the build:
 *   pnpm exec playwright test --project=electron-smoke e2e/release-0.4.2-screenshots.spec.ts
 *
 * The profile is the run's own (VEX_CONFIG_DIR), never the owner's, and it is
 * kept between runs so a stage can be re-shot without a second first run. The
 * vault password is generated into the profile on first use.
 *
 * MONEY. The deposit and auto top-up stages open the approval card, capture
 * it and press Reject. The withdrawal stage only checks whether the account
 * can withdraw at all; creating and cancelling the withdrawal for the cooling
 * shot is a by-hand step. No other paid action runs except one short chat
 * turn on a cheap model.
 *
 * The wallet key is read from the key file inside the test process only. It
 * is never printed, and every *PRIVATE_KEY* variable is stripped from the
 * app's environment; the key reaches the app only through the masked import
 * field.
 */

import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { _electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { APP_DIR, MAIN_BUNDLE, selectShellWindow } from "./fixtures/electron-app.js";

const OUT_DIR = process.env["VEX_RELEASE_SHOTS_DIR"] ?? "";
const PROFILE = process.env["VEX_RELEASE_SHOTS_PROFILE"] ?? "";
const MODEL = process.env["VEX_RELEASE_SHOTS_MODEL"] ?? "";
const KEY_FILE = process.env["VEX_RELEASE_SHOTS_KEY_FILE"] ?? "";
const WALLET = process.env["VEX_RELEASE_SHOTS_WALLET"] ?? "";
const ONLY = new Set(
  (process.env["VEX_RELEASE_SHOTS_ONLY"] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""),
);
const DEBUG_DIR = process.env["VEX_RELEASE_SHOTS_DEBUG"] ?? "";
/** A cheap Vex Inference model for the one composer turn. */
const CHAT_MODEL = "anthropic/claude-haiku-5.5";
/** The deposit amount for the approval card: just above the $5 minimum at today's rate. */
const DEPOSIT_VEX = "3000";
/** What the withdrawal check types: the whole balance, which still has to clear the minimum. */
const WITHDRAW_PROBE_VEX = "998";
/** The auto top-up rule shown on the approval card, then rejected. */
const AUTO_TOP_UP = { perTopUp: "3000", perDay: "1", cap: "9000", fee: "0.0005", days: "30" } as const;
/** The one composer turn: one line, so the answer is short and cheap. */
const CHAT_PROMPT = "Say hello in one short sentence.";
const TARGET = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
/** Built trees (native-runtime/out) win over the fetched ones, as in development. */
const NATIVE_DIR = [
  path.join(APP_DIR, "..", "native-runtime", "out", TARGET),
  path.join(APP_DIR, "resources", "native-runtime", TARGET),
].find((dir) => existsSync(path.join(dir, "postgres"))) ?? path.join(APP_DIR, "resources", "native-runtime", TARGET);

test.skip(
  process.env["VEX_RELEASE_SHOTS"] !== "1" || OUT_DIR === "" || PROFILE === "",
  "release screenshots run only with VEX_RELEASE_SHOTS=1, VEX_RELEASE_SHOTS_DIR and VEX_RELEASE_SHOTS_PROFILE set",
);

function wants(stage: string): boolean {
  return ONLY.size === 0 || ONLY.has(stage);
}

/** The throwaway vault's password, minted once into the throwaway profile. */
function vaultPassword(): string {
  const file = path.join(PROFILE, ".release-shots-vault-password");
  if (!existsSync(file)) writeFileSync(file, `Vx-${randomBytes(18).toString("base64url")}`, { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

/** The environment the app gets: the run's profile, and never the wallet key. */
function appEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/PRIVATE_KEY/.test(key)) continue;
    env[key] = value;
  }
  env["VEX_CONFIG_DIR"] = PROFILE;
  env["VEX_E2E_LOAD_BUILT"] = "1";
  // The built bundle's app path is dist/main, so the fetched native runtime
  // trees are named explicitly (the same as native-runtime.spec.ts).
  env["VEX_NATIVE_PG_DIR"] = path.join(NATIVE_DIR, "postgres");
  env["VEX_NATIVE_LLAMA_DIR"] = path.join(NATIVE_DIR, "llama");
  return env;
}

/** A shot that could not be taken, named with its reason in the report. */
function skipped(testInfo: TestInfo, name: string, reason: string): void {
  testInfo.annotations.push({ type: "skipped-shot", description: `${name}: ${reason}` });
  console.log(`SKIPPED ${name}: ${reason}`);
}

async function debugProbe(page: Page, name: string): Promise<void> {
  if (DEBUG_DIR === "") return;
  mkdirSync(DEBUG_DIR, { recursive: true });
  await page.screenshot({ path: path.join(DEBUG_DIR, `${name}.png`) });
  const text = await page.evaluate(() => document.body.innerText);
  writeFileSync(path.join(DEBUG_DIR, `${name}.txt`), text);
}

async function shot(page: Page, name: string): Promise<void> {
  const file = path.join(OUT_DIR, name);
  mkdirSync(path.dirname(file), { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: file, type: "jpeg", quality: 90 });
}

function screen(page: Page, name: string) {
  return page.locator(`[data-vex-screen="${name}"]`);
}

/**
 * From a cold launch to the wizard, the unlock screen or the shell, whichever
 * this profile is at: System Check, the runtime screen and the migrations.
 */
async function bootToWizardOrShell(page: Page): Promise<void> {
  const continueSetup = page.getByRole("button", { name: "Continue setup" });
  await expect(continueSetup.or(screen(page, "unlock")).or(screen(page, "appShell")).first()).toBeVisible({
    timeout: 60_000,
  });
  if (await continueSetup.isVisible()) {
    await expect(continueSetup).toBeEnabled({ timeout: 30_000 });
    await continueSetup.click();
  }
  const toWizard = page.getByRole("button", { name: "Continue to setup wizard" });
  const settled = toWizard
    .or(screen(page, "wizard"))
    .or(screen(page, "unlock"))
    .or(screen(page, "appShell"));
  await expect(settled.first()).toBeVisible({ timeout: 240_000 });
  if (await toWizard.isVisible()) {
    await toWizard.click();
    await expect(screen(page, "wizard")).toBeVisible({ timeout: 30_000 });
  }
}

/**
 * The chosen perf wallet's key, VEX_PERF_<n>_PRIVATE_KEY from the key file.
 * Errors name the variable, never the value.
 */
function walletKey(): string {
  if (KEY_FILE === "" || !/^[0-9]+$/.test(WALLET)) {
    throw new Error("set VEX_RELEASE_SHOTS_KEY_FILE and VEX_RELEASE_SHOTS_WALLET (a perf wallet number) to import a wallet");
  }
  const name = `VEX_PERF_${WALLET}_PRIVATE_KEY`;
  const line = readFileSync(KEY_FILE, "utf8")
    .split(/\r?\n/)
    .map((l) => /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l))
    .find((m) => m?.[1] === name);
  const key = (line?.[2] ?? "").replace(/^["']|["']$/g, "");
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${name} is missing from the key file or is not a 32-byte hex key`);
  }
  return key;
}

/** The wizard pane on screen; inactive panes stay mounted with `hidden`. */
function activePane(page: Page) {
  return page.locator("[data-vex-wizard-pane]:not([hidden])");
}

/**
 * Walk the first-run wizard: the vault, the EVM wallet (imported; nothing is
 * captured while the key is typed, and the field is masked), past the
 * optional steps, and the provider step through {@link onProvider}. Returns
 * the step it stopped at.
 */
async function walkWizard(page: Page, onProvider: (pane: ReturnType<typeof activePane>) => Promise<void>): Promise<string> {
  let last = "";
  let repeats = 0;
  for (let guard = 0; guard < 30; guard += 1) {
    await page.waitForTimeout(800);
    if (await screen(page, "appShell").isVisible()) return "appShell";
    const pane = activePane(page);
    const step = (await pane.getAttribute("data-vex-wizard-pane").catch(() => null)) ?? "none";
    repeats = step === last ? repeats + 1 : 0;
    last = step;
    if (repeats > 4) return `stuck at ${step}`;
    await debugProbe(page, `wizard-${String(guard).padStart(2, "0")}-${step}`);
    switch (step) {
      case "keystore": {
        if (await pane.locator("#vex-keystore-password").isVisible()) {
          const password = vaultPassword();
          await pane.locator("#vex-keystore-password").fill(password);
          await pane.locator("#vex-keystore-confirm").fill(password);
          await pane.getByRole("button", { name: /Save and continue/ }).click();
          // Sealing a new vault can take a while; wait for "Saving..." to clear.
          await expect(pane.getByRole("button", { name: /^Saving/ })).toHaveCount(0, { timeout: 180_000 });
        } else {
          await pane.getByRole("button", { name: /^Continue$/ }).click();
        }
        break;
      }
      case "wallets": {
        const evmEmpty = pane.locator('[data-vex-wallet-state="empty"][data-vex-wallet-chain="evm"]');
        if (await evmEmpty.isVisible()) {
          await evmEmpty.getByRole("button", { name: "Import existing" }).click();
          const importForm = pane.locator('[data-vex-wallet-state="import"][data-vex-wallet-chain="evm"]');
          await importForm.locator("#vex-wallet-import-evm").fill(walletKey());
          await importForm.getByRole("button", { name: "Import" }).click();
          await expect(importForm).toHaveCount(0, { timeout: 30_000 });
        } else if (await pane.locator("[data-vex-wallets-configure-later]").isVisible()) {
          await pane.locator("[data-vex-wallets-configure-later]").click();
        } else {
          await pane.getByRole("button", { name: /^(Continue|Done)$/ }).click();
        }
        break;
      }
      case "apiKeys": {
        await pane.getByRole("button", { name: /^(Skip optional|Continue)$/ }).first().click();
        break;
      }
      case "provider": {
        await onProvider(pane);
        break;
      }
      default: {
        const next = pane.getByRole("button", { name: /^(Continue|Save and continue|Finalize setup)/ });
        if ((await next.count()) === 0) return `no known action at ${step}`;
        await next.last().click();
      }
    }
  }
  return "guard";
}

/** Open a Settings section from the shell's left rail. */
async function openSettings(page: Page, section: string): Promise<void> {
  await page.getByRole("navigation").getByRole("button", { name: "Settings", exact: true }).or(
    page.getByRole("navigation").getByRole("link", { name: "Settings", exact: true }),
  ).first().click();
  await page.getByRole("button", { name: new RegExp(`^${section}\\b`) }).or(
    page.getByRole("link", { name: new RegExp(`^${section}\\b`) }),
  ).first().click();
  await page.waitForTimeout(1200);
}

/** The Vex Inference funding page, from Settings · Inference's Fund key, on one tab. */
async function openFunding(page: Page, tab: string): Promise<void> {
  await openSettings(page, "Inference");
  await page.getByTestId("vex-cloud-fund").click();
  await page.getByRole("tab", { name: tab, exact: true }).click();
  await page.waitForTimeout(1500);
}

/** A theme, picked explicitly so the set does not follow the OS. */
async function pickTheme(page: Page, theme: "celeris" | "chronos"): Promise<void> {
  await openSettings(page, "Preferences");
  await page.locator("[data-vex-settings-appearance]").scrollIntoViewIfNeeded();
  await page.locator(`[data-vex-theme-cube="${theme}"]`).click();
  await expect(page.locator("html")).toHaveAttribute("data-vex-theme", theme);
}

/** The chat this run made, from the left rail. */
async function openSession(page: Page): Promise<void> {
  await page.getByText(CHAT_PROMPT.slice(0, 12)).first().click();
  await page.waitForTimeout(2500);
}

/** The welcome desk: the Chat rail entry with no session open. */
async function openWelcome(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Chat", exact: true }).or(page.getByRole("link", { name: "Chat", exact: true })).first().click();
  await page.waitForTimeout(2500);
  await page.mouse.move(10, 890);
}

/**
 * Sign in to Vex Inference with the imported wallet. The sign-in signs one
 * off-chain message per wallet; no transaction is sent.
 */
async function signInToVexInference(page: Page): Promise<void> {
  const panel = page.locator("[data-vex-cloud-panel]").filter({ visible: true }).first();
  const signedIn = panel.locator('[data-vex-cloud-state="signed_in"]');
  if (await signedIn.isVisible()) return;
  await panel.getByRole("button", { name: "Sign in to Vex Inference" }).click();
  await expect(signedIn).toBeVisible({ timeout: 60_000 });
}

test("captures the v0.4.2 release screenshots", async ({}, testInfo) => {
  test.setTimeout(1_800_000);
  mkdirSync(path.join(PROFILE, "runtime", "models"), { recursive: true });
  const modelPath = path.join(PROFILE, "runtime", "models", "embeddinggemma-300M-Q8_0.gguf");
  if (MODEL !== "" && !existsSync(modelPath)) linkSync(MODEL, modelPath);

  const app: ElectronApplication = await _electron.launch({ args: [MAIN_BUNDLE], env: appEnv() });
  try {
    const page = await selectShellWindow(app);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForLoadState("domcontentloaded");
    await bootToWizardOrShell(page);
    if (await screen(page, "unlock").isVisible()) {
      await page.locator("#vex-unlock-password").fill(vaultPassword());
      await page.getByRole("button", { name: /^Unlock/ }).click();
      await expect(screen(page, "wizard").or(screen(page, "appShell")).first()).toBeVisible({ timeout: 120_000 });
    }
    if (await screen(page, "wizard").isVisible()) {
      const at = await walkWizard(page, async (pane) => {
        await signInToVexInference(page);
        const combo = pane.locator("#vex-provider-cloud-model");
        await combo.click();
        await page.getByRole("option").filter({ hasText: CHAT_MODEL }).first().click();
        await pane.getByRole("button", { name: "Use Vex Inference" }).click();
      });
      console.log(`wizard walker stopped at: ${at}`);
    }
    await expect(screen(page, "appShell")).toBeVisible();
    await pickTheme(page, "celeris");

    if (wants("provider")) {
      await openSettings(page, "Inference");
      await shot(page, "0.4.2-inference-provider-choice.jpg");
    }

    if (wants("account")) {
      // The account panel at rest: balances, any deposit credit not final yet,
      // the one rate line and the linked wallets.
      await openSettings(page, "Inference");
      await page.locator('[data-vex-cloud-balance="reserved"]').filter({ visible: true }).first().scrollIntoViewIfNeeded();
      await page.mouse.move(10, 890);
      await shot(page, "0.4.2-inference-account.jpg");
      await shot(page, "site/site-inference-account.jpg");
    }

    if (wants("deposit")) {
      // Review deposit, capture the card, Reject. Never Approve.
      await openFunding(page, "Deposit");
      const form = page.getByTestId("deposit-form");
      await form.getByRole("textbox").first().fill(DEPOSIT_VEX);
      await page.waitForTimeout(800);
      const review = form.getByRole("button", { name: "Review deposit" });
      if (await review.isDisabled()) {
        const why = (await page.getByTestId("deposit-disabled-reason").textContent()) ?? "";
        skipped(testInfo, "0.4.2-inference-deposit-approval.jpg", `Review deposit is disabled: ${why.trim()}`);
      } else {
        await review.click();
        const reject = page.getByRole("button", { name: "Reject", exact: true });
        await expect(reject).toBeVisible({ timeout: 60_000 });
        await shot(page, "0.4.2-inference-deposit-approval.jpg");
        await reject.click();
        await expect(page.getByTestId("deposit-message")).toHaveText(/Deposit rejected\. Nothing was signed\./);
      }
    }

    if (wants("auto-top-up")) {
      await openFunding(page, "Auto top-up");
      const form = page.getByTestId("rule-form");
      await form.getByLabel(/VEX per top-up/).fill(AUTO_TOP_UP.perTopUp);
      await form.getByLabel(/Most top-ups per 24 hours/).fill(AUTO_TOP_UP.perDay);
      await form.getByLabel(/Cap per 30 days/).fill(AUTO_TOP_UP.cap);
      await form.getByLabel(/Network fee limit/).fill(AUTO_TOP_UP.fee);
      await form.getByLabel(/Expires in days/).fill(AUTO_TOP_UP.days);
      await form.getByRole("button", { name: "Review rule" }).click();
      const reject = page.getByTestId("auto-top-up-tab").getByRole("button", { name: "Reject", exact: true });
      await expect(reject.or(page.getByTestId("rule-form-problem").filter({ hasText: /\S/ })).first()).toBeVisible({ timeout: 60_000 });
      if (await reject.isVisible()) {
        await shot(page, "0.4.2-inference-auto-top-up.jpg");
        await reject.click();
        await expect(page.getByTestId("auto-top-up-message")).toHaveText(/Rejected\. Nothing was changed\./);
      } else {
        const why = (await page.getByTestId("rule-form-problem").textContent()) ?? "";
        skipped(testInfo, "0.4.2-inference-auto-top-up.jpg", `Review rule refused: ${why.trim()}`);
      }
    }

    if (wants("withdraw")) {
      // The cooling shot needs a real withdrawal, created and then cancelled.
      // That path is not scripted: this stage only checks whether the account
      // can make the minimum withdrawal at all, and says why when it cannot.
      await openFunding(page, "Withdraw");
      const panel = page.getByRole("tabpanel");
      const minimum = /minimum \$([0-9.]+)/.exec((await panel.textContent()) ?? "");
      await panel.getByRole("textbox").first().fill(WITHDRAW_PROBE_VEX);
      await page.waitForTimeout(800);
      const review = panel.getByRole("button", { name: "Review withdrawal" });
      const reason = (await panel.textContent()) ?? "";
      const why = /The minimum is .*? VEX\./.exec(reason)?.[0] ?? "the Review withdrawal key is disabled";
      skipped(
        testInfo,
        "0.4.2-inference-withdraw-cooling.jpg",
        (await review.isDisabled())
          ? `the account cannot withdraw (minimum $${minimum?.[1] ?? "?"}): ${why}`
          : "creating and cancelling a real withdrawal is a by-hand step, not scripted here",
      );
    }

    if (wants("chat")) {
      // The one paid composer turn: a one-line prompt on a cheap model.
      await openWelcome(page);
      const box = page.locator("textarea").filter({ visible: true }).first();
      await box.fill(CHAT_PROMPT);
      await box.press("Enter");
      // The first message of a chat opens the New session sheet (mode and
      // permission are locked at creation): the defaults, Agent and Restricted.
      const sheet = page.locator("dialog[open]");
      await page.waitForTimeout(1500);
      if (await sheet.isVisible()) {
        await debugProbe(page, "50-new-session-sheet");
        await sheet.getByRole("button", { name: "Create", exact: true }).click();
        await expect(sheet).toHaveCount(0, { timeout: 30_000 });
      }
      await page.waitForTimeout(2000);
      await debugProbe(page, "51-chat-after-create");
      await expect(page.locator("main, body").getByText(CHAT_PROMPT, { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(3000);
      await expect(page.getByText(/^Thinking$/).filter({ visible: true })).toHaveCount(0, { timeout: 120_000 });
    }

    if (wants("composer")) {
      // Reduced motion holds the composer's rotating placeholder still (read
      // at mount), so the shot never lands mid-crossfade.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await openSettings(page, "Inference");
      await openSession(page);
      const modelKey = page.getByRole("button", { name: /^Model: / }).filter({ visible: true }).first();
      await expect(modelKey).toBeVisible();
      await page.mouse.move(10, 890);
      await page.waitForTimeout(600);
      await shot(page, "site/site-chat-inference.jpg");
      // The provider tooltip, portaled out of the centre column since 0.4.2.
      await modelKey.hover();
      await expect(page.getByRole("tooltip").filter({ visible: true }).first()).toBeVisible({ timeout: 5_000 });
      await shot(page, "0.4.2-composer-provider-mark.jpg");
      await page.mouse.move(10, 890);
      await page.emulateMedia({ reducedMotion: null });
    }

    if (wants("site-models")) {
      await openSettings(page, "Inference");
      const combo = page.locator("#vex-provider-cloud-model").filter({ visible: true }).first();
      const options = page.getByRole("option").filter({ visible: true });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await combo.click();
        await page.waitForTimeout(1500);
        if ((await options.count()) > 0) break;
        const retry = page.getByRole("button", { name: /Retry/ }).filter({ visible: true });
        if (await retry.count()) await retry.first().click();
        await page.keyboard.press("Escape");
        await page.waitForTimeout(5000);
      }
      await expect(options.first()).toBeVisible();
      // The whole list, not the saved model's filter: clear the typed text
      // (form state only, nothing is saved), and bring the picker up the pane.
      await combo.fill("");
      await combo.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(800);
      await shot(page, "site/site-models.jpg");
      await page.keyboard.press("Escape");
    }

    if (wants("site")) {
      await openWelcome(page);
      await shot(page, "site/site-welcome.jpg");
      await pickTheme(page, "chronos");
      await openWelcome(page);
      await shot(page, "site/site-welcome-dark.jpg");
      await pickTheme(page, "celeris");
    }

  } finally {
    await app.close().catch(() => undefined);
  }
});
