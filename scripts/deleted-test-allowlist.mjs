/**
 * Reviewed test deletions.
 *
 * `check-test-unsafe-escapes.mjs` prohibits deleting a test file, because the
 * cheapest way to turn a suite green is to delete what fails. That gate has one
 * legitimate exception: a test whose SUBJECT was deliberately removed by the
 * same change. Such a test cannot be kept - there is no code left to exercise -
 * and silently dropping it is exactly what the gate exists to prevent. So each
 * one is named here with the contract change that removed its subject, and with
 * where the surviving behavior is covered instead.
 *
 * Same discipline as the manifest-lint allowlists: entries are added ONLY with
 * the change that deletes the subject, an entry whose file is no longer deleted
 * fails as stale, and the table may not be used to park a test that still has a
 * subject. Removing dead entries is expected maintenance, not a favor.
 *
 * The table is EMPTY between contract changes, and that is its resting state:
 * every entry is consumed the moment the change carrying it merges, because
 * the deletion stops being a deletion against the new base. A row that
 * outlives its merge is stale by construction and the gate says so.
 */

/**
 * The migration-108 Trench Express retirement carried 63 reviewed deletions
 * here; they merged with PR #165 (`7890245fa`) and were consumed by that
 * merge. The Lighter shell migration entries were also consumed after their
 * deleted test files landed on the base branch.
 * The 12 retired feed/ws fixture entries were consumed when the replacement
 * envelope protocol landed in main through PR #205 (`1dc37f68f`).
 * The four V10 Spread entries (the outline glyphs, the state dot, the sidebar
 * collapse choreography and the rail glass tier) were consumed when PR #212
 * merged.
 */
export const DELETED_TEST_ALLOWLIST = [
  {
    path: "vex-app/src/renderer/features/appShell/__tests__/ShellGutter.test.tsx",
    reason: "The R3 three-column frame retires the gutter and its spread caption; ShellGutter.tsx was deleted with it (R3 wave 1, W1-6).",
    coveredBy: "vex-app/src/renderer/features/appShell/__tests__/AppShell/shell-sidebar.test.tsx",
  },
  {
    path: "vex-app/src/renderer/components/pixel/__tests__/useDeskAgentState.test.tsx",
    reason: "useDeskAgentState.ts was deleted (no consumer after the flock left in wave 1) and its agreement partner DeskRuleTapeState is replaced by the title bar's token chip (R3 wave 2, W2-1); the state and the chip agreement are covered by vex-state.test.ts, useVexPresence.test.tsx and session-activity-agreement.test.tsx.",
    coveredBy: "vex-app/src/renderer/features/vex/__tests__/vex-state.test.ts",
  },
  {
    path: "vex-app/src/renderer/features/appShell/leftPage/__tests__/sessionOrdinals.test.tsx",
    reason: "R3 lists sessions by name: the ordinal ledger sessionOrdinals.ts was deleted with the left page (R3 wave 2, W2-2); the persisted key stays readable (uiStore-session-ordinals-v21.test.ts).",
    coveredBy: "vex-app/src/renderer/features/appShell/__tests__/SessionRow.test.tsx",
  },
  {
    path: "vex-app/src/renderer/features/appShell/leftPage/__tests__/useIndexFold.test.tsx",
    reason: "The print's horizon fold is gone: the R3 sidebar is paper and its session list one plain scroller; useIndexFold.ts was deleted (R3 wave 2, W2-2); also covered by SessionsList-nav.test.tsx.",
    coveredBy: "vex-app/src/renderer/features/appShell/__tests__/AppShell/shell-sidebar.test.tsx",
  },
  {
    path: "vex-app/src/renderer/components/ui/__tests__/counter.test.tsx",
    reason: "counter.tsx was deleted; its only consumer was the left page's giant ordinal, which R3 retires (R3 wave 2, W2-2); also covered by SessionsList-nav.test.tsx.",
    coveredBy: "vex-app/src/renderer/features/appShell/__tests__/SessionRow.test.tsx",
  },
  {
    path: "vex-app/src/renderer/features/appShell/__tests__/ArenaCampaignNotice.test.tsx",
    reason: "The Perps Trading Arena ended 2026-10-16: ArenaCampaignNotice.tsx and lighterTrading/arena-campaign.ts were deleted and the R3 welcome no longer carries the notice (R3 wave 2, W2-4); the Lighter row is covered by ComposerQuickActions.test.tsx.",
    coveredBy: "vex-app/src/renderer/features/appShell/__tests__/SessionWelcomeHero.test.tsx",
  },
];

export const DELETED_TEST_ALLOWLIST_PATHS = new Set(
  DELETED_TEST_ALLOWLIST.map((entry) => entry.path),
);
