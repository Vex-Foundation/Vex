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
    path: "vex-app/src/renderer/features/appShell/studio/explorer/__spike__/__tests__/flatIndex.spike.test.tsx",
    reason:
      "Stage B3 spike, candidate B. Its subject was `__spike__/flatIndexModel.ts`, a throwaway " +
      "measurement harness whose only purpose was to decide whether to own the tree model or adopt " +
      "@headless-tree. The measurement returned 10-13x faster per splice at 10k visible rows, the " +
      "port decision was ratified, and stage B3b lands it - so the spike module is deleted in this " +
      "same change and there is no subject left to exercise.",
    survivingCoverage:
      "vex-app/src/renderer/features/appShell/studio/explorer/__tests__/explorer-model.test.ts " +
      "(the shipped model's contract, including the three defects the spike carried: the byId " +
      "subtree leak, the O(n) index scan and the silent re-parent) and " +
      "vex-app/src/renderer/features/appShell/studio/explorer/__tests__/ExplorerTree.splice.test.tsx " +
      "(the 50k-node splice invariant, ported with the same fixture and render counters).",
  },
  {
    path: "vex-app/src/renderer/features/appShell/studio/explorer/__spike__/__tests__/headlessTree.spike.test.tsx",
    reason:
      "Stage B3 spike, candidate A. Its subject was `@headless-tree/core` and `@headless-tree/react`, " +
      "which lost the measurement and are REMOVED from vex-app/package.json and vex-app/pnpm-lock.yaml " +
      "in this same change. The test cannot be kept: the packages it imports are no longer installed.",
    survivingCoverage:
      "Nothing of the rejected candidate survives, by design. The behaviour the comparison was ABOUT - " +
      "that expanding a 10k-child folder and inserting one child re-renders only viewport rows - is " +
      "asserted against the shipped model in " +
      "vex-app/src/renderer/features/appShell/studio/explorer/__tests__/ExplorerTree.splice.test.tsx.",
  },
];

export const DELETED_TEST_ALLOWLIST_PATHS = new Set(
  DELETED_TEST_ALLOWLIST.map((entry) => entry.path),
);
