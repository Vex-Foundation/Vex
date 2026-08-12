import { describe, expect, it, vi } from "vitest";

import {
  configureLighterCreateOrderExecutionDeps,
  executeApprovedLighterCreateOrder,
  getConfiguredLighterCreateOrderExecutionDeps,
  type ExecuteApprovedLighterCreateOrderDeps,
} from "@vex-agent/tools/protocols/lighter/order-create-execution.js";
import type { LighterOrderReadyForSignerPlan } from "@vex-agent/tools/protocols/lighter/execution-plan.js";
import { buildLighterUnsignedCreateOrderRequest } from "@tools/lighter/signer-order.js";

const PRIVATE_KEY = `0x${"1".repeat(80)}`;
const TX_INFO = "{\"signed\":\"payload\"}";
const TX_HASH = "0xabc123";

const PLAN: LighterOrderReadyForSignerPlan = {
  intentId: "lighter-exec-1",
  sessionId: "session-1",
  previewId: "lighter-preview-1",
  matchHash: "a".repeat(64),
  environment: "rhc",
  accountIndex: 42,
  apiKeyIndex: 7,
  marketIndex: 0,
  side: "buy",
  baseAmountInteger: "10000",
  priceInteger: "300000",
  orderType: "limit",
  timeInForce: "good-till-time",
  reduceOnly: false,
  triggerPriceInteger: null,
  orderExpiryMs: 1893456000000,
  clientOrderIndexPolicy: "vex_assigned_uint48",
  providerVersion: "lighter-preview-v1",
  credentialReference: {
    kind: "encrypted_vault_reference",
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
    vaultCredentialId: "lighter/rhc/account-42/api-key-7",
  },
  nonceScope: {
    environment: "rhc",
    accountIndex: 42,
    apiKeyIndex: 7,
  },
};

const UNSIGNED_ORDER = buildLighterUnsignedCreateOrderRequest(PLAN);

function deps(overrides: Partial<ExecuteApprovedLighterCreateOrderDeps> = {}): ExecuteApprovedLighterCreateOrderDeps {
  return {
    liveTradingEnabled: vi.fn(() => true),
    secretReader: {
      readTradingApiPrivateKey: vi.fn(async () => PRIVATE_KEY),
    },
    reserveNonce: vi.fn(async () => ({
      kind: "lighter_order_nonce_reservation",
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      reservationId: `lighter-order:${PLAN.intentId}`,
      nonceValue: "0",
      environment: PLAN.environment,
      accountIndex: PLAN.accountIndex,
      apiKeyIndex: PLAN.apiKeyIndex,
    })),
    signer: {
      source: "official_lighter_signer",
      signCreateOrder: vi.fn(async (input) => ({
        kind: "lighter_create_order_signer_result",
        environment: input.environment,
        accountIndex: input.accountIndex,
        apiKeyIndex: input.apiKeyIndex,
        nonce: input.nonce,
        clientOrderIndex: input.order.clientOrderIndex,
        matchHash: input.order.matchHash,
        txType: 14,
        txInfo: TX_INFO,
        txHash: TX_HASH,
      })),
    },
    client: {
      sendTx: vi.fn(async () => ({
        code: 200,
        message: "ok",
        tx_hash: TX_HASH,
        predicted_execution_time_ms: 250,
        volume_quota_remaining: 99,
      })),
    },
    intents: {
      markSigned: vi.fn(async () => ({ ok: true }) as never),
      markSubmitted: vi.fn(async () => ({ ok: true }) as never),
      markApiAccepted: vi.fn(async () => ({
        executionState: "api_accepted",
        volumeQuotaRemaining: "99",
      }) as never),
      markAmbiguous: vi.fn(async () => ({ executionState: "ambiguous" }) as never),
    },
    ...overrides,
  };
}

