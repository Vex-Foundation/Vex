/**
 * APV-1: the `AWAITING n` badge, DECIDED IN A REAL WINDOW while Studio is the
 * runtime mode.
 *
 * ## The finding this exists to settle
 *
 * The live pass of 2026-09-03 reported the global approvals badge INERT in
 * Studio: the pin was on screen and clicking it appeared to do nothing. No
 * mechanism was found by reading - the React tree mounts one `GlobalApprovals`
 * for the whole frame regardless of mode (`ShellStatusStrip.tsx`), the panel is
 * a plain anchored div with no portal, and nothing in the Studio columns
 * declares a stacking context over the strip. That is exactly the class of
 * claim jsdom cannot settle: a component test proves the click handler runs,
 * and PAINT, STACKING and HIT-TESTING are not modelled at all. Only a real
 * compositor can answer "is the pixel under this badge the badge".
 *
 * ## What this walk asserts, and why each part is load-bearing
 *
 *   - `document.elementFromPoint` at the badge's own centre resolves to the
 *     badge (or a child of it). This is the direct reproducer for "inert": a
 *     covering element would show up here as SOMETHING ELSE, and the failure
 *     message names the whole stack at that point so the covering surface is
 *     identified rather than guessed at.
 *   - Playwright's own click is the second hit test, and it is not redundant:
 *     it waits for the element to be stable and enabled and then verifies the
 *     hit target BEFORE dispatching, so a badge covered by a transparent
 *     overlay fails here with the intercepting element named, where a
 *     `dispatchEvent` would sail straight through and prove nothing.
 *   - the card's Reject passes a TRIAL click - every actionability check, no
 *     event - which is the same question asked of the control the user has to
 *     reach INSIDE the opened panel. The panel is anchored inside a column that
 *     sets `overflow-hidden`, so "the badge opens" and "the decision is
 *     reachable" are two different facts.
 *   - the decision then really is made: the seeded row settles to `rejected` in
 *     BOTH tables, read back over a second connection, and the badge leaves the
 *     strip. A rejection that only removes a row from a list would be a UI
 *     animation; the database is the world.
 *
 * The pattern is VS Code's smoke suite (`test/smoke/src/areas/terminal/
 * terminal.test.ts` plus the automation surface it drives,
 * `test/automation/src/terminal.ts`): drive the real window, wait on an
 * observable predicate rather than a sleep, and assert what a user could see.
 * What is deliberately NOT copied is its `this.retries(3)` - a badge that needs
 * three attempts to be clickable is the defect this walk is looking for.
 *
 * ## The approval is SEEDED, and that is the honest bound
 *
 * Nothing in the product lets a renderer raise an approval, and nothing should
 * (rule 09: the model proposes, it never authorizes). So the row is written
 * straight into the run's throwaway Postgres in the engine's own shape
 * (`fixtures/approvals-seed.ts`). What this walk therefore does NOT prove is
 * the enqueue path; what it does prove is everything downstream of a pending
 * row: the read handler, the DTO, the badge, the panel, hit-testing, the
 * two-step confirm, the reject IPC, the origin-aware settlement, and the
 * refresh.
 */

import type { Locator, TestInfo } from "@playwright/test";

import { test, expect, type VexDatabaseFixture } from "./fixtures/vex-app-with-database.js";
import { enterStudio, TOUR_SKIP_REASON } from "./fixtures/studio-shell.js";
import {
  type ApprovalSettlement,
  readApprovalSettlement,
  readProjectRow,
  seedPendingStudioApproval,
  withStackDatabase,
} from "./fixtures/approvals-seed.js";

/** One point probe: what is actually painted at the centre of a control. */
interface HitProbe {
  readonly point: { readonly x: number; readonly y: number };
  readonly size: { readonly width: number; readonly height: number };
  /** Is the topmost element at that point the control itself, or inside it? */
  readonly hitsTarget: boolean;
  /** The topmost element there, described. */
  readonly topMost: string;
  /** Every element at that point, front to back - the covering surface, named. */
  readonly stack: readonly string[];
}

