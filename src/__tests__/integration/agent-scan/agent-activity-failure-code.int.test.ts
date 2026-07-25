/**
 * `agent_activity.failure_code` closed enum (plan §4.1 + C1 growth to 11
 * values — Codex spine-review round 1 finding 1/C1, bound in
 * `agents_dm/agent-scan-factory.md` "Coordinator addendum 1"):
 *   route_not_found, slippage, deadline_expired, insufficient_liquidity,
 *   allowance_or_balance, chain_unsupported, simulation_reverted,
 *   broadcast_error, confirmation_timeout, unknown, mined_revert.
 *
 * `mined_revert` is NEW (C1): the repair sweep's definitive "chain says
 * reverted" outcome, kept distinct from `simulation_reverted` (a pre-broadcast
 * simulate/send-time revert) and from `confirmation_timeout` (reserved,
 * ambiguity-never-terminalizes — see repair-sweep.test.ts).
 *
 * Contract pinned here: every listed code is accepted by the repo boundary
 * on a `definitively_failed` write; any OTHER string is rejected before it
 * reaches SQL (fail closed — a typo'd or model-invented code must not slip
 * past validation into a CHECK-constraint DB error, and must never be stored
 * as free text). This is a validation-boundary contract, not a DB-CHECK
 * integration test — the CHECK constraint in migration 044 is the
 * belt-and-suspenders backstop; this suite pins the TypeScript-level gate.
 *
 * FIX-W0 delta (finding 10's failure-code half + C13): every parameterized
 * case now seeds its OWN real `protocol_executions` row via
 * `_fixtures.ts#seedIntent` (previously all 10 cases reused the same
 * hardcoded `(protocolExecutionId=100, eventIndex=0)`, which is a single
 * shared, orphan, non-unique key — only the FIRST case could ever have
 * legitimately created a row, so the suite was not actually proving each
 * code independently). `failActivityEvent` now returns `{applied, row}` (C7).
 */
import { afterEach, describe, it, expect } from "vitest";
import { seedIntent, cleanupSeeded } from "./_fixtures.js";

afterEach(async () => {
  await cleanupSeeded();
});

const CLOSED_FAILURE_CODES = [
  "route_not_found",
  "slippage",
  "deadline_expired",
  "insufficient_liquidity",
  "allowance_or_balance",
  "chain_unsupported",
  "simulation_reverted",
  "broadcast_error",
  "confirmation_timeout",
  "unknown",
  "mined_revert",
  // W5 (migration 049, K1): a locally-staged Solana tx whose blockhash
  // proved expired before any signature status was ever observed.
  "solana_signature_expired",
] as const;

describe("agent_activity.failure_code — closed enum", () => {
  it.each(CLOSED_FAILURE_CODES)("accepts the plan §4.1/C1 code %s", async (code) => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    const outcome = await repo.failActivityEvent(event.id, { failureCode: code, failureReason: "bounded reason" });
    expect(outcome.applied).toBe(true);
    expect(outcome.row.failureCode).toBe(code);
  });

  it("rejects a failure_code outside the closed enum at the repo boundary (never reaches SQL)", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    await expect(
      repo.failActivityEvent(event.id, {
        // @ts-expect-error — deliberately outside the closed enum for this test.
        failureCode: "kyber_says_no",
        failureReason: "invented code",
      }),
    ).rejects.toThrow();
  });

  it("rejects an empty-string failure_code (must be a real enum member, not merely non-null)", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
    const event = await repo.createPendingActivityEvent({
      protocolExecutionId, eventIndex: 0, eventRole: "swap", kind: "swap",
      protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
    });
    await expect(
      repo.failActivityEvent(event.id, {
        // @ts-expect-error — deliberately invalid for this test.
        failureCode: "",
        failureReason: "empty code",
      }),
    ).rejects.toThrow();
  });
});
