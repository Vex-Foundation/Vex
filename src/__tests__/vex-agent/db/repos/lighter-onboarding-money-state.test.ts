import { describe, expect, it, vi } from "vitest";

import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";

describe("Lighter onboarding money-state participation", () => {
  it("maps an unresolved Lighter lifecycle row into a fail-closed reason", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          kind: "lighter_onboarding_unresolved",
          ref: "lighter-onboard-1",
          detail: "deposit_confirmed",
        }],
      }),
    };

    await expect(
      getUnresolvedMoneyStateForSession(client as never, "session-1"),
    ).resolves.toEqual({
      clear: false,
      reasons: [{
        kind: "lighter_onboarding_unresolved",
        ref: "lighter-onboard-1",
        detail: "deposit_confirmed",
      }],
    });

    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).toContain("FROM lighter_onboarding_intents l");
    expect(sql).toContain("l.execution_state NOT IN ('credited', 'failed')");
    expect(sql).toContain("l.approval_status = 'approval_pending' AND l.expires_at > NOW()");
    expect(params).toEqual(["session-1", 50]);
  });
});