/**
 * Ask the compositor what is at the centre of `locator`.
 *
 * `elementsFromPoint` rather than only `elementFromPoint`: when the answer is
 * "something else", the useful report is the whole stack, because the covering
 * surface is the finding.
 */
async function probeCentre(locator: Locator): Promise<HitProbe> {
  return locator.evaluate((node: Element): HitProbe => {
    const describe = (element: Element | null): string => {
      if (element === null) return "<nothing>";
      const area = element.closest("[data-vex-area]");
      const areaName = area === null ? "" : ` area=${area.getAttribute("data-vex-area") ?? ""}`;
      const id = element.id === "" ? "" : `#${element.id}`;
      const label = element.getAttribute("aria-label");
      const labelPart = label === null ? "" : ` aria-label=${JSON.stringify(label)}`;
      return `${element.tagName.toLowerCase()}${id}${labelPart}${areaName}`;
    };
    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const topMost = document.elementFromPoint(x, y);
    return {
      point: { x, y },
      size: { width: rect.width, height: rect.height },
      hitsTarget: topMost !== null && (topMost === node || node.contains(topMost)),
      topMost: describe(topMost),
      stack: document.elementsFromPoint(x, y).map(describe),
    };
  });
}

/** One line for the report, whichever way the probe went. */
function describeProbe(what: string, probe: HitProbe): string {
  return (
    `${what}: ${probe.size.width}x${probe.size.height} at ` +
    `(${Math.round(probe.point.x)},${Math.round(probe.point.y)}); ` +
    `topmost=${probe.topMost}; hitsTarget=${String(probe.hitsTarget)}; ` +
    `stack=[${probe.stack.join(" | ")}]`
  );
}

