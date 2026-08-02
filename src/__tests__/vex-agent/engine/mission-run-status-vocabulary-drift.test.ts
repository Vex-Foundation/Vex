/**
 * MISSION RUN STATUS — CROSS-PACKAGE VOCABULARY DRIFT GUARD (contract C3b).
 *
 * `MISSION_RUN_STATUSES` in `engine/types.ts` is the single source of truth,
 * but it is hand-mirrored into six other places, in two packages that CANNOT
 * import each other: `check:boundaries` forbids `vex-app` from importing
 * `src/vex-agent`, which is precisely why every app-side copy is a hand-typed
 * literal list and therefore free to rot.
 *
 * The cost of that rot is already visible in the repo — `sessionListModel.ts`
 * silently lost `paused_user` and `paused_plan_acceptance` from its "paused"
 * bucket, so those sessions fall out of the sidebar's paused group with no
 * error anywhere. Adding a sixth paused status without a guard would repeat it.
 *
 * A normal import cannot cross the boundary, so this test reads the mirror
 * files as TEXT and extracts their status literals. That is deliberately crude
 * and deliberately unskippable: it needs no build graph, respects the process
 * boundary, and fails loudly the moment the canonical list moves without its
 * mirrors.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import {
  ACTIVE_OR_PAUSED_RUN_STATUSES,
  APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES,
  MISSION_RUN_STATUSES,
  PAUSED_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from "@vex-agent/engine/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

/**
 * Extract the status literals from a block of source text.
 *
 * `source.slice(start, end)` is taken between two anchors so an unrelated
 * mention of a status elsewhere in the file cannot mask a real omission.
 */
function literalsBetween(source: string, startAnchor: string, endAnchor: string): string[] {
  const start = source.indexOf(startAnchor);
  expect(start, `anchor not found: ${startAnchor}`).toBeGreaterThan(-1);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `end anchor not found: ${endAnchor}`).toBeGreaterThan(-1);
  const block = source.slice(start, end);
  const known = new Set<string>(MISSION_RUN_STATUSES);
  const found = new Set<string>();
  for (const match of block.matchAll(/"([a-z_]+)"/g)) {
    const literal = match[1];
    if (literal !== undefined && known.has(literal)) found.add(literal);
  }
  return [...found].sort();
}

const CANONICAL = [...MISSION_RUN_STATUSES].sort();

describe("mission run status vocabulary — cross-package drift guard", () => {
  it("the app's shared session schema mirrors the canonical list exactly", () => {
    const source = read("vex-app/src/shared/schemas/sessions.ts");
    expect(
      literalsBetween(source, "export const missionRunStatusSchema = z.enum([", "]);"),
    ).toEqual(CANONICAL);
  });

  it("the engine's control-bus event union mirrors the canonical list exactly", () => {
    const source = read("src/vex-agent/engine/runtime/control-bus.ts");
    const block = source.slice(
      source.indexOf("export type ControlEventStatus ="),
      source.indexOf("export type ControlEventPendingKind"),
    );
    const found = new Set<string>();
    for (const match of block.matchAll(/"([a-z_]+)"/g)) {
      const literal = match[1];
      if (literal !== undefined) found.add(literal);
    }
    expect([...found].sort()).toEqual(CANONICAL);
  });

  it("both app-side active-or-paused whitelists mirror the engine's set exactly", () => {
    const expected = [...ACTIVE_OR_PAUSED_RUN_STATUSES].sort();

    expect(
      literalsBetween(
        read("vex-app/src/main/database/mission-runs-db.ts"),
        "const ACTIVE_OR_PAUSED_STATUSES",
        "];",
      ),
    ).toEqual(expected);

    expect(
      literalsBetween(
        read("vex-app/src/main/database/sessions/mappers.ts"),
        "export const ACTIVE_OR_PAUSED_MISSION_RUN_STATUSES",
        "];",
      ),
    ).toEqual(expected);
  });

  it("the composer's free-text gate covers every non-terminal status", () => {
    // A status missing here silently lets the user type free text into a run
    // that cannot answer it.
    const nonTerminal = MISSION_RUN_STATUSES.filter((s) => !TERMINAL_RUN_STATUSES.has(s)).sort();
    expect(
      literalsBetween(
        read("vex-app/src/renderer/features/appShell/composer-helpers.ts"),
        "export const FREE_TEXT_DISALLOWED",
        "]);",
      ),
    ).toEqual(nonTerminal);
  });

  it("every paused status has its own gatedReason case — no silent default", () => {
    const source = read("vex-app/src/renderer/features/appShell/composer-helpers.ts");
    const block = source.slice(
      source.indexOf("export function gatedReason"),
      source.indexOf("default:", source.indexOf("export function gatedReason")),
    );
    for (const status of PAUSED_RUN_STATUSES) {
      expect(block, `gatedReason has no case for ${status}`).toContain(`case "${status}":`);
    }
  });
});

describe("paused_user_form — the C3b non-approval parked state", () => {
  it("is a known, paused, non-terminal status", () => {
    expect(MISSION_RUN_STATUSES).toContain("paused_user_form");
    expect(PAUSED_RUN_STATUSES.has("paused_user_form")).toBe(true);
    expect(TERMINAL_RUN_STATUSES.has("paused_user_form")).toBe(false);
    expect(ACTIVE_OR_PAUSED_RUN_STATUSES.has("paused_user_form")).toBe(true);
  });

  it("is NOT approval-resume-claimable — it must never expose an approval card", () => {
    // This is the whole reason the status exists. If the approval lifecycle
    // could claim a form-parked run, the resume would surface the approval
    // surface that C3b was created to avoid.
    expect(APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES).not.toContain("paused_user_form");
  });

  it("is distinct from paused_approval", () => {
    expect("paused_user_form").not.toBe("paused_approval");
    expect(PAUSED_RUN_STATUSES.has("paused_approval")).toBe(true);
  });

  it("blocks the generic Resume and Recover paths, which cannot answer the form", () => {
    // A generic resume would flip the run to `running` while a tool call sits
    // unanswered — the hang C3b exists to prevent.
    expect(read("vex-app/src/main/ipc/_shared/runtime-resume-dispatch.ts")).toContain(
      'status === "paused_user_form"',
    );
    expect(read("vex-app/src/main/ipc/_shared/runtime-retry-dispatch.ts")).toContain(
      'status === "paused_user_form"',
    );
    expect(read("src/vex-agent/engine/core/runner/retry.ts")).toContain(
      'run.status === "paused_user_form"',
    );
    expect(read("vex-app/src/main/ipc/runtime/request-pause.ts")).toContain(
      'status === "paused_user_form"',
    );
  });
});
