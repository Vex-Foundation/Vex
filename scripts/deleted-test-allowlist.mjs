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

export const DELETED_TEST_ALLOWLIST = [
  {
    path: "vex-app/src/renderer/components/ui/__tests__/toast.test.tsx",
    reason:
      "Its subjects (components/ui/toast.tsx and the lib/toast.ts single-slot "
      + "store) were deleted by the batch-2 transient-toast migration onto the "
      + "notification model.",
    coveredBy:
      "vex-app/src/renderer/lib/notifications/__tests__/notification-model.test.ts "
      + "(timing, stacking, purge pause, unmount leak gate) and "
      + "vex-app/src/renderer/components/ui/__tests__/notification-toast.test.tsx "
      + "(render, tones, announcement).",
  },
  {
    path: "vex-app/src/renderer/features/appShell/__tests__/GlobalErrorBanner.test.tsx",
    reason:
      "Its subject (features/appShell/GlobalErrorBanner.tsx, the header pill "
      + "and popover) was deleted by the batch-2 engine-error migration onto "
      + "the notification model and center.",
    coveredBy:
      "vex-app/src/renderer/features/appShell/__tests__/engine-error-notifications.test.tsx "
      + "(event projection, scoping, announcement, dismissal) and "
      + "vex-app/src/renderer/features/appShell/__tests__/notification-center.test.tsx "
      + "(the center chrome that replaced the popover).",
  },
];

export const DELETED_TEST_ALLOWLIST_PATHS = new Set(
  DELETED_TEST_ALLOWLIST.map((entry) => entry.path),
);
