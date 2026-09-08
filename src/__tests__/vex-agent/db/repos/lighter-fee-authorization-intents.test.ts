import { Client } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ queryOne: vi.fn(), queryOneWith: vi.fn() }));
vi.mock("@vex-agent/db/client.js", () => db);
const repo = await import("@vex-agent/db/repos/lighter-fee-authorization-intents.js");
const client = Object.assign(new Client(), { release: vi.fn() });
beforeEach(() => { vi.resetAllMocks(); db.queryOne.mockResolvedValue(null); db.queryOneWith.mockResolvedValue(null); });
describe("fee signing and submission evidence", () => {
  it("records the signing timestamp once and permits evidence persistence after consent expiry", async () => {
    await repo.transitionLighterFeeAuthorizationWith(client, { intentId: "intent-1", sessionId: "session-1",
      expectedStates: ["signing"], nextState: "signing", txHash: "a".repeat(80) });
    const sql = db.queryOneWith.mock.calls[0]?.[1] as string;
    expect(sql).toContain("COALESCE(signed_at,clock_timestamp())");
    expect(sql).toContain("$4=execution_state OR expires_at > clock_timestamp()");
  });
  it("retires an unsubmitted signed intent and its exact nonce atomically", async () => {
    await repo.transitionLighterFeeAuthorizationWith(client, { intentId: "intent-1", sessionId: "session-1",
      expectedStates: ["submission_staged"], nextState: "expired_unsubmitted", failureReason: "consent_expired_after_signing" });
    const sql = db.queryOneWith.mock.calls[0]?.[1] as string;
    expect(sql).toContain("send_attempt_started_at IS NULL");
    expect(sql).toContain("execution_state IN ('signing','submission_staged')");
    expect(sql).toContain("released AS");
    expect(sql).toContain("n.reservation_id='lighter-fees:' || r.intent_id");
    expect(sql).toContain("n.reserved_nonce=r.nonce_value");
  });
  it("gates the final possible-send marker on the current database clock", async () => {
    expect(await repo.markSendAttemptStarted({ intentId: "intent-1", sessionId: "session-1", txHash: "a".repeat(80) })).toBe(false);
    const sql = db.queryOne.mock.calls[0]?.[0] as string;
    expect(sql).toContain("send_attempt_started_at=clock_timestamp()");
    expect(sql).toContain("send_attempt_started_at IS NULL AND expires_at > clock_timestamp()");
  });
});
