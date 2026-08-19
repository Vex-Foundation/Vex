/**
 * D5 (funded live audit, 2026-08-18): `failure_reason` IS REDACTED AND NEVER
 * TRUNCATED.
 *
 * The write boundary used to redact and then slice at 500 characters. On a real
 * Morpho vault deposit that cut fell exactly where the money-relevant half of
 * the sentence began: the caller was told that a landed approval left spending
 * authority standing to GeneralAdapter1 and how to revoke it, while the durable
 * row - the one the ledger, the repair sweeps and agentscan read - stopped
 * mid-word before the disclosure. `agent_activity.failure_reason` is TEXT
 * (migration 044), so nothing about the column ever required the cut, and
 * CLAUDE.md is explicit that agent-facing content travels whole.
 *
 * The two halves are independent guarantees and only ONE of them was a safety
 * property. Both cases below exist so a future "let's bound it again" reinstates
 * a cap only by deleting the first case on purpose.
 */

import { describe, it, expect } from "vitest";

import { sanitizeFailureReason } from "@vex-agent/db/repos/agent-activity/validation.js";

/** The live Morpho ending whose remediation the old cap removed. */
const RESIDUAL_DISCLOSURE =
  "morpho.vault.deposit was refused before signing: the node simulated it against current state and proved it "
  + "reverts. Reason: execution reverted. NOTHING was signed or sent for this step, so no gas was spent on it. "
  + "The approval DID land before this failed, so GeneralAdapter1 (0x1111111111111111111111111111111111111111) can "
  + "still move 0.1 USDC from this wallet. It is capped at exactly this one operation's amount, not an open-ended "
  + "grant. Retrying the same deposit consumes it and grants nothing further; leaving it standing is also safe, and "
  + "it can be revoked by approving zero to that same spender.";

describe("sanitizeFailureReason", () => {
  it("keeps a long reason WHOLE, including the remediation that used to be cut off", () => {
    expect(RESIDUAL_DISCLOSURE.length).toBeGreaterThan(500);

    const sanitized = sanitizeFailureReason(RESIDUAL_DISCLOSURE);

    expect(sanitized).not.toContain("[truncated]");
    expect(sanitized).toContain("can be revoked by approving zero to that same spender");
    expect(sanitized).toContain("0.1 USDC");
  });

  it("still redacts, which is the guarantee that was never about length", () => {
    const secret = "provider refused: api_key=sk-live-abcdef0123456789abcdef0123456789";

    const sanitized = sanitizeFailureReason(secret);

    expect(sanitized).not.toContain("sk-live-abcdef0123456789abcdef0123456789");
    expect(sanitized).toContain("provider refused");
  });
});