test("APV-1 approvals badge in Studio: the pin is hit-testable, opens, and the decision lands", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const page = vexDb.shell;
  const reached = await enterStudio(page);
  test.skip(!reached, TOUR_SKIP_REASON);

  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  await expect(sidebar).toBeVisible();

  /* ---- a real project, created through the real creator ---------------- */

  // Created rather than inserted: `approval_intents.project_id` and
  // `session_id` both reference rows only the create path mints, and a project
  // written by hand would be a project no product code ever produced.
  const projectName = `vex-apv1-${Date.now().toString(36)}`;
  await sidebar.getByRole("button", { name: "New project" }).click();
  const creator = page.getByRole("dialog", { name: "New project" });
  await expect(creator).toBeVisible();
  await creator.getByLabel("Name").fill(projectName);
  await creator.locator('[data-vex-agent="claude-code"]').click();
  await creator.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: /Done|Close/ }).first().click();
  await expect(creator).toBeHidden();

  // OPEN IT, so the badge is measured over the Studio WORKSPACE - the columns
  // the live pass was looking at - and not over the welcome screen.
  await sidebar.getByRole("button", { name: new RegExp(projectName) }).first().click();
  const centre = page.locator('[data-vex-area="studio-center"]');
  await expect(centre.getByRole("tablist", { name: "Studio terminals and files" }))
    .toBeVisible({ timeout: 60_000 });

  /* ---- one pending approval, in the shape the engine writes ------------ */

  const approvalId = await withStackDatabase(vexDb.stack, async (client) => {
    const project = await readProjectRow(client, projectName);
    return seedPendingStudioApproval(client, {
      project,
      toolName: "wallet.transfer",
      requestedByClient: "vex-e2e-probe",
      criticalArgs: { to: "0x00000000000000000000000000000000000000a1", amount: "1.5 ETH" },
    });
  });

  // RELOAD RATHER THAN WAIT. The badge's own freshness net is a 60s idle poll
  // plus an `approval_enqueued` push, and a row written behind the app's back
  // emits no push. A reload is the deterministic way to reach the state that
  // matters here - "the user opens Studio and an approval is already pending" -
  // without spending a minute of wall clock proving a poll interval this walk
  // is not about.
  await page.reload();
  const reachedAgain = await enterStudio(page);
  expect(reachedAgain, "the tour vanished between the first load and the reload").toBe(true);
  await sidebar.getByRole("button", { name: new RegExp(projectName) }).first().click();
  await expect(centre.getByRole("tablist", { name: "Studio terminals and files" }))
    .toBeVisible({ timeout: 60_000 });

  /* ---- 1: the badge is on screen, and says what it holds --------------- */

  const badge = page.locator('[data-vex-area="global-approvals-badge"]');
  await expect(badge).toBeVisible({ timeout: 60_000 });
  await expect(badge).toHaveText(/AWAITING\s+1/);
  await expect(badge).toHaveAttribute(
    "aria-label",
    "1 pending approval awaiting your signature",
  );
  await expect(badge).toHaveAttribute("aria-expanded", "false");

  /* ---- 2: THE HIT TEST, before anything is clicked --------------------- */

  const badgeProbe = await probeCentre(badge);
  testInfo.annotations.push({
    type: "apv1-hit-test",
    description: describeProbe("badge", badgeProbe),
  });
  expect(
    badgeProbe.hitsTarget,
    `the pixel at the badge's centre is not the badge - ${describeProbe("badge", badgeProbe)}`,
  ).toBe(true);

  /* ---- 3: a real click opens the panel --------------------------------- */

  // Playwright's own actionability + hit-target check runs here; an element
  // intercepting the pointer fails this line by name.
  await badge.click();
  const panel = page.locator('[data-vex-area="global-approvals-panel"]');
  await expect(panel).toBeVisible();
  await expect(badge).toHaveAttribute("aria-expanded", "true");

  const card = panel.locator(`[data-approval-id="${approvalId}"]`);
  await expect(card).toBeVisible();
  // The provenance a Studio approval must carry: WHICH project asked.
  await expect(
    panel.locator('[data-vex-area="approval-project-tag"]'),
  ).toContainText(projectName);

  /* ---- 4: the decision is REACHABLE, not merely present ---------------- */

  const reject = card.getByRole("button", { name: "Reject", exact: true });
  await expect(reject).toBeVisible();
  await expect(reject).toBeEnabled();
  // The panel moves focus onto the safer action on open (rule 08), so this is
  // also the proof that the keyboard user lands on Reject and not on a
  // container.
  await expect(reject).toBeFocused();

  const rejectProbe = await probeCentre(reject);
  testInfo.annotations.push({
    type: "apv1-hit-test",
    description: describeProbe("reject", rejectProbe),
  });
  expect(
    rejectProbe.hitsTarget,
    `the pixel at Reject's centre is not the button - ${describeProbe("reject", rejectProbe)}`,
  ).toBe(true);
  // EVERY ACTIONABILITY CHECK, NO EVENT: visible, stable, receives pointer
  // events, enabled. A trial click is the strongest statement about
  // reachability that does not also decide the approval.
  await reject.click({ trial: true });

  /* ---- 5: the two-step confirm, then the decision ---------------------- */

  // A `user_wallet_broadcast` at `high` risk is high-risk by both rules
  // (`ApprovalCard/risk.ts`), so ONE click may never decide it.
  await reject.click();
  const confirmReject = card.getByRole("button", { name: "Confirm reject" });
  await expect(confirmReject).toBeVisible();
  await expect(confirmReject).toHaveText("Click again to confirm reject");
  await confirmReject.click();

  /* ---- 6: the row settles - in the database, and on the strip ---------- */

  const readSettlement = (): Promise<ApprovalSettlement> =>
    withStackDatabase(vexDb.stack, (client) =>
      readApprovalSettlement(client, approvalId),
    );
  await expect
    .poll(async () => (await readSettlement()).decision, {
      timeout: 60_000,
      message: "the rejected approval never settled in the database",
    })
    .toBe("rejected");
  const settlement = await readSettlement();
  expect(settlement.queueStatus).toBe("rejected");
  expect(settlement.resolvedAt).not.toBeNull();
  // NOT DISPATCHED: a rejection settles a call that never ran, so the execution
  // lifecycle must still read `not_started`.
  expect(settlement.executionStatus).toBe("not_started");
  testInfo.annotations.push({
    type: "apv1-settlement",
    description: JSON.stringify(settlement),
  });

  // The strip empties: with nothing pending, `GlobalApprovals` renders null.
  await expect(badge).toHaveCount(0, { timeout: 60_000 });
  await expect(panel).toHaveCount(0);
});