describe("Lighter approved create execution pipeline", () => {
  it("configures and clears the privileged dependency registry", () => {
    const d = deps();
    const teardown = configureLighterCreateOrderExecutionDeps(d);

    expect(getConfiguredLighterCreateOrderExecutionDeps()).toBe(d);

    teardown();
    expect(getConfiguredLighterCreateOrderExecutionDeps()).toBeNull();
  });

  it("blocks at the release gate before reading key material or reserving a nonce", async () => {
    const d = deps({ liveTradingEnabled: vi.fn(() => false) });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("live trading is disabled");

    expect(d.secretReader.readTradingApiPrivateKey).not.toHaveBeenCalled();
    expect(d.reserveNonce).not.toHaveBeenCalled();
    expect(d.signer.signCreateOrder).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("signs with the privileged reader, submits once, and stores API acceptance metadata only", async () => {
    const d = deps();

    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    });

    expect(d.secretReader.readTradingApiPrivateKey).toHaveBeenCalledWith(PLAN.credentialReference);
    expect(d.reserveNonce).toHaveBeenCalledWith(PLAN);
    expect(d.signer.signCreateOrder).toHaveBeenCalledWith(expect.objectContaining({
      nonce: "0",
      order: expect.objectContaining({
        matchHash: PLAN.matchHash,
      }),
    }));
    expect(d.intents.markSigned).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      nonceReservationId: `lighter-order:${PLAN.intentId}`,
      nonceValue: "0",
      signerTxHash: TX_HASH,
    });
    expect(d.intents.markSubmitted).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      signerTxHash: TX_HASH,
    });
    expect(d.client.sendTx).toHaveBeenCalledWith("rhc", {
      txType: 14,
      txInfo: TX_INFO,
    });
    expect(d.intents.markApiAccepted).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      signerTxHash: TX_HASH,
      submittedTxHash: TX_HASH,
      submitCode: 200,
      submitMessage: "ok",
      predictedExecutionTimeMs: 250,
      volumeQuotaRemaining: 99,
    });
    expect(result).toMatchObject({
      status: "api_accepted",
      executionState: "api_accepted",
      signerTxHash: TX_HASH,
      submittedTxHash: TX_HASH,
    });
    expect(JSON.stringify(result)).not.toContain(TX_INFO);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_KEY);
  });

  it("marks send-time uncertainty ambiguous without exposing signed payloads", async () => {
    const d = deps({
      client: {
        sendTx: vi.fn(async () => {
          throw new Error(`provider echoed ${TX_INFO}`);
        }),
      },
    });

    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    });

    expect(result).toMatchObject({
      status: "ambiguous",
      reason: "sendtx_failed_after_submit_attempt",
      signerTxHash: TX_HASH,
    });
    expect(d.intents.markAmbiguous).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      reason: "sendtx_failed_after_submit_attempt",
    });
    expect(d.intents.markApiAccepted).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(TX_INFO);
  });

  it("marks a signer failure after nonce reservation ambiguous and never submits", async () => {
    const d = deps({
      signer: {
        source: "official_lighter_signer",
        signCreateOrder: vi.fn(async () => {
          throw new Error("signer unavailable");
        }),
      },
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("signer unavailable");

    expect(d.intents.markAmbiguous).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      reason: "signing_failed_after_nonce_reservation",
    });
    expect(d.intents.markSigned).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("does not submit when signed-state persistence fails after nonce reservation", async () => {
    const d = deps({
      intents: {
        ...deps().intents,
        markSigned: vi.fn(async () => null),
      },
    });

    await expect(executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    })).rejects.toThrow("could not persist signed state");

    expect(d.intents.markAmbiguous).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      reason: "signed_state_persist_failed",
    });
    expect(d.intents.markSubmitted).not.toHaveBeenCalled();
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });

  it("marks a provider hash mismatch ambiguous after submission", async () => {
    const d = deps({
      client: {
        sendTx: vi.fn(async () => ({
          code: 200,
          message: "ok",
          tx_hash: "0xdifferent",
          predicted_execution_time_ms: 250,
        })),
      },
    });

    const result = await executeApprovedLighterCreateOrder({
      plan: PLAN,
      unsignedOrder: UNSIGNED_ORDER,
      deps: d,
    });

    expect(result).toMatchObject({
      status: "ambiguous",
      reason: "provider_tx_hash_mismatch",
    });
    expect(d.intents.markAmbiguous).toHaveBeenCalledWith({
      intentId: PLAN.intentId,
      sessionId: PLAN.sessionId,
      environment: PLAN.environment,
      reason: "provider_tx_hash_mismatch",
    });
    expect(d.intents.markApiAccepted).not.toHaveBeenCalled();
  });
});
