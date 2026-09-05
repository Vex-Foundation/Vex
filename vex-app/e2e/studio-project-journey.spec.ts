/**
 * THE CREATE -> OPEN JOURNEY, against a real database.
 *
 * This is the path the blank-window bug came through and the one
 * `studio.spec.ts` has always stopped short of: everything past the creator's
 * form is DB-backed, and until the isolated stack existed there was no database
 * an e2e run could legitimately use. `fixtures/vex-app-with-database.ts` gives
 * one - a throwaway Postgres, a throwaway config dir and projects root, the
 * built app launched against them through the e2e door, and the schema migrated
 * by the PRODUCT's own `vex.database.migrate` - so the journey can finally
 * assert the world:
 *
 *   1. the migration the app itself applied;
 *   2. a project created through the real UI, whose report is VISIBLE (a
 *      Playwright visibility check, not a DOM-presence one: the defect this
 *      journey guards is a report painted below the fold of a scrolling
 *      dialog);
 *   3. the files that create actually rendered, read back through
 *      `vex.projects.list` - `.mcp.json` for Claude Code, `current` on disk;
 *   4. the project OPENED, its first terminal auto-appearing, and the shell
 *      still painting content rather than the blank window.
 *
 * ## Two prerequisites, both named where they fail
 *
 * THE SETUP TOUR, exactly as `studio.spec.ts` documents it: the shell is
 * reached through the diagnostic tour, which is baked in at build time by
 * `VITE_VEX_SETUP_TOUR=1`. Without it this spec skips, unless the run declared
 * Studio coverage with `VEX_E2E_REQUIRE_TOUR=1`, in which case it fails.
 *
 * THE BRIDGE BINARY. `main/studio/installer.ts` refuses to write a single file
 * when it cannot locate the bridge program its configs point at, and reports
 * `bridge_unavailable` as the run's headline. That is honest product behaviour
 * and it is NOT what this journey is testing, so a build without
 * `pnpm run build:bridge:dev` fails here with that instruction rather than
 * asserting a report about a missing binary.
 */

import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { Page, TestInfo } from "@playwright/test";
import { test, expect, type VexDatabaseFixture } from "./fixtures/vex-app-with-database.js";
import { tourIsPresent, tourTo, TOUR_SKIP_REASON } from "./fixtures/studio-shell.js";

/**
 * The one console error every load emits, from the renderer's own `<meta>` CSP.
 * Copied deliberately rather than shared: an allowlist that grows by import is
 * an allowlist nobody reviews.
 */
const CONSOLE_ERROR_ALLOWLIST: readonly RegExp[] = [
  /'frame-ancestors' is ignored when delivered via a <meta> element/,
  /Applying inline style violates the following Content Security Policy directive 'style-src 'self''/,
];

/**
 * A KNOWN, UNFIXED DEFECT this journey is the first thing to observe, and the
 * reason the allowlist above carries a second entry.
 *
 * Opening a terminal emits a burst of `style-src 'self'` violations: xterm sets
 * inline styles on the elements it renders, `src/renderer/index.html` ships
 * `style-src 'self'` with no hash and no nonce, and Chromium BLOCKS each one.
 * It is a property of the shipped renderer CSP plus the terminal component, not
 * of anything this spec does, and it is out of this spec's scope to fix.
 *
 * So it is tolerated LOUDLY rather than silently: the count is annotated on
 * every run, and a run that stops producing them is a fix worth noticing.
 */
const CSP_INLINE_STYLE = /Applying inline style violates/;

/** What `vex.projects.list` answers, projected to what this journey asserts on. */
interface ProjectFilesReadback {
  readonly ok: boolean;
  readonly detail: string;
  readonly artifacts: ReadonlyArray<{
    readonly kind: string;
    readonly path: string | null;
    readonly state: string;
  }>;
  readonly lastRenderedScopeVersion: number | null;
  /** The project's directory name under the projects root. */
  readonly rootPath: string | null;
}

/** Does this path exist? Asked without creating, removing or opening anything. */
async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

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

async function shot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

