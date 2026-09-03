/**
 * Vex Studio, driven through the real UI of the built Electron app.
 *
 * ## What this spec proves
 *
 * One ordered journey in one Electron launch, each step asserting the WORLD
 * rather than a component's self-report:
 *
 *   1. the shell is reached and reports `data-vex-runtime-mode="agent"`;
 *   2. the rail header's Studio radio flips the mode on the SAME DOM node that
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
 * A SKIP IS ONLY HONEST WHERE NOBODY PROMISED COVERAGE. In CI the Studio
 * journey is a required gate, so the runner declares that promise with
 * `VEX_E2E_REQUIRE_TOUR=1` on the TEST step, paired with `VITE_VEX_SETUP_TOUR=1`
 * on the BUILD step (`.github/workflows/ci.yml`, job `vex-app-e2e`). With that
 * expectation set, a missing tour FAILS here instead of skipping: otherwise
 * deleting one line from the build step would restore zero Studio coverage
 * while the required gate stayed green. Local runs that set neither flag keep
 * the named skip below.
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
 * So this journey stops at the database gate, and the DB-backed half now has
 * its own spec and its own fixture: `e2e/studio-project-journey.spec.ts` runs
 * create-with-on-disk-proof and open-with-a-terminal against the isolated stack
 * in `e2e/fixtures/vex-app-with-database.ts`. What stays here is exactly what
 * needs no database - the shell, the mode switch, the creator's form, and the
 * degraded rail an unreadable list must produce - which is why the tripwire
 * that used to guard the gap is discharged at the bottom of this file rather
 * than still throwing.
 */

import { test, expect, type VexElectronFixture } from "./fixtures/electron-app.js";
import type { Page, TestInfo } from "@playwright/test";

/**
 * Does this run PROMISE Studio coverage?
 *
 * Set by the CI test step alongside the build step's `VITE_VEX_SETUP_TOUR=1`.
 * Read once, at module scope, so the expectation is a property of the run
 * rather than something the journey could reinterpret mid-flight.
 */
const TOUR_REQUIRED = process.env.VEX_E2E_REQUIRE_TOUR === "1";

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
  if (TOUR_REQUIRED && !tourPresent) {
    // FAIL, never skip: this run declared that it covers the Studio journey.
    throw new Error(
      "VEX_E2E_REQUIRE_TOUR=1 declares this run must cover the Studio journey, " +
        "but the built bundle renders no `[data-vex-setup-tour]`, so it was " +
        "built without `VITE_VEX_SETUP_TOUR=1`. Those two flags are a pair: " +
        "`VITE_VEX_SETUP_TOUR=1` on the build step and `VEX_E2E_REQUIRE_TOUR=1` " +
        "on the test step of job `vex-app-e2e` in `.github/workflows/ci.yml`. " +
        "Losing either one would otherwise turn this required gate into a " +
        "silent skip that proves nothing about Studio. Rebuild with " +
        "`VITE_VEX_SETUP_TOUR=1 pnpm --dir vex-app build` and rerun.",
    );
  }
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

  /* ---- 2. the rail header's radio switches the whole shell to Studio -- */

  const modeGroup = page.getByRole("radiogroup", { name: "Runtime mode" });
  await expect(modeGroup.getByRole("radio", { name: "Agent" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await modeGroup.getByRole("radio", { name: "Studio" }).click();

  await expect(shell).toHaveAttribute("data-vex-runtime-mode", "studio");
  // Studio is NOT a one-way door, and the capsule has exactly ONE home: the
  // rail header, visible on every Studio screen. The invariant is "exactly one
  // capsule on the page, showing Studio as checked" - a stale agent-rail
  // capsule orphaned behind the Studio columns, or a second one on the welcome, would
  // double the count and fail here (the welcome carries a plain button back).
  await expect(modeGroup).toHaveCount(1);
  const studioWelcome = page.locator('[data-vex-area="studio-welcome"]');
  await expect(studioWelcome.getByRole("radiogroup", { name: "Runtime mode" })).toHaveCount(0);
  await expect(studioWelcome.getByRole("button", { name: "Back to Agent mode" })).toHaveCount(1);
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
  // Through the UI, not only through the bridge. An EMPTY inventory is no
  // longer a picker whose only option is "None": the creator names the path to
  // add a wallet instead (audit finding I12), so the assertion follows the
  // inventory the bridge reported rather than assuming the picker exists.
  if (walletInventory.evm + walletInventory.solana === 0) {
    await expect(creator.getByText("No wallets yet.")).toBeVisible();
    await expect(creator.getByText("Add one in Settings, under Wallets.")).toBeVisible();
    await expect(creator.getByRole("combobox", { name: "EVM wallet" })).toHaveCount(0);
    await expect(creator.getByRole("combobox", { name: "Solana wallet" })).toHaveCount(0);
  } else {
    const evmPicker = creator.getByRole("combobox", { name: "EVM wallet" });
    await expect(evmPicker).toBeVisible();
    await expect(creator.getByRole("combobox", { name: "Solana wallet" })).toBeVisible();
    await evmPicker.click();
    const evmOptions = page.getByRole("listbox", { name: "EVM wallet" }).getByRole("option");
    await expect(evmOptions).toHaveCount(1 + walletInventory.evm);
    await expect(evmOptions.first()).toHaveText("None");
    await page.keyboard.press("Escape");
    await expect(evmPicker).toHaveAttribute("aria-expanded", "false");
  }
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

  /* ---- the database gate, DISCHARGED --------------------------------- */

  // This is where the tripwire stood, and this is what happened to it.
  //
  // It was a `throw` for one reason: the day a fixture gave the e2e app a
  // database, the deferred lifecycle stopped being unwritable and had to be
  // WRITTEN rather than left passing while covering nothing. That day has
  // arrived - `e2e/fixtures/vex-app-with-database.ts` starts an isolated
  // Postgres and migrates it through the product's own `vex.database.migrate` -
  // and the lifecycle now lives in `e2e/studio-project-journey.spec.ts`: create
  // with on-disk proof read back from `vex.projects.list`, the render report
  // asserted VISIBLE rather than merely present, the project opened, and its
  // first terminal.
  //
  // THIS spec keeps the scope it actually covers, which is the shell WITHOUT a
  // database: the mode switch, the creator's form and wallet inventory, and the
  // degraded rail an unreadable list must produce. Its fixture mints a bare
  // config dir and never runs compose, so `projects.ok` stays false here; if a
  // future change gives this fixture a database, the arm above simply stops
  // running and the annotation below says so.
  testInfo.annotations.push({
    type: "database",
    description: projects.ok
      ? "readable; the DB-backed lifecycle runs in studio-project-journey.spec.ts"
      : `unreadable (${projects.detail}); the degraded rail was asserted above`,
  });
});
