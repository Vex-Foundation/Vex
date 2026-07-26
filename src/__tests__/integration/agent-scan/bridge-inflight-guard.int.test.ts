/**
 * In-flight bridge guard (C2 + Codex GREEN-LIGHT pin) against a REAL local
 * Postgres. The guard is a DB partial UNIQUE index keyed on
 * (wallet, session, normalized route) WHERE the logical row is pending, keyed so
 * it EXCLUDES provider/protocol — Khalani and Relay cannot race one route into
 * two in-flight bridges.
 *
 * Binding pin: two concurrent executes for the same wallet+session+route resolve
 * to EXACTLY ONE pending logical row (one `created`, one `in_flight_conflict`),
 * so no duplicate broadcast is possible. A different route is unaffected, and the
 * slot frees once the prior logical row reaches a terminal state.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, it, expect } from "vitest";
import { execute, query } from "../../../vex-agent/db/client.js";
import type {
  CreateBridgeActivityIntentInput,
  CreateBridgeActivityIntentResult,
} from "../../../vex-agent/db/repos/agent-activity.js";

const trackedExecutions: number[] = [];
function track(executionId: number): void {
  trackedExecutions.push(executionId);
}

afterEach(async () => {
  if (trackedExecutions.length === 0) return;
  const ids = trackedExecutions.splice(0, trackedExecutions.length);
  await execute(`DELETE FROM agent_activity WHERE protocol_execution_id = ANY($1::bigint[])`, [ids]);
  await execute(`DELETE FROM protocol_executions WHERE id = ANY($1::bigint[])`, [ids]);
});

function freshWallet(): string {
  return `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`;
}

function intentInput(
  walletAddress: string,
  sessionId: string,
  toChainId: number,
): CreateBridgeActivityIntentInput {
  return {
    toolId: "khalani.bridge",
    namespace: "khalani",
    protocol: "khalani",
    intentParams: { marker: `${sessionId}:${toChainId}` },
    walletAddress,
    sessionId,
    route: {
      fromChainId: 8453,
      fromChainSlug: "base",
      fromChainFamily: "eip155",
      fromToken: "0xUSDC",
      toChainId,
      toChainSlug: "dest",
      toChainFamily: "eip155",
      toToken: "0xUSDCe",
    },
    quoteRef: { quoteId: "Q" },
    legs: [
      { eventIndex: 0, eventRole: "bridge_deposit", chainId: 8453, chainSlug: "base", chainFamily: "eip155", tokenIn: { tokenSymbol: "USDC", amountRaw: "2000000" } },
    ],
    expectedFill: {
      eventIndex: 1,
      chainId: toChainId,
      chainSlug: "dest",
      chainFamily: "eip155",
      tokenOut: { tokenSymbol: "USDC", amountRaw: "1999000" },
    },
  };
}

function trackCreated(result: CreateBridgeActivityIntentResult): void {
  if (result.outcome === "created") track(result.executionId);
}

describe("bridge in-flight guard (C2)", () => {
  it("two concurrent executes for the same route resolve to exactly ONE pending logical row", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const wallet = freshWallet();
    const session = `bridge-guard-${randomUUID()}`;

    const [a, b] = await Promise.all([
      repo.createBridgeActivityIntent(intentInput(wallet, session, 42161)),
      repo.createBridgeActivityIntent(intentInput(wallet, session, 42161)),
    ]);
    trackCreated(a);
    trackCreated(b);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["created", "in_flight_conflict"]);

    const pending = await query<{ id: string }>(
      `SELECT id FROM agent_activity
        WHERE event_role = 'bridge_fill_expected' AND status = 'pending'
          AND wallet_address = $1 AND session_id = $2`,
      [wallet, session],
    );
    expect(pending).toHaveLength(1);

    // The loser persisted NOTHING (its transaction rolled back) — only the
    // winner's execution + rows exist.
    const conflict = a.outcome === "in_flight_conflict" ? a : b;
    if (conflict.outcome === "in_flight_conflict") {
      expect(conflict.existing).not.toBeNull();
    }
  });

  it("checkBridgeInFlight reflects the pending slot and frees once the logical row is terminal", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const wallet = freshWallet();
    const session = `bridge-guard-${randomUUID()}`;
    const input = intentInput(wallet, session, 10);

    const before = await repo.checkBridgeInFlight({
      walletAddress: wallet, sessionId: session, route: input.route,
    });
    expect(before.inFlight).toBe(false);

    const created = await repo.createBridgeActivityIntent(input);
    trackCreated(created);
    if (created.outcome !== "created") throw new Error("expected created");

    const during = await repo.checkBridgeInFlight({
      walletAddress: wallet, sessionId: session, route: input.route,
    });
    expect(during.inFlight).toBe(true);
    expect(during.existing?.id).toBe(created.expectedFill.id);

    // A second execute while pending is rejected by the DB guard.
    const blocked = await repo.createBridgeActivityIntent(input);
    trackCreated(blocked);
    expect(blocked.outcome).toBe("in_flight_conflict");

    // Terminalize the logical row; the slot frees and a new execute succeeds.
    await repo.confirmBridgeExpectedFill({
      executionId: created.executionId,
      txHash: "0xfill-guard",
      evidenceSource: "khalani_order_status",
    });
    const after = await repo.checkBridgeInFlight({
      walletAddress: wallet, sessionId: session, route: input.route,
    });
    expect(after.inFlight).toBe(false);

    const retry = await repo.createBridgeActivityIntent(input);
    trackCreated(retry);
    expect(retry.outcome).toBe("created");
  });

  it("a different route is not blocked by an in-flight bridge on another route", async () => {
    const repo = await import("../../../vex-agent/db/repos/agent-activity.js");
    const wallet = freshWallet();
    const session = `bridge-guard-${randomUUID()}`;

    const [a, b] = await Promise.all([
      repo.createBridgeActivityIntent(intentInput(wallet, session, 42161)),
      repo.createBridgeActivityIntent(intentInput(wallet, session, 10)),
    ]);
    trackCreated(a);
    trackCreated(b);
    expect(a.outcome).toBe("created");
    expect(b.outcome).toBe("created");
  });
});