/** Read one project's file status back through the real bridge. */
async function readProjectFiles(
  page: Page,
  projectName: string,
): Promise<ProjectFilesReadback> {
  return page.evaluate(async (name: string) => {
    const bridge = window as unknown as {
      vex: { projects: { list: () => Promise<unknown> } };
    };
    const result = (await bridge.vex.projects.list()) as {
      ok: boolean;
      error?: { code?: string; message?: string };
      data?: ReadonlyArray<{
        name: string;
        rootPath: string;
        files: {
          lastRenderedScopeVersion: number | null;
          artifacts: ReadonlyArray<{
            kind: string;
            path: string | null;
            state: string;
          }>;
        };
      }>;
    };
    if (!result.ok) {
      return {
        ok: false,
        detail: `${result.error?.code ?? "unknown"}: ${result.error?.message ?? ""}`,
        artifacts: [],
        lastRenderedScopeVersion: null,
        rootPath: null,
      };
    }
    const row = result.data?.find((project) => project.name === name);
    if (row === undefined) {
      return {
        ok: true,
        detail: `no row named ${name}`,
        artifacts: [],
        lastRenderedScopeVersion: null,
        rootPath: null,
      };
    }
    return {
      ok: true,
      detail: "readable",
      artifacts: row.files.artifacts.map((artifact) => ({
        kind: artifact.kind,
        path: artifact.path,
        state: artifact.state,
      })),
      lastRenderedScopeVersion: row.files.lastRenderedScopeVersion,
      rootPath: row.rootPath,
    };
  }, projectName);
}

