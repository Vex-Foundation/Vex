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
 * merged. The 28 R3 Minimal entries were consumed when PR #215 merged, and
 * the 20 Docker removal entries when PR #217 merged.
 */
export const DELETED_TEST_ALLOWLIST = [
  {
    path: "vex-app/src/renderer/components/vex/k2/__tests__/K2TokenButton.test.tsx",
    reason: "components/vex/k2/ (K2, the halftone portrait engine, its art, poses, rig and time-of-day moods) was retired by the desktop H3 revamp (plan row S8-16, owner decision 2026-11-04: Kimm replaces K2 everywhere); Kimm's raster art, mood map and section replace it.",
    coveredBy: "vex-app/src/renderer/features/vex/__tests__/VexHeadCell.test.tsx",
  },
  {
    path: "vex-app/src/renderer/components/vex/k2/__tests__/VexK2-coffee.test.tsx",
    reason: "components/vex/k2/ (K2, the halftone portrait engine, its art, poses, rig and time-of-day moods) was retired by the desktop H3 revamp (plan row S8-16, owner decision 2026-11-04: Kimm replaces K2 everywhere); Kimm's raster art, mood map and section replace it.",
    coveredBy: "vex-app/src/renderer/features/vex/__tests__/kimm-mood.test.ts",
  },
  {
    path: "vex-app/src/renderer/components/vex/k2/__tests__/VexK2.test.tsx",
    reason: "components/vex/k2/ (K2, the halftone portrait engine, its art, poses, rig and time-of-day moods) was retired by the desktop H3 revamp (plan row S8-16, owner decision 2026-11-04: Kimm replaces K2 everywhere); Kimm's raster art, mood map and section replace it.",
    coveredBy: "vex-app/src/renderer/components/vex/kimm/__tests__/KimmSection.test.tsx",
  },
  {
    path: "vex-app/src/renderer/components/vex/k2/__tests__/k2-art.test.ts",
    reason: "components/vex/k2/ (K2, the halftone portrait engine, its art, poses, rig and time-of-day moods) was retired by the desktop H3 revamp (plan row S8-16, owner decision 2026-11-04: Kimm replaces K2 everywhere); Kimm's raster art, mood map and section replace it.",
    coveredBy: "vex-app/src/renderer/components/vex/kimm/__tests__/kimm-assets.test.ts",
  },
  {
    path: "vex-app/src/renderer/components/vex/k2/__tests__/k2-coffee.test.ts",
    reason: "components/vex/k2/ (K2, the halftone portrait engine, its art, poses, rig and time-of-day moods) was retired by the desktop H3 revamp (plan row S8-16, owner decision 2026-11-04: Kimm replaces K2 everywhere); Kimm's raster art, mood map and section replace it.",
    coveredBy: "vex-app/src/renderer/features/vex/__tests__/kimm-mood.test.ts",
  },
  {
    path: "vex-app/src/renderer/components/vex/k2/__tests__/k2-engine-coffee.test.ts",
    reason: "components/vex/k2/ (K2, the halftone portrait engine, its art, poses, rig and time-of-day moods) was retired by the desktop H3 revamp (plan row S8-16, owner decision 2026-11-04: Kimm replaces K2 everywhere); Kimm's raster art, mood map and section replace it.",
    coveredBy: "vex-app/src/renderer/features/vex/__tests__/useKimmMood.test.tsx",
  },
  {
    path: "vex-app/src/renderer/components/vex/k2/__tests__/k2-engine.test.ts",
    reason: "components/vex/k2/ (K2, the halftone portrait engine, its art, poses, rig and time-of-day moods) was retired by the desktop H3 revamp (plan row S8-16, owner decision 2026-11-04: Kimm replaces K2 everywhere); Kimm's raster art, mood map and section replace it.",
    coveredBy: "vex-app/src/renderer/components/vex/kimm/__tests__/KimmPanel.test.tsx",
  },
  {
    path: "vex-app/src/renderer/components/vex/k2/__tests__/k2-morning.test.ts",
    reason: "components/vex/k2/ (K2, the halftone portrait engine, its art, poses, rig and time-of-day moods) was retired by the desktop H3 revamp (plan row S8-16, owner decision 2026-11-04: Kimm replaces K2 everywhere); Kimm's raster art, mood map and section replace it.",
    coveredBy: "vex-app/src/renderer/features/vex/__tests__/kimm-mood.test.ts",
  },
  {
    path: "vex-app/src/renderer/components/vex/k2/__tests__/k2-portrait.test.ts",
    reason: "components/vex/k2/ (K2, the halftone portrait engine, its art, poses, rig and time-of-day moods) was retired by the desktop H3 revamp (plan row S8-16, owner decision 2026-11-04: Kimm replaces K2 everywhere); Kimm's raster art, mood map and section replace it.",
    coveredBy: "vex-app/src/renderer/components/vex/kimm/__tests__/KimmPortraitKey.test.tsx",
  },
  {
    path: "vex-app/src/renderer/components/vex/k2/__tests__/k2-poses.test.ts",
    reason: "components/vex/k2/ (K2, the halftone portrait engine, its art, poses, rig and time-of-day moods) was retired by the desktop H3 revamp (plan row S8-16, owner decision 2026-11-04: Kimm replaces K2 everywhere); Kimm's raster art, mood map and section replace it.",
    coveredBy: "vex-app/src/renderer/features/vex/__tests__/kimm-mood.test.ts",
  },
  {
    path: "vex-app/src/renderer/components/vex/k2/__tests__/k2-rig.test.ts",
    reason: "components/vex/k2/ (K2, the halftone portrait engine, its art, poses, rig and time-of-day moods) was retired by the desktop H3 revamp (plan row S8-16, owner decision 2026-11-04: Kimm replaces K2 everywhere); Kimm's raster art, mood map and section replace it.",
    coveredBy: "vex-app/src/renderer/components/vex/kimm/__tests__/KimmSection.test.tsx",
  },
  {
    path: "vex-app/src/renderer/components/vex/k2/__tests__/k2-stamp.test.ts",
    reason: "components/vex/k2/ (K2, the halftone portrait engine, its art, poses, rig and time-of-day moods) was retired by the desktop H3 revamp (plan row S8-16, owner decision 2026-11-04: Kimm replaces K2 everywhere); Kimm's raster art, mood map and section replace it.",
    coveredBy: "vex-app/src/renderer/components/vex/kimm/__tests__/KimmPortraitKey.test.tsx",
  },
  {
    path: "vex-app/src/renderer/components/vex/k2/__tests__/k2-time.test.ts",
    reason: "components/vex/k2/ (K2, the halftone portrait engine, its art, poses, rig and time-of-day moods) was retired by the desktop H3 revamp (plan row S8-16, owner decision 2026-11-04: Kimm replaces K2 everywhere); Kimm's raster art, mood map and section replace it.",
    coveredBy: "vex-app/src/renderer/features/vex/__tests__/useKimmMood.test.tsx",
  },
  {
    path: "vex-app/src/renderer/components/vex/k2/__tests__/k2-token.test.ts",
    reason: "components/vex/k2/ (K2, the halftone portrait engine, its art, poses, rig and time-of-day moods) was retired by the desktop H3 revamp (plan row S8-16, owner decision 2026-11-04: Kimm replaces K2 everywhere); Kimm's raster art, mood map and section replace it.",
    coveredBy: "vex-app/src/renderer/features/vex/__tests__/VexHeadCell.test.tsx",
  },
  {
    path: "vex-app/src/renderer/features/appShell/screens/__tests__/SettingsBackdropRow.test.tsx",
    reason: "SettingsBackdropRow.tsx offered an image for the print window of Vex's R3 sidebar, which H3 no longer has; the row was retired by owner decision 2026-11-08 (the stored value, main's store and the bridge stay, unread). SettingsPreferences asserts the section without it.",
    coveredBy: "vex-app/src/renderer/features/appShell/screens/__tests__/SettingsPreferences.test.tsx",
  },
  {
    path: "vex-app/src/renderer/features/vex/__tests__/NeedsYouControl.test.tsx",
    reason: "NeedsYouControl.tsx was R3's 'Needs you · N' header control; H3 and D2 move Needs you into Vex's console and a header count cell (H3-DESKTOP 4.8, 6.3). Review still opens and never decides, covered by the console and the head cell.",
    coveredBy: "vex-app/src/renderer/features/vex/__tests__/NeedsYouHeadCell.test.tsx",
  },
  {
    path: "vex-app/src/renderer/features/vex/__tests__/VexStatus.test.tsx",
    reason: "VexStatus.tsx (R3's state block in the Vex sidebar) was unmounted by the H3 revamp and deleted once nothing read it; D2's state row (state square, word and timer) carries the same reading.",
    coveredBy: "vex-app/src/renderer/features/vex/__tests__/VexSidebar.test.tsx",
  },
  {
    path: "vex-app/src/renderer/features/vex/__tests__/VexTokenChip.test.tsx",
    reason: "VexTokenChip.tsx (R3's token chip in the header) was replaced by H3's Vex key and then D2's VEX head cell with its hide/show key and chord; nothing mounted it any more.",
    coveredBy: "vex-app/src/renderer/features/vex/__tests__/VexHeadCell.test.tsx",
  },
  {
    path: "vex-app/src/renderer/features/vex/__tests__/vex-emotion.test.ts",
    reason: "vex-emotion.ts mapped Vex's states to K2's poses and was deleted with K2 (S8-16); kimm-mood.ts maps every state to one of Kimm's moods.",
    coveredBy: "vex-app/src/renderer/features/vex/__tests__/kimm-mood.test.ts",
  },
  {
    path: "vex-app/src/renderer/lib/__tests__/greeting.test.ts",
    reason: "lib/greeting.ts held R3's time-of-day greeting pools; H3's welcome has one fixed line, 'Ready when you are.' (H3-DESKTOP A.4, owner decision 2026-11-09 kept it).",
    coveredBy: "vex-app/src/renderer/features/appShell/__tests__/SessionWelcomeHero.test.tsx",
  },
  {
    path: "vex-app/src/renderer/lib/pixel/__tests__/pixel.test.ts",
    reason: "lib/pixel/ drew R3's pixel plate prints and was retired with them (S8-17); Kimm's art is raster files registered with byte budgets.",
    coveredBy: "vex-app/src/renderer/components/vex/kimm/__tests__/kimm-assets.test.ts",
  },
  {
    path: "vex-app/src/renderer/styles/global-css/__tests__/paper-2-night.test.ts",
    reason: "The R3 night paper ('paper 2') and its theme tier were retired when desktop went dark only (S1-04); the H3 primitives and their values are pinned by the theme matrix.",
    coveredBy: "vex-app/src/renderer/styles/global-css/__tests__/theme-matrix.test.ts",
  },
];

export const DELETED_TEST_ALLOWLIST_PATHS = new Set(
  DELETED_TEST_ALLOWLIST.map((entry) => entry.path),
);
