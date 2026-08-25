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
    path: "src/__tests__/dexscreener/_byte-budget.ts",
    reason:
      "Shared helper for the pair-list and feed-list byte-budget suites, both of which are deleted with the same change. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "The site surface bounds its own responses in `src/tools/dexscreener/endpoints/*` (measured caps per endpoint) and proves them in `src/__tests__/dexscreener-site/`.",
  },
  {
    path: "src/__tests__/dexscreener/_naming-law.ts",
    reason:
      "Shared helper asserting the naming law of the retired pair-list, feed-list and narrative-list vocabularies. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "The surviving vocabulary is governed by the manifest linter (`protocols/_manifest-lint/`), which runs over every live tool in `protocols/manifest-lint.test.ts`.",
  },
  {
    path: "src/__tests__/dexscreener/_feed-captures.ts",
    reason:
      "Provider captures for the retired boosts/profiles/ads/CTO feeds. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "The spotlight document that replaced those four feeds is captured and proved in `src/__tests__/dexscreener-site/resolve-endpoints.test.ts`.",
  },
  {
    path: "src/__tests__/dexscreener/_pair-captures.ts",
    reason:
      "Provider captures for the retired public-API pair rows. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "Site-channel pair rows are captured and proved in `src/__tests__/dexscreener-site/screen-project.test.ts` and `screener-endpoint.test.ts`.",
  },
  {
    path: "src/__tests__/dexscreener/_measure-pair-list-bytes.ts",
    reason:
      "Byte-measurement harness driving the retired `dexscreener.search`/`pairs`/`tokens`/`tokenPairs` public-API handlers. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "Response bounds are now the endpoint modules' own, proved in `src/__tests__/dexscreener-site/`.",
  },
  {
    path: "src/__tests__/dexscreener/correctness-regressions.test.ts",
    reason:
      "Regressions of the retired `pair-list/` pipeline and `token-batch-addresses.ts`, both deleted. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "The site row projection and its derived metrics are proved in `src/__tests__/dexscreener-site/screen-project.test.ts`.",
  },
  {
    path: "src/__tests__/dexscreener/dexscreener-client.test.ts",
    reason:
      "Drove `handlers/source-observation.ts`, the freshness envelope of the retired public-API handlers, which is deleted. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "The site surface reports freshness through `sourceObservation` on every envelope; its shape is proved in `src/__tests__/dexscreener-site/screen-envelope.test.ts` and the handler suites.",
  },
  {
    path: "src/__tests__/dexscreener/feed-list-naming-law.test.ts",
    reason:
      "Naming law of the retired feed-list and narrative-list vocabularies. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "Covered for the live surface by `protocols/manifest-lint.test.ts`.",
  },
  {
    path: "src/__tests__/dexscreener/feed-list-byte-budget.test.ts",
    reason:
      "Byte budget of the retired boosts/profiles/ads/CTO/attention feed tools. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "The spotlight document's own cap is proved in `src/__tests__/dexscreener-site/resolve-endpoints.test.ts`.",
  },
  {
    path: "src/__tests__/dexscreener/feed-list-envelope.test.ts",
    reason:
      "Envelope of the retired feed tools. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "The spotlight envelope is proved in `src/__tests__/vex-agent/tools/dexscreener-resolve-handlers.test.ts`.",
  },
  {
    path: "src/__tests__/dexscreener/feed-list-params.test.ts",
    reason:
      "Params of the retired feed tools. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "Live params are linted catalog-wide by `protocols/manifest-lint.test.ts` and pinned per tool by `dexscreener-manifest.test.ts`.",
  },
  {
    path: "src/__tests__/dexscreener/list-explain-drops.test.ts",
    reason:
      "`explainDrops` on the retired list pipelines; the param does not exist on the site surface. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "Client-side drops are accounted for by `droppedByFilter`/`clientFiltering`, proved in the screening and resolve handler suites.",
  },
  {
    path: "src/__tests__/dexscreener/list-omit-fields.test.ts",
    reason:
      "`omitFields` on the retired list pipelines; the site surface shapes rows by field GROUPS instead. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "Field-group shaping is proved in `src/__tests__/dexscreener-site/screen-fields.test.ts`.",
  },
  {
    path: "src/__tests__/dexscreener/list-string-array-params.test.ts",
    reason:
      "String-or-array coercion via the retired `pair-list/` and `feed-list/` readers. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "The namespace-neutral owner is `protocols/runtime/list-params.ts`, covered by its own suite and by the site handler suites.",
  },
  {
    path: "src/__tests__/dexscreener/pair-filter-field-mapping.test.ts",
    reason:
      "Filter-to-field mapping of the retired `manifests/pair-list-params.ts` and `narrative-list-params.ts`. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "The site surface's filter echo is proved in `src/__tests__/dexscreener-site/screen-request.test.ts`.",
  },
  {
    path: "src/__tests__/dexscreener/pair-list-byte-budget.test.ts",
    reason:
      "Byte budget of the retired pair-list tools. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "Endpoint caps are proved in `src/__tests__/dexscreener-site/`.",
  },
  {
    path: "src/__tests__/dexscreener/pair-list-envelope.test.ts",
    reason:
      "Envelope of the retired pair-list tools. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "The site envelope is proved in `src/__tests__/dexscreener-site/screen-envelope.test.ts`.",
  },
  {
    path: "src/__tests__/dexscreener/pair-list-naming-law.test.ts",
    reason:
      "Naming law of the retired pair-list vocabulary. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "Covered for the live surface by `protocols/manifest-lint.test.ts`.",
  },
  {
    path: "src/__tests__/dexscreener/pair-list-params.test.ts",
    reason:
      "Params of the retired pair-list tools. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "Live params are pinned by `dexscreener-manifest.test.ts` and linted by `protocols/manifest-lint.test.ts`.",
  },
  {
    path: "src/__tests__/dexscreener/persona-gate-follow-ups.test.ts",
    reason:
      "Persona follow-up flows driving the retired public-API tools end to end. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "Routing across the surviving surface is proved by `dexscreener-source-policy.test.ts` and the lexical eval dataset `tool-discovery-dexscreener.json` (v4).",
  },
  {
    path: "src/__tests__/dexscreener/research-flow-generality.test.ts",
    reason:
      "Research flow across the retired public-API tools. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "The surviving research flow is proved by `dexscreener-source-policy.test.ts` routing rows and the navigation entry assertions in the same file.",
  },
  {
    path: "src/__tests__/vex-agent/tools/dexscreener-handlers.test.ts",
    reason:
      "LIVE-network handler suite for all 12 retired public-API tools. Subject removed with the 12 public-API DexScreener tools, retired whole and alias-free by stage S3.5 (owner decision D-DS2).",
    covered:
      "The site handlers are proved without network by `dexscreener-screening-handlers.test.ts` and `dexscreener-resolve-handlers.test.ts`; the endpoints by `src/__tests__/dexscreener-site/`.",
  },
  {
    path: "src/__tests__/dexscreener/client-request-options.test.ts",
    reason:
      "Request-option contract of the retired public-API REST client. The client (src/tools/dexscreener/client.ts) was deleted at measured zero production consumers after the S11 migration to the price-read seam.",
    covered:
      "The wait-bound contract lives on in caller-bounds.ts and is proved by `price-read.test.ts`; the consumers' observable behavior is pinned by `s11a-consumer-characterization.test.ts` against the seam.",
  },
  {
    path: "src/__tests__/dexscreener/dexscreener-error-surface.test.ts",
    reason:
      "Error taxonomy of the retired public-API REST client, deleted with it at measured zero production consumers (S11 assembly).",
    covered:
      "The mapping functions themselves (mapDexScreenerError, mapTransportError) still live in errors.ts and are exercised directly by `dexscreener-errors.test.ts`; the seam's own suite (`price-read.test.ts`) covers the outcomes it can produce - a 429 that parks the rate class, a caller abort, a caller deadline and an over-cap body - not the full status taxonomy.",
  },
];

export const DELETED_TEST_ALLOWLIST_PATHS = new Set(
  DELETED_TEST_ALLOWLIST.map((entry) => entry.path),
);
