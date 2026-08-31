/**
 * THE CROSS-MODE APPROVAL TOAST (B4c).
 *
 * The shell has two modes and ONE approvals queue. An approval raised by the
 * Studio MCP surface while the user is reading an agent session - or the other
 * way round - is otherwise visible only in the DESK RULE badge's count, which
 * is exactly the kind of "it was on screen" that no one notices. This fires one
 * transient toast the first time such an approval is observed.
 *
 * It INFORMS and grants nothing: the toast carries no action, no navigation and
 * no authority. The approval is still decided in its card, under the same
 * two-step high-risk confirm as every other. Nothing here is throttled or
 * coalesced either (rule 08 forbids throttling approvals) - the toast is an
 * ADDITIONAL announcement layered on a badge that already updates immediately.
 *
 * ## Where the "already announced" memory lives, and why
 *
 * In a MODULE-LEVEL `BoundedSeenIds`, not in a ref or in React state.
 *
 * The dedupe has to survive three separate things that all re-deliver the same
 * rows: a refetch (the panel poll and every push invalidation), a StrictMode
 * double-mount, and a MODE SWITCH (which is the one case a component-scoped ref
 * cannot cover - the switch is the moment an approval becomes "cross-mode", and
 * a memory that reset with it would re-announce every pending row on every
 * toggle). `GlobalApprovals`, the hook's only caller, is mounted exactly once
 * for the whole frame by `ShellStatusStrip`, so a module-level store has one
 * writer by construction.
 *
 * The set is BOUNDED (see `BoundedSeenIds`); tests own `resetCrossModeToastMemory`.
 */

import { useEffect, useRef } from "react";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import type { RuntimeMode } from "../../../stores/uiStore.js";
import { showToast } from "../../../lib/toast.js";
import { crossModeApprovalToast } from "./approvals-copy.js";
import { BoundedSeenIds, selectFreshApprovals } from "./fresh-approvals.js";

/**
 * Far above any plausible number of approvals one window will see, so the
 * bounded tail never drops an id that is still on screen.
 */
const MAX_ANNOUNCED_IDS = 512;

const announced = new BoundedSeenIds(MAX_ANNOUNCED_IDS);

/** Test-only: a fresh observer. Production has exactly one, for the process. */
export function resetCrossModeToastMemory(): void {
  announced.clear();
}

/**
 * Which mode RAISED this approval.
 *
 * `origin` is the authoritative field when the row has a companion intent row;
 * `projectId` is the fallback for rows that predate it. A row that says Studio
 * in either field is Studio-originated: calling a Studio row agent-originated
 * would put the words "in the agent shell" on a wallet action a project asked
 * for, which is a lie about authority. The safe direction is to claim less
 * about agent origin, not more.
 */
export function approvalOriginMode(
  row: Pick<ApprovalPendingGlobalDto, "origin" | "projectId">,
): RuntimeMode {
  if (row.origin === "studio_mcp") return "studio";
  if (row.origin === "agent") return "agent";
  return row.projectId === null ? "agent" : "studio";
}

/**
 * Announce the OLDEST newly-observed approval that came from the other mode,
 * and COUNT the ones observed with it.
 *
 * One toast per observation, not one per row: the transient slot holds a single
 * message, so firing per row would show only the last one anyway while
 * restarting the cycle for each. But every fresh id is marked announced whether
 * or not it was named, so the batch-mates of the oldest row would otherwise be
 * silently swallowed - observed, recorded, never announced by anything. The
 * toast therefore names the oldest and reports how many others came with it.
 * Nothing is throttled or dropped: the badge beside it already carries the
 * exact live count, and this line agrees with it.
 *
 * Recording every fresh id (not only the announced one) is what keeps a row
 * that becomes cross-mode LATER (the user switches modes) from being
 * re-announced - it was already observed.
 *
 * `rows === null` (loading, or a failed read) records nothing: an unknown list
 * is not evidence that anything was seen.
 */
export function useCrossModeApprovalToast(
  rows: ReadonlyArray<ApprovalPendingGlobalDto> | null,
  runtimeMode: RuntimeMode,
): void {
  // The mode is read at ANNOUNCE time, not made a dependency: a mode switch
  // must not re-run the effect over rows that were already observed.
  const modeRef = useRef(runtimeMode);
  modeRef.current = runtimeMode;

  useEffect(() => {
    if (rows === null) return;
    const fresh = selectFreshApprovals(rows, announced);
    if (fresh.length === 0) return;
    const currentMode = modeRef.current;
    const crossMode = fresh.filter(
      (row) => approvalOriginMode(row) !== currentMode,
    );
    for (const row of fresh) announced.add(row.id);
    const oldest = crossMode[0];
    if (oldest === undefined) return;
    showToast(
      crossModeApprovalToast({
        originatedInStudio: approvalOriginMode(oldest) === "studio",
        tool: oldest.preview?.toolName ?? oldest.toolName ?? "(unknown tool)",
        projectId: oldest.projectId,
        projectName: oldest.projectName,
        // The rest of THIS observation's cross-mode batch. They are marked
        // announced on the line above and get no toast of their own, so the
        // count is the only place they are reported.
        othersAwaiting: crossMode.length - 1,
      }),
    );
  }, [rows]);
}
