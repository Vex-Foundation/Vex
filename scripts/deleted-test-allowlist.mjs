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
 */

export const DELETED_TEST_ALLOWLIST = [
  {
    path: "src/__tests__/vex-agent/agent-scan/relay-reveal-eligibility.test.ts",
    reason:
      "Subject `registry/relay-reveal-eligibility.ts` deleted with the venue un-gate (owner decision D4). The module was already dead: this test was its only importer.",
  },
  {
    path: "src/__tests__/vex-agent/agent-scan/relay-reveal-gate.test.ts",
    reason:
      "Subject `evaluateRelayRevealGate` deleted with the venue un-gate (D4). The Relay tools are always visible and always callable; approval, not reveal, gates the funds.",
  },
  {
    path: "src/__tests__/vex-agent/agent-scan/relay-reveal-registry.test.ts",
    reason:
      "Subject `registry/relay-reveal.ts` deleted with the venue un-gate (D4). No reveal registry remains to record or read.",
  },
  {
    path: "src/__tests__/vex-agent/agent-scan/relay-reveal-serialization.test.ts",
    reason:
      "Subject is the pre-reveal serialization shape, deleted with the venue un-gate (D4). The surviving invariant is inverted and covered by the C42 block in the prompt-stack suite and by `tools/registry-venue-tool-surface.test.ts`.",
  },
  {
    path: "src/__tests__/vex-agent/agent-scan/reveal-registry.test.ts",
    reason:
      "Subject `registry/uniswap-reveal.ts` deleted with the venue un-gate (D4). The visibility half is re-covered by `tools/registry-venue-tool-surface.test.ts`, which asserts the tools are present rather than hidden.",
  },
  {
    path: "src/__tests__/vex-agent/tools/describe-tools.test.ts",
    reason:
      "Subject `describe_tools` (its ToolDef, `handleDescribeTools`, `describeProtocolTools`, and the describe reveal gate) deleted by the ToolSearch merge. Rewritten as `tools/tool-search.test.ts`, which re-pins every property this suite held — D3-equivalence becomes the shared injected schema, reject-by-name, not-a-gate-bypass, and catalog-derived bounds — plus the merge's own golden property that no result may carry a parameter schema.",
  },
  {
    path: "src/__tests__/vex-agent/tools/registry-swap-quote-reveal-consistency.test.ts",
    reason:
      "Rewritten as `tools/registry-venue-tool-surface.test.ts` around the inverted invariant (no visibility gate on the four venue tools; the routers name the alternative). Git reports it as delete+add rather than a rename because the rewrite falls below the similarity threshold.",
  },
];

export const DELETED_TEST_ALLOWLIST_PATHS = new Set(
  DELETED_TEST_ALLOWLIST.map((entry) => entry.path),
);
