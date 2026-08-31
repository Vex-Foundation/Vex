/**
 * Vex Studio, driven through the real UI of the built Electron app.
 *
 * ## What this spec proves
 *
 * One ordered journey in one Electron launch, each step asserting the WORLD
 * rather than a component's self-report:
 *
 *   1. the shell is reached and reports `data-vex-runtime-mode="agent"`;
 *   2. the hero's Studio radio flips the mode on the SAME DOM node that
 *      carries `data-vex-screen="appShell"`, and the Studio sidebar and
 *      welcome mount;
 *   3. the sidebar's New project key opens `ProjectCreator`, whose wallet
 *      fieldset reflects the wallet inventory this config dir really has.
 *
 * ## Two prerequisites, both named in their skip messages
 *
 * REACHING THE SHELL. `useSetupOrchestrator` only hands off to `appShell`
 * after Docker, compose, migrations, the wizard and an unlocked vault. The
 * sanctioned bypass is the diagnostic setup tour, which is baked in at build
 * time by `VITE_VEX_SETUP_TOUR=1` and is absent from a default build (and from
 * every release build). Without it this spec skips and says so; it never
 * pokes the uiStore to fake a route.
 *
 * A DATABASE. Every Studio project operation past the creator's form is
 * DB-backed: `vex.projects.*` goes through `main/database/projects/*`, and
 * `terminalDomain().create` resolves its cwd from `getProject(projectId)`, so
 * no project means no terminal, no explorer, no viewer and no delete. The
 * connection is published exactly once, by the compose handler
 * (`main/ipc/docker.ts` -> `setDbConnection`), so a fixture config dir that
 * never ran compose has no database. Measured in this environment, not
 * assumed: `window.vex.projects.list()` answers
 * `{"ok":false,"error":{"code":"internal.unexpected","message":"Database
 * unavailable. Verify services are running and retry."}}`.
 *
 * The e2e fixture cannot borrow one either. Compose renders a stack keyed by
 * the config dir's install id, and its preflight refuses ports another stack
 * already holds, so a per-run `composeUp` would either collide with the
 * developer's live Vex stack or leave a second Postgres plus embeddings
 * runtime behind after every run. Pointing the fixture at the developer's own
 * config dir would create and delete projects in their real database. Both are
 * decisions above this spec's pay grade.
 *
 * So the journey stops at the database gate. The steps below it - create with
 * on-disk proof, terminal echo and reload-reattach, explorer to viewer, typed
 * name delete - are NOT written here as assertions that have never executed;
 * they are deferred behind the skip, and the tripwire after it fails the day
 * the fixture gains a database, which is the day they must be written.
 */

import { test, expect, type VexElectronFixture } from "./fixtures/electron-app.js";
import type { Page, TestInfo } from "@playwright/test";

/**
 * Console errors this journey tolerates, and nothing else.
 *
 * Chromium reports the renderer's `<meta>` CSP `frame-ancestors` directive as
 * ignored on every load. It is delivered by the same meta tag the build gate
 * checks (`scripts/check-build-artifacts.mjs`), the directive is enforced by
 * main's own window policy, and the message is emitted before any of our code
 * runs, so it is a property of the document rather than of this journey.
 */
const CONSOLE_ERROR_ALLOWLIST: readonly RegExp[] = [
  /'frame-ancestors' is ignored when delivered via a <meta> element/,
];

function isAllowedConsoleError(text: string): boolean {
  return CONSOLE_ERROR_ALLOWLIST.some((pattern) => pattern.test(text));
}

/**
 * Record every console error for the whole journey.
 *
 * Registered before the first navigation of the test body so nothing between
 * here and the final assertion can slip past. Page errors (uncaught
 * exceptions) count too: an unhandled renderer throw never reaches the console
 * error channel.
 */
function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  return errors;
}

/** Screenshot into this run's output dir, and remember it for the report. */
async function shot(
  page: Page,
  testInfo: TestInfo,
  taken: string[],
  name: string,
): Promise<void> {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  taken.push(file);
}

/**
 * Jump to a view through the diagnostic setup tour.
 *
 * Same navigator `qa-screenshots.spec.ts` uses, and the same waiting
 * discipline: the click is followed by the target screen becoming visible, so
 * nothing here waits on a clock.
 */
async function tourTo(page: Page, view: string): Promise<void> {
  const tour = page.locator("[data-vex-setup-tour]");
  await expect(tour).toBeVisible();
  await tour.getByRole("button", { name: view, exact: true }).click();
  await expect(page.locator(`[data-vex-screen="${view}"]`)).toBeVisible();
}

