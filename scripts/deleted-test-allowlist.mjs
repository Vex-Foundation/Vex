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
 */
const RETIRED_FEED_WS_REASON =
  "Capture of the retired dex_feed.WSCommand/WSMessage feed/ws protocol, which the site removed (drift test against the 2026-10-07 bundle); the subject no longer exists.";
const FEED_ENVELOPE_TEST = "src/__tests__/dexscreener-site/feed-envelope.test.ts";

/**
 * The feed/ws migration to the util_envelope protocol retires every capture of
 * the old command protocol. Each is replaced by a feed-envelope-* capture of the
 * same exchange on the new protocol, decoded by FEED_ENVELOPE_TEST.
 */
const RETIRED_FEED_WS_FIXTURES = [
  "bars-ws-d1-uniswap-ethereum.bin.b64",
  "bars-ws-d1-uniswap-ethereum.provenance.json",
  "bars-ws-marketcap-uniswap-ethereum.bin.b64",
  "bars-ws-marketcap-uniswap-ethereum.provenance.json",
  "token-insight-not-found.bin.b64",
  "token-insight-not-found.provenance.json",
  "ws-trades-baseline-uniswap.bin.b64",
  "ws-trades-baseline-uniswap.provenance.json",
  "ws-trades-exact-cursor-page2.bin.b64",
  "ws-trades-exact-cursor-page2.command.bin.b64",
  "ws-trades-exact-cursor-page2.command.provenance.json",
  "ws-trades-exact-cursor-page2.provenance.json",
];

export const DELETED_TEST_ALLOWLIST = RETIRED_FEED_WS_FIXTURES.map((name) => ({
  path: `src/__tests__/dexscreener-site/fixtures/${name}`,
  reason: RETIRED_FEED_WS_REASON,
  coveredBy: FEED_ENVELOPE_TEST,
}));

export const DELETED_TEST_ALLOWLIST_PATHS = new Set(
  DELETED_TEST_ALLOWLIST.map((entry) => entry.path),
);
