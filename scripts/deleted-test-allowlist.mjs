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
    path: "vex-app/src/renderer/features/appShell/Board/__tests__/boardChartArea.test.ts",
    reason:
      "The spotlight chart's AREA adapter (toChartAreaPoint, normalizeBoardAreaPoints, " +
      "reconcileAreaSeries, AreaFeed) was removed when the owner ruled the spotlight " +
      "main chart a candlestick series with a volume histogram (2026-08-26); no code " +
      "is left for this suite to exercise.",
    coveredBy:
      "vex-app/src/renderer/features/appShell/Board/__tests__/boardChartSpotlight.test.ts " +
      "(the candle-plus-volume adapter, the same reconciliation table over all five " +
      "fields, the per-bar colours and the two-series feed).",
  },
];

export const DELETED_TEST_ALLOWLIST_PATHS = new Set(
  DELETED_TEST_ALLOWLIST.map((entry) => entry.path),
);
