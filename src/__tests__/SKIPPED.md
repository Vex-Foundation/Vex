# Root-suite skipped-test ledger

The root Vitest suite currently contains seven intentional `it.skip` tests.
They predate the Hyperliquid work and are all blocked on the deliberately
disabled `SUBAGENT_TOOLS` surface, not on a Hyperliquid capability. This is a
release-report ledger; platform-gated and opt-in integration tests are not
included because they are conditional rather than skipped test bodies.

| Test | File | Skip reason |
|---|---|---|
| `subagent role includes subagent_request_parent and subagent_report_complete` | `src/__tests__/vex-agent/tools/registry.test.ts` | Re-enable with `SUBAGENT_TOOLS`; subagent tool exposure is currently disabled. |
| `parent role includes mission_stop (inside a run), subagent_spawn, subagent_reply` | `src/__tests__/vex-agent/tools/registry.test.ts` | Re-enable with `SUBAGENT_TOOLS`; parent subagent controls are currently disabled. |
| `subagent_status and subagent_stop remain visible to parent role` | `src/__tests__/vex-agent/tools/registry.test.ts` | Re-enable with `SUBAGENT_TOOLS`; parent subagent controls are currently disabled. |
| `isToolBlockedForRole returns true for blocked tools` | `src/__tests__/vex-agent/tools/registry.test.ts` | Re-enable with `SUBAGENT_TOOLS`; the tested blocked-tool matrix is intentionally inactive. |
| `subagent_spawn returns id` | `src/__tests__/vex-agent/tools/dispatcher-misc.test.ts` | Re-enable with `SUBAGENT_TOOLS` and dispatcher loaders; spawning is intentionally disabled. |
| `subagent_spawn fails without name` | `src/__tests__/vex-agent/tools/dispatcher-misc.test.ts` | Re-enable with `SUBAGENT_TOOLS` and dispatcher loaders; spawning is intentionally disabled. |
| `subagent_status returns empty when none active` | `src/__tests__/vex-agent/tools/dispatcher-misc.test.ts` | Re-enable with `SUBAGENT_TOOLS` and dispatcher loaders; status loading is intentionally disabled. |
