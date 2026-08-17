import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  LIGHTER_ONBOARDING_WORKFLOW_STATES,
  ensureLighterOnboardingWorkflowEnabledWith,
  transitionLighterOnboardingWorkflowWith,
} from "@vex-agent/db/repos/lighter-onboarding-workflows.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const NOW = new Date("2030-01-01T00:00:00.000Z");

function row(state = "integration_enabled") {
  return {
    environment: "core",
    wallet_address: WALLET.toLowerCase(),
    workflow_state: state,
    last_stable_state: state,
    active_deposit_intent_id: null,
    resolved_account_index: null,
    api_key_index: null,
    public_key_fingerprint: null,
    failure_code: null,
    revision: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

describe("Lighter onboarding workflow foundation", () => {
  it("declares the complete deposit, account, key, nonce, and readiness lifecycle", () => {
    expect(LIGHTER_ONBOARDING_WORKFLOW_STATES).toEqual([
      "integration_enabled",
      "deposit_approval_pending",
      "deposit_preflight_validated",
      "allowance_verified",
      "approve_staged",
      "approve_confirmed",
      "deposit_staged",
      "deposit_l1_confirmed",
      "deposit_l2_pending",
      "account_resolved",
      "key_generated_encrypted",
      "key_registration_approval_pending",
      "change_pub_key_submitted",
      "key_verified",
      "nonce_synchronized",
      "ready_to_trade",
      "ambiguous",
      "failed",
    ]);
  });

  it("creates one lower-cased wallet workflow at activation", async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [row()], rowCount: 1 }),
    };

    const result = await ensureLighterOnboardingWorkflowEnabledWith(
      client as never,
      "core",
      WALLET,
    );

    expect(result.workflowState).toBe("integration_enabled");
    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).toContain("ON CONFLICT (environment, wallet_address)");
    expect(params).toEqual(["core", WALLET]);
  });

  it("performs a checked state CAS and increments the revision", async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [row("deposit_approval_pending")],
        rowCount: 1,
      }),
    };

    const result = await transitionLighterOnboardingWorkflowWith(client as never, {
      environment: "core",
      walletAddress: WALLET,
      expectedStates: ["integration_enabled"],
      nextState: "deposit_approval_pending",
      activeDepositIntentId: "lighter-onboard-1",
    });

    expect(result?.workflowState).toBe("deposit_approval_pending");
    const [sql, params] = client.query.mock.calls[0]!;
    expect(sql).toContain("workflow_state = ANY($3)");
    expect(sql).toContain("revision = revision + 1");
    expect(params).toEqual([
      "core",
      WALLET,
      ["integration_enabled"],
      "deposit_approval_pending",
      "lighter-onboard-1",
      null,
      null,
      null,
      null,
    ]);
  });

  it("returns null when another writer already changed the expected state", async () => {
    const client = {
      query: vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    };

    await expect(
      transitionLighterOnboardingWorkflowWith(client as never, {
        environment: "core",
        walletAddress: WALLET,
        expectedStates: ["integration_enabled"],
        nextState: "deposit_approval_pending",
      }),
    ).resolves.toBeNull();
  });

  it("rejects an invalid transition before touching the database", async () => {
    const client = { query: vi.fn() };

    await expect(
      transitionLighterOnboardingWorkflowWith(client as never, {
        environment: "core",
        walletAddress: WALLET,
        expectedStates: ["integration_enabled"],
        nextState: "ready_to_trade",
      }),
    ).rejects.toThrow("Invalid Lighter onboarding workflow transition");
    expect(client.query).not.toHaveBeenCalled();
  });

  it("migration keys one public workflow by environment and wallet", async () => {
    const sql = await readFile(
      new URL(
        "../../vex-agent/db/migrations/091_lighter_onboarding_workflows.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(sql).toContain("PRIMARY KEY (environment, wallet_address)");
    expect(sql).toContain("'ready_to_trade'");
    expect(sql).toContain("'ambiguous'");
    expect(sql).toContain("INSERT INTO lighter_onboarding_workflows");
    expect(sql).not.toMatch(/private_key|signed_payload|auth_token/i);
  });
});