/** What `vex.projects.list` answers right now, through the real bridge. */
async function readProjectsList(
  page: Page,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  return page.evaluate(async () => {
    const bridge = window as unknown as {
      vex: { projects: { list: () => Promise<unknown> } };
    };
    const result = (await bridge.vex.projects.list()) as {
      ok: boolean;
      error?: { code?: string; message?: string };
    };
    return {
      ok: result.ok === true,
      detail: result.ok
        ? "readable"
        : `${result.error?.code ?? "unknown"}: ${result.error?.message ?? ""}`,
    };
  });
}

test("Studio journey: the shell switches to Studio and opens the project creator", async ({
  vexApp,
}: {
  vexApp: VexElectronFixture;
}, testInfo: TestInfo) => {
  // The journey drives a real Electron boot plus several React transitions;
  // the config-wide 30s budget is the smoke test's, not this one's.
  test.setTimeout(120_000);

  const page = vexApp.firstWindow;
  const consoleErrors = collectConsoleErrors(page);
  const screenshots: string[] = [];

  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 });

  // WAIT FOR THE COLD OPEN TO SETTLE, and not because a screenshot needs to
  // look right. `useSetupOrchestrator` routes asynchronously: its probes
  // resolve seconds after first paint and then SET THE VIEW. A tour jump made
  // before that lands is silently undone the moment the handoff arrives, which
  // is exactly how this spec first failed - it was standing in the project
  // creator when the shell went back to systemCheck underneath it.
  //
  // A fresh `VEX_CONFIG_DIR` is a first run, so the settled handoff is
  // systemCheck (the same fact `smoke.spec.ts` pins), and its arrival is the
  // observable state that says the orchestrator is done writing views.
  await expect(page.locator('[data-vex-screen="systemCheck"]')).toBeVisible();
  const tourPresent = (await page.locator("[data-vex-setup-tour]").count()) > 0;
  test.skip(
    !tourPresent,
    "the Studio journey reaches the shell through the diagnostic setup tour, " +
      "which is baked in at build time: rebuild with " +
      "`VITE_VEX_SETUP_TOUR=1 pnpm --dir vex-app build` and rerun",
  );

  /* ---- 1. the shell, in agent mode ---------------------------------- */

  await tourTo(page, "appShell");
  const shell = page.locator('[data-vex-screen="appShell"]');
  await expect(shell).toHaveAttribute("data-vex-runtime-mode", "agent");
  const shellNodeBeforeSwitch = await shell.elementHandle();
  expect(shellNodeBeforeSwitch).not.toBeNull();
  await shot(page, testInfo, screenshots, "01-app-shell-agent");

  /* ---- 2. the hero radio switches the whole shell to Studio ---------- */

  const modeGroup = page.getByRole("radiogroup", { name: "Runtime mode" });
  await expect(modeGroup.getByRole("radio", { name: "Agent" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await modeGroup.getByRole("radio", { name: "Studio" }).click();

  await expect(shell).toHaveAttribute("data-vex-runtime-mode", "studio");
  // Studio is NOT a one-way door: its welcome mounts the SAME runtime-mode
  // capsule the agent hero renders (B4 review blocker 1). The invariant is no
  // longer "the capsule is gone" but "exactly one capsule, owned by the Studio
  // welcome, showing Studio as checked" - a stale hero capsule orphaned behind
  // the Studio columns would double the count and still fails here.
  await expect(modeGroup).toHaveCount(1);
  await expect(
    page
      .locator('[data-vex-area="studio-welcome"]')
      .getByRole("radiogroup", { name: "Runtime mode" }),
  ).toHaveCount(1);
  await expect(modeGroup.getByRole("radio", { name: "Studio" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // The screen attribute did not MOVE to a different element: the mode switch
  // repaints the columns inside one shell rather than mounting a second one.
  // This is what `[data-vex-screen="appShell"]` being a stable e2e selector in
  // both modes actually means, and only node identity can prove it.
  const shellNodeIsUnchanged = await page.evaluate(
    (node) => node === document.querySelector('[data-vex-screen="appShell"]'),
    shellNodeBeforeSwitch,
  );
  expect(shellNodeIsUnchanged).toBe(true);

  await expect(page.locator('[data-vex-area="studio-sidebar"]')).toBeVisible();
  await expect(page.locator('[data-vex-area="studio-welcome"]')).toBeVisible();
  await shot(page, testInfo, screenshots, "02-studio-mode");

  /* ---- 3. the sidebar's New project key opens the creator ------------ */

  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  await sidebar.getByRole("button", { name: "New project" }).click();
  const creator = page.getByRole("dialog", { name: "New project" });
  await expect(creator).toBeVisible();

  const nameField = creator.getByLabel("Name");
  await expect(nameField).toBeFocused();
  const submit = creator.getByRole("button", { name: "Create", exact: true });
  // The name is the only required field: wallets are optional and the submit
  // gate is the trimmed name alone (`ProjectCreator`'s `submitDisabled`).
  await expect(submit).toBeDisabled();
  await nameField.fill(`vex-e2e-${Date.now()}`);
  await expect(submit).toBeEnabled();

  // The wallet fieldset reports the inventory THIS config dir has. A fixture
  // config dir is minted empty and the inventory is read from config, not the
  // database (`lib/api/wallet-inventory.ts`), so both selects offer nothing to
  // pick and the create would legitimately carry `{evm: null, solana: null}`.
  const walletInventory = await page.evaluate(async () => {
    const bridge = window as unknown as {
      vex: { wallets: { listAvailable: (input: object) => Promise<unknown> } };
    };
    const result = (await bridge.vex.wallets.listAvailable({})) as {
      ok: boolean;
      data?: { evm: readonly unknown[]; solana: readonly unknown[] };
    };
    return {
      ok: result.ok === true,
      evm: result.data?.evm.length ?? -1,
      solana: result.data?.solana.length ?? -1,
    };
  });
  expect(walletInventory.ok).toBe(true);
  testInfo.annotations.push({
    type: "wallet-inventory",
    description: `evm=${walletInventory.evm} solana=${walletInventory.solana}`,
  });
  // Through the UI, not only through the bridge: the EVM picker opens and
  // offers exactly the sentinel, which is what an empty inventory looks like
  // to a user. `1 + evm` rather than a hardcoded 1, so this stays true for a
  // fixture that one day seeds wallets.
  const evmPicker = creator.getByRole("combobox", { name: "EVM wallet" });
  await expect(evmPicker).toBeVisible();
  await expect(creator.getByRole("combobox", { name: "Solana wallet" })).toBeVisible();
  await evmPicker.click();
  const evmOptions = page.getByRole("listbox", { name: "EVM wallet" }).getByRole("option");
  await expect(evmOptions).toHaveCount(1 + walletInventory.evm);
  await expect(evmOptions.first()).toHaveText("None");
  await page.keyboard.press("Escape");
  await expect(evmPicker).toHaveAttribute("aria-expanded", "false");
  await shot(page, testInfo, screenshots, "03-project-creator");

  await creator.getByRole("button", { name: "Cancel" }).click();
  await expect(creator).toBeHidden();

  /* ---- what the database actually answers ---------------------------- */

  const projects = await readProjectsList(page);
  testInfo.annotations.push({ type: "projects-list", description: projects.detail });

  if (!projects.ok) {
    // The degraded rail is product behaviour, not an accident, so it is
    // asserted rather than tolerated: an unreadable list says what failed and
    // offers the one action that can fix it, in BOTH places that render the
    // list, and neither pretends the user simply has no projects.
    await expect(sidebar.getByText("Vex could not read your projects.")).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(
      page
        .locator('[data-vex-area="studio-welcome"]')
        .getByText("Vex could not read your projects."),
    ).toBeVisible();
    await shot(page, testInfo, screenshots, "04-projects-unreadable");
  }

  /* ---- console errors, across everything above ----------------------- */

  const unexpected = consoleErrors.filter((text) => !isAllowedConsoleError(text));
  expect(unexpected, `unexpected console errors: ${unexpected.join(" | ")}`).toEqual(
    [],
  );
  testInfo.annotations.push({
    type: "screenshots",
    description: screenshots.join(", "),
  });

  /* ---- the database gate --------------------------------------------- */

  test.skip(
    !projects.ok,
    "the rest of the Studio journey - create a project with on-disk proof, " +
      "echo through a terminal and reattach it across a window reload, open a " +
      "written file in the viewer, and delete through the typed-name dialog - " +
      "needs a Postgres for `vex.projects.*`, which only " +
      "`vex.docker.composeUp` publishes (main/ipc/docker.ts -> " +
      `setDbConnection). This run got "${projects.detail}" from ` +
      "`vex.projects.list`.",
  );

  // Reached only when a fixture DOES give the e2e app a database. That is the
  // moment the deferred arm above stops being unwritable, so it fails here
  // rather than passing while covering nothing.
  throw new Error(
    "`vex.projects.list` is readable in this environment, so the deferred " +
      "Studio project lifecycle (create, terminal, viewer, delete) is now " +
      "runnable and must be implemented in this spec. See the file header.",
  );
});
