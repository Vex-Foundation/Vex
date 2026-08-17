import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  LIGHTER_ONBOARDING_WORKFLOW_STATES,
  ensureLighterOnboardingWorkflowEnabledWith,
  transitionLighterOnboardingWorkflowWith,
  type LighterOnboardingWorkflowState,
} from "@vex-agent/db/repos/lighter-onboarding-workflows.js";

const WALLET = "0xaCEE6141F6171491D34699C9266cb06A41FAA43C";
const NOW = new Date("2030-01-01T00:00:00.000Z");

const VALID_TRANSITIONS: Readonly<
  Record<LighterOnboardingWorkflowState, readonly LighterOnboardingWorkflowState[]>
> = {
  integration_enabled: ["deposit_approval_pending", "failed"],
  deposit_approval_pending: [
    "deposit_preflight_validated",
    "allowance_verified",
    "approve_staged",
    "ambiguous",
    "failed",
  ],
  deposit_preflight_validated: [
    "allowance_verified",
    "approve_staged",
    "ambiguous",
    "failed",
  ],
  allowance_verified: ["deposit_staged", "ambiguous", "failed"],
  approve_staged: ["approve_confirmed", "ambiguous", "failed"],
  approve_confirmed: ["deposit_staged", "ambiguous", "failed"],
  deposit_staged: [
    "deposit_l1_confirmed",
    "deposit_l2_pending",
    "ambiguous",
    "failed",
  ],
  deposit_l1_confirmed: ["deposit_l2_pending", "ambiguous", "failed"],
  deposit_l2_pending: ["account_resolved", "ambiguous", "failed"],
  account_resolved: ["deposit_approval_pending", "key_generated_encrypted", "failed"],
  key_generated_encrypted: ["key_registration_approval_pending", "failed"],
  key_registration_approval_pending: [
    "change_pub_key_submitted",
    "ambiguous",
    "failed",
  ],
  change_pub_key_submitted: ["key_verified", "ambiguous", "failed"],
  key_verified: ["nonce_synchronized", "failed"],
  nonce_synchronized: ["ready_to_trade", "failed"],
  ready_to_trade: ["deposit_approval_pending", "failed"],
  ambiguous: [
    "approve_confirmed",
    "deposit_l1_confirmed",
    "deposit_l2_pending",
    "account_resolved",
    "key_verified",
    "failed",
  ],
  failed: ["deposit_approval_pending", "key_generated_encrypted"],
};

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

  it("accepts every declared workflow transition", async () => {
    for (const current of LIGHTER_ONBOARDING_WORKFLOW_STATES) {
      for (const nextState of VALID_TRANSITIONS[current]) {
        const client = {
          query: vi.fn().mockResolvedValueOnce({
            rows: [row(nextState)],
            rowCount: 1,
          }),
        };

        const result = await transitionLighterOnboardingWorkflowWith(
          client as never,
          {
            environment: "core",
            walletAddress: WALLET,
            expectedStates: [current],
            nextState,
          },
        );

        expect(result?.workflowState, `${current} -> ${nextState}`).toBe(nextState);
        expect(client.query, `${current} -> ${nextState}`).toHaveBeenCalledOnce();
      }
    }
  });

  it("rejects every undeclared workflow state pair before querying", async () => {
    for (const current of LIGHTER_ONBOARDING_WORKFLOW_STATES) {
      for (const nextState of LIGHTER_ONBOARDING_WORKFLOW_STATES) {
        if (VALID_TRANSITIONS[current].includes(nextState)) continue;
        const client = { query: vi.fn() };

        await expect(
          transitionLighterOnboardingWorkflowWith(client as never, {
            environment: "core",
            walletAddress: WALLET,
            expectedStates: [current],
            nextState,
          }),
          `${current} -> ${nextState}`,
        ).rejects.toThrow("Invalid Lighter onboarding workflow transition");
        expect(client.query, `${current} -> ${nextState}`).not.toHaveBeenCalled();
      }
    }
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

  it("backfills upgraded deposit workflows from durable public evidence", async () => {
    const sql = await readFile(
      new URL(
        "../../vex-agent/db/migrations/092_lighter_workflow_deposit_backfill.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(sql).toContain("DISTINCT ON (environment, LOWER(wallet_address))");
    expect(sql).toContain("deposit.execution_state = 'deposit_submitted'");
    expect(sql).toContain("THEN 'deposit_staged'");
    expect(sql).toContain("deposit.execution_state = 'ambiguous'");
    expect(sql).toContain("active_deposit_intent_id = deposit.intent_id");
    expect(sql).toContain("resolved_account_index = deposit.resolved_account_index");
    expect(sql).not.toMatch(/private_key|signed_payload|auth_token/i);
  });

  it("persists complete public L1 and L2 evidence without credential material", async () => {
    const sql = await readFile(
      new URL(
        "../../vex-agent/db/migrations/093_lighter_deposit_evidence.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(sql).toContain("deposit_l1_block_hash");
    expect(sql).toContain("deposit_event_account_index");
    expect(sql).toContain("lighter_evidence_observed_at");
    expect(sql).toContain("lighter_onboarding_intents_l1_evidence_complete");
    expect(sql).toContain("lighter_onboarding_intents_l2_evidence_complete");
    expect(sql).not.toMatch(/private_key|signed_payload|auth_token/i);
  });
});