test("Studio journey: create a project, see its report, open it and get a terminal", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  // A container start, an Electron boot, a migration, a render onto disk and a
  // real pty. The suite's 30s budget is the smoke test's, not this one's.
  test.setTimeout(180_000);

  const page = vexDb.shell;
  const consoleErrors = collectConsoleErrors(page);

  /* ---- 1. the schema the APP applied --------------------------------- */

  // The fixture already fails the run when this is not ok; asserted here too so
  // the spec states its own precondition rather than inheriting it silently.
  expect(vexDb.migrated.ok).toBe(true);
  if (vexDb.migrated.ok) {
    expect(["applied", "noop"]).toContain(vexDb.migrated.data.kind);
  }

  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('[data-vex-screen="systemCheck"]')).toBeVisible();

  test.skip(!(await tourIsPresent(page)), TOUR_SKIP_REASON);

  /* ---- 2. Studio, and the creator ------------------------------------ */

  await tourTo(page, "appShell");
  const shell = page.locator('[data-vex-screen="appShell"]');
  // The page-wide locator resolves to the ONE capsule: on the agent welcome
  // it sits under the vex wordmark (owner decree 2026-09-04).
  await page
    .getByRole("radiogroup", { name: "Runtime mode" })
    .getByRole("radio", { name: "Studio" })
    .click();
  await expect(shell).toHaveAttribute("data-vex-runtime-mode", "studio");

  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  await expect(sidebar).toBeVisible();
  // The list is READABLE now, which is the whole point of this fixture and the
  // condition `studio.spec.ts` defers its own lifecycle arm behind.
  await expect(
    sidebar.getByText("Vex could not read your projects."),
  ).toHaveCount(0);

  await sidebar.getByRole("button", { name: "New project" }).click();
  const creator = page.getByRole("dialog", { name: "New project" });
  await expect(creator).toBeVisible();

  const projectName = `vex-e2e-${Date.now().toString(36)}`;
  await creator.getByLabel("Name").fill(projectName);
  // Claude Code so the render has a project-scoped config to write: its
  // `configPath` is `.mcp.json` (`src/vex-agent/studio/agents.ts`).
  //
  // Clicked on the CARD, which is what a user clicks: the checkbox itself is
  // `sr-only`, so driving the input directly would be driving a node no pointer
  // can reach. The `toBeChecked` below is the proof the label/input pairing
  // actually works.
  await creator.locator('[data-vex-agent="claude-code"]').click();
  await expect(creator.getByRole("checkbox", { name: /Claude Code/ })).toBeChecked();
  // The picker renders only agents Vex can integrate (owner decision
  // 2026-09-01), so the cards the catalogue marks unsupported are absent.
  await expect(creator.getByRole("checkbox", { name: /Cline/ })).toHaveCount(0);
  await expect(creator.getByRole("checkbox", { name: /Warp/ })).toHaveCount(0);

  await creator.getByRole("button", { name: "Create", exact: true }).click();

  /* ---- 3. the report, VISIBLE ---------------------------------------- */

  // The assertion jsdom cannot make. `toBeVisible` is a real layout check, so a
  // report mounted below the fold of the scrolling body - which is exactly how
  // this shipped - fails here even though the node exists.
  const pinned = creator.locator("[data-vex-dialog-pinned]");
  await expect(pinned).toBeVisible();
  const report = pinned.locator("[data-vex-render-outcome]");
  await expect(report).toBeVisible();
  // The Close button is the other half of the invariant: the pinned slot bounds
  // itself, so the footer keeps its seat whatever the report's length.
  const close = creator.getByRole("button", { name: "Close" });
  await expect(close).toBeVisible();

  const runFailure = await report.getAttribute("data-vex-run-failure");
  expect(
    runFailure,
    "the render reported a run failure; `bridge_unavailable` means this build " +
      "has no bridge binary - run `pnpm --dir vex-app run build:bridge:dev` " +
      "before the e2e build",
  ).toBeNull();
  await shot(page, testInfo, "01-create-report");

  /* ---- 4. what is actually on disk, per the DTO ---------------------- */

  const files = await readProjectFiles(page, projectName);
  testInfo.annotations.push({
    type: "project-files",
    description: `${files.detail} artifacts=${JSON.stringify(files.artifacts)}`,
  });
  expect(files.ok).toBe(true);
  expect(files.lastRenderedScopeVersion).not.toBeNull();
  expect(files.artifacts).toContainEqual({
    kind: "agent-config",
    path: ".mcp.json",
    state: "current",
  });
  // THE FILE VEX JUST WROTE IS NOT REPORTED AS OUT OF DATE. `AGENTS.md` carries
  // its own change log inside the hashed managed block, and the drift check
  // re-renders that block from the stored change notes; when the two disagreed,
  // every freshly created project wore the warning badge from its first second
  // and the badge stopped meaning anything.
  expect(files.artifacts).toContainEqual({
    kind: "agents-md",
    path: "AGENTS.md",
    state: "current",
  });

  /* ---- 4b. and it is inside THIS RUN's projects root ------------------ */

  // The isolation this fixture promises, asserted on the filesystem instead of
  // assumed. The stack writes `projectsRoot` into its throwaway `config.json`,
  // but a document the app's config owner rejects (it requires `version: 1`)
  // is discarded whole, and every run then created REAL project folders in the
  // developer's `~/Vex/projects`. Six of them survived before this assertion
  // existed. The spec now proves both halves: the folder is where the run said
  // it would be, and it is not in the default root.
  expect(files.rootPath).not.toBeNull();
  const rootPath = files.rootPath ?? "";
  const isolatedProject = path.join(vexDb.stack.projectsRoot, rootPath);
  expect(
    await exists(path.join(isolatedProject, "AGENTS.md")),
    `the project's files are not under this run's projects root ` +
      `(${vexDb.stack.projectsRoot} holds ${JSON.stringify(
        await readdir(vexDb.stack.projectsRoot),
      )})`,
  ).toBe(true);
  expect(
    await exists(path.join(homedir(), "Vex", "projects", rootPath)),
    "the run created a project folder in the developer's real ~/Vex/projects",
  ).toBe(false);

  await close.click();
  await expect(creator).toBeHidden();

  /* ---- 5. open it, and get a terminal -------------------------------- */

  // The ROW, not the row's action menu: both carry the project name in their
  // accessible name, and the row's is its whole content, so it also carries the
  // permission pill.
  const row = sidebar.getByRole("button", {
    name: `${projectName} restricted`,
  });
  await expect(row).toBeVisible();
  await row.click();

  const center = page.locator('[data-vex-area="studio-center"]');
  await expect(center).toBeVisible();
  // The first terminal is opened FOR the user by the workspace controller; the
  // tab is the observable proof a pty was created and attached.
  const tabs = center.getByRole("tablist", { name: "Studio terminals and files" });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("tab").first()).toBeVisible();

  // NOT A BLANK WINDOW: the shell is still painting, the centre column has real
  // size, and the welcome column has been replaced by the workspace.
  const box = await center.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(200);
  expect(box?.height ?? 0).toBeGreaterThan(200);
  await expect(page.locator('[data-vex-area="studio-welcome"]')).toHaveCount(0);
  // The welcome took its capsule with it and the rail header now carries the
  // one copy: the way back to Agent survives the project opening.
  await expect(
    page
      .locator('[data-vex-area="studio-sidebar"]')
      .getByRole("radiogroup", { name: "Runtime mode" }),
  ).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Runtime mode" })).toHaveCount(1);
  await shot(page, testInfo, "02-project-open");

  /* ---- console errors, across the whole journey ---------------------- */

  const unexpected = consoleErrors.filter(
    (text) => !CONSOLE_ERROR_ALLOWLIST.some((pattern) => pattern.test(text)),
  );
  expect(unexpected, `unexpected console errors: ${unexpected.join(" | ")}`).toEqual(
    [],
  );
  testInfo.annotations.push({
    type: "csp-inline-style-violations",
    description: String(
      consoleErrors.filter((text) => CSP_INLINE_STYLE.test(text)).length,
    ),
  });
});
