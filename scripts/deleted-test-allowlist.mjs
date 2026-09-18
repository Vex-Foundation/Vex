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
 * merge. The entry below rides the Superboard key contract change (PR #193)
 * and is consumed the moment that PR merges. The two Lighter entries ride the
 * Lighter shell migration, which deletes the modal/workspace subjects
 * together with their tests; their replacement is covered by the new centre
 * and component suites named below.
 */
export const DELETED_TEST_ALLOWLIST = [
  {
    path: "vex-app/src/renderer/features/appShell/screens/SettingsScreen/__tests__/superboard-pending-copy.test.ts",
    reason:
      "Subject `superboard-pending-copy.ts` deleted: the Superboard status contract replaced the free-form `lastError` string with a structured `ShareTokenFailure`, so a copy resolver that pattern-matched prose has no input left. Surviving behavior (one sentence per failure kind and context, reassurance rows, the no-invented-controls guard) is covered by `__tests__/superboard-key-copy.test.ts`; the rendered rows by `__tests__/SuperboardKeySection.test.tsx`.",
  },
  {
    path: "vex-app/src/renderer/features/appShell/lighterTrading/__tests__/LighterTradingDialog.test.tsx",
    reason: "The modal subject was removed when Lighter became a shell mode.",
    coveredBy: "vex-app/src/renderer/features/appShell/lighterTrading/__tests__/LighterCenter.test.tsx",
  },
  {
    path: "vex-app/src/renderer/features/appShell/lighterTrading/__tests__/TradingWorkspace.test.tsx",
    reason: "The workspace subject was replaced by the Lighter centre composition.",
    coveredBy: "vex-app/src/renderer/features/appShell/lighterTrading/__tests__/LighterCenter.test.tsx",
  },
];

export const DELETED_TEST_ALLOWLIST_PATHS = new Set(
  DELETED_TEST_ALLOWLIST.map((entry) => entry.path),
);
