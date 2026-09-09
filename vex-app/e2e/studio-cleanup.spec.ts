import { test, expect } from "./fixtures/vex-app-with-database.js";
import { enterStudio, openFirstProjectWithATerminal, TOUR_SKIP_REASON } from "./fixtures/studio-shell.js";
import type { ProjectsBridge } from "../src/shared/types/bridge/agent/projects.js";

test("pending cleanup stays in the rail and leaves terminal and dialog geometry unchanged", async ({ vexDb }, testInfo) => {
  test.setTimeout(300000);
  const page = vexDb.shell;
  test.skip(!await enterStudio(page), TOUR_SKIP_REASON);
  await openFirstProjectWithATerminal(page, "cleanup-layout-");
  const center = page.locator('[data-vex-area="studio-center"]');
  const terminal = page.locator(".vex-terminal-surface--active");
  const centerBefore = await center.boundingBox();
  const terminalBefore = await terminal.boundingBox();
  const rail = page.locator('[data-vex-rail-pane="projects"]');
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await dialog.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); });
  const dialogBefore = await dialog.boundingBox();
  // Only the OS boundary refuses. Tombstone, persistence, preload and rail query stay real.
  await vexDb.app.evaluate(({ shell }) => {
    shell.trashItem = async () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); };
  });
  await page.evaluate(async () => {
    function isProjectsBridge(value: unknown): value is Pick<ProjectsBridge, "create" | "list" | "delete"> {
      return typeof value === "object" && value !== null
        && "create" in value && typeof value.create === "function"
        && "list" in value && typeof value.list === "function"
        && "delete" in value && typeof value.delete === "function";
    }
    if (!("vex" in window) || typeof window.vex !== "object" || window.vex === null
      || !("projects" in window.vex) || !isProjectsBridge(window.vex.projects)) throw new Error("Projects bridge missing");
    const bridge = window.vex.projects;
    const created = await bridge.create({ name: "Pending cleanup example", permission: "restricted", agents: [], wallets: { evm: null, solana: null } });
    if (!created.ok) throw new Error(created.error.message);
    const listed = await bridge.list();
    if (!listed.ok) throw new Error(listed.error.message);
    const project = listed.data.find((item) => item.name === "Pending cleanup example");
    if (!project) throw new Error("Created project missing");
    const deleted = await bridge.delete({ projectId: project.id, expectedName: project.name, alsoTrashFolder: true });
    if (!deleted.ok || deleted.data.outcome !== "cleanup_pending") throw new Error("Expected durable cleanup obligation");
  });
  const notice = rail.getByRole("status", { name: "Pending cleanup for Pending cleanup example" });
  await expect(notice).toBeVisible({ timeout: 45000 });
  expect(await center.boundingBox()).toEqual(centerBefore);
  expect(await terminal.boundingBox()).toEqual(terminalBefore);
  expect(await dialog.boundingBox()).toEqual(dialogBefore);
  await expect(center.getByLabel("Unfinished project cleanups")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const disclosure = notice.getByRole("button", { name: /Pending cleanup example.*Pending cleanup/ });
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await notice.locator(".vex-disclosure-body").evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); });
  await expect(notice.locator(".vex-disclosure-body")).toHaveCSS("opacity", "1");
  await expect(notice.getByText(/Another program is using this folder/)).toBeVisible();
  const retry = notice.getByRole("button", { name: "Retry cleanup for Pending cleanup example" });
  await page.keyboard.press("Tab");
  await expect(retry).toBeFocused();
  await expect(retry).toBeVisible();
  expect(await terminal.boundingBox()).toEqual(terminalBefore);
  await page.screenshot({ path: testInfo.outputPath("cleanup-rail.png") });
});
