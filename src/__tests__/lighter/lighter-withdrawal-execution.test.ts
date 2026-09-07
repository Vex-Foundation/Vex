import { describe, expect, it, vi } from "vitest";

import { materialFromSecret } from "@tools/lighter/trading-secret.js";
import type { LighterCoreWithdrawalPreflightSnapshot } from "@tools/lighter/withdrawal/core-preflight.js";
import type { LighterRhcWithdrawalPreflightSnapshot } from "@tools/lighter/withdrawal/rhc-preflight.js";
import {
  executeApprovedLighterCoreWithdrawal,
  executeApprovedLighterWithdrawal,
  type ExecuteApprovedLighterCoreWithdrawalDeps,
} from "@vex-agent/tools/protocols/lighter/withdrawal-execution.js";
import type { LighterCoreWithdrawalReadyForSignerPlan } from "@vex-agent/tools/protocols/lighter/withdrawal-execution-plan.js";
import type { LighterWithdrawalReadyForSignerPlan } from "@vex-agent/tools/protocols/lighter/withdrawal-execution-plan.js";

const NOW = 1_893_456_000_000;
const PUBLIC_KEY = "b".repeat(80);
const PRIVATE_KEY = `0x${"1".repeat(80)}`;

function plan(): LighterCoreWithdrawalReadyForSignerPlan {
  return {
    intentId: "lighter-withdrawal-1",
    previewId: "lwp_preview",
    sessionId: "session-1",
    matchHash: "a".repeat(64),
    environment: "core",
    endpoint: "https://mainnet.zklighter.elliot.ai",
    signingChainId: 304,
    settlementChainId: 1,
    accountIndex: 737_810,
    apiKeyIndex: 4,
    walletAddress: "0xaCEE6141F6171491D34699C9266cb06A41FAA43C",
    destinationAddress: "0xaCEE6141F6171491D34699C9266cb06A41FAA43C",
    assetIndex: 3,
    assetDecimals: 6,
    settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    routeType: 0,
    amountUnits: "2000000",
    gatewayAddress: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
    gatewayImplementation: "0x8D692294a4824d868e35B3CEcd734aCf41B2342e",
    gatewayCodeHash: `0x${"1".repeat(64)}`,
    settlementTokenCodeHash: `0x${"2".repeat(64)}`,
    settlementScanFromBlock: "23456789",
    credentialReference: {
      kind: "encrypted_vault_reference",
      environment: "core",
      accountIndex: 737_810,
      apiKeyIndex: 4,
      vaultCredentialId: "lighter/core/account-737810/api-key-4",
    },
    nonceScope: { environment: "core", accountIndex: 737_810, apiKeyIndex: 4 },
  };
}

function preflight(): LighterCoreWithdrawalPreflightSnapshot {
  const p = plan();
  return {
    observedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 300_000).toISOString(),
    environment: "core",
    operationClass: "secure_l2_withdrawal",
    endpoint: p.endpoint,
    signingChainId: 304,
    settlementChainId: 1,
    settlementNetworkName: "Ethereum mainnet",
    accountIndex: p.accountIndex,
    apiKeyIndex: p.apiKeyIndex,
    walletAddress: p.walletAddress as `0x${string}`,
    destinationAddress: p.destinationAddress as `0x${string}`,
    assetIndex: 3,
    assetSymbol: "USDC",
    assetDecimals: 6,
    settlementTokenAddress: p.settlementTokenAddress as `0x${string}`,
    routeType: 0,
    amountUnits: p.amountUnits,
    minimumWithdrawalUnits: "1000000",
    availableBalanceUnits: "8000000",
    collateralUnits: "10000000",
    initialMarginRequirementUnits: "1000000",
    maintenanceMarginRequirementUnits: "500000",
    pendingOrderCount: 0,
    openPositionCount: 0,
    activeOrderCount: 0,
    nextNonce: "9",
    registeredPublicKey: PUBLIC_KEY,
    keyTransactionTime: "1893455000",
    withdrawalDelaySeconds: 1227,
    delayObservedAt: new Date(NOW).toISOString(),
    gatewayAddress: p.gatewayAddress as `0x${string}`,
    gatewayImplementationAddress: p.gatewayImplementation as `0x${string}`,
    gatewayCodeHash: p.gatewayCodeHash as `0x${string}`,
    settlementTokenCodeHash: p.settlementTokenCodeHash as `0x${string}`,
    settlementBlockNumber: p.settlementScanFromBlock,
    pendingBalanceUnits: "0",
    legacyPendingBalanceUnits: "0",
    withdrawalHistoryCount: 0,
    nonterminalWithdrawalCount: 0,
  };
}

function deps(events: string[], sendTx?: ExecuteApprovedLighterCoreWithdrawalDeps["client"]["sendTx"]): ExecuteApprovedLighterCoreWithdrawalDeps {
  return {
    secretReader: {
      readTradingApiPrivateKey: vi.fn(async () => {
        events.push("secret_read");
        return PRIVATE_KEY;
      }),
    },
    authSigner: {
      source: "official_lighter_signer",
      createAccountAuth: vi.fn(async (input) => {
        events.push("auth_signed");
        return {
          kind: "lighter_account_auth_signer_result" as const,
          environment: "core" as const,
          accountIndex: input.accountIndex,
          apiKeyIndex: input.apiKeyIndex,
          deadlineUnixSeconds: input.deadlineUnixSeconds,
          authToken: `${input.deadlineUnixSeconds}:${input.accountIndex}:${input.apiKeyIndex}:${"c".repeat(128)}`,
          publicKey: PUBLIC_KEY,
        };
      }),
      signCreateOrder: vi.fn(async () => { throw new Error("not used"); }),
    },
    withdrawalSigner: {
      source: "official_lighter_signer",
      signWithdraw: vi.fn(async (input) => {
        events.push("withdraw_signed");
        const result = {
          kind: "lighter_core_withdrawal_signer_result" as const,
          environment: "core" as const,
          accountIndex: input.accountIndex,
          apiKeyIndex: input.apiKeyIndex,
          nonce: input.nonce,
          expiredAt: input.expiredAt,
          assetIndex: 3 as const,
          routeType: 0 as const,
          amountUnits: input.amountUnits,
          matchHash: input.matchHash,
          txType: 13 as const,
          txInfo: "opaque-signed-payload",
          txHash: "lighter-tx-hash",
        };
        Object.defineProperty(result, "txInfo", { enumerable: false });
        return result;
      }),
    },
    client: {
      sendTx: sendTx ?? vi.fn(async () => {
        events.push("sendtx");
        return {
          code: 200,
          tx_hash: "lighter-tx-hash",
          predicted_execution_time_ms: 100,
          volume_quota_remaining: 99,
        };
      }),
    },
    readPreflight: vi.fn(async () => {
      events.push("preflight");
      return preflight();
    }),
    nonceState: {
      recordExecutionObserved: vi.fn(async () => {
        events.push("nonce_observed");
        return {};
      }),
    },
    reserveNonce: vi.fn(async () => {
      events.push("nonce_reserved");
      return { reservationId: "lighter-withdrawal:lighter-withdrawal-1", nonceValue: "9" };
    }),
    intents: {
      markPreSubmitRevalidated: vi.fn(async () => {
        events.push("preflight_persisted");
        return {};
      }),
      markSigned: vi.fn(async () => {
        events.push("signed_persisted");
        return {};
      }),
      markSubmissionStaged: vi.fn(async () => {
        events.push("submission_staged");
        return {};
      }),
      markApiAccepted: vi.fn(async () => {
        events.push("acceptance_persisted");
        return {};
      }),
      markAmbiguous: vi.fn(async () => {
        events.push("ambiguous_persisted");
        return {};
      }),
    },
    now: () => NOW,
  };
}

describe("approved Core withdrawal execution", () => {
  it("revalidates before secret access and stages durable identity before sendTx", async () => {
    const events: string[] = [];
    const result = await executeApprovedLighterCoreWithdrawal({ plan: plan(), deps: deps(events) });
    expect(result).toMatchObject({ status: "submitted", executionState: "api_accepted" });
    expect(events).toEqual([
      "preflight", "preflight_persisted", "secret_read", "auth_signed", "nonce_observed",
      "nonce_reserved", "withdraw_signed", "signed_persisted", "submission_staged",
      "sendtx", "acceptance_persisted",
    ]);
  });

  it("records unknown network outcome and never calls sendTx twice", async () => {
    const events: string[] = [];
    const send = vi.fn(async () => {
      events.push("sendtx");
      throw new Error("connection reset");
    });
    const result = await executeApprovedLighterCoreWithdrawal({
      plan: plan(),
      deps: deps(events, send),
    });
    expect(result).toMatchObject({ status: "ambiguous", reason: "sendtx_outcome_unknown" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toBe("ambiguous_persisted");
  });

  it("preserves an absolute provider execution timestamp above the 32-bit integer range", async () => {
    const events: string[] = [];
    const predictedExecutionTimeMs = 1_787_650_372_010;
    const d = deps(events, vi.fn(async () => ({
      code: 200,
      tx_hash: "lighter-tx-hash",
      predicted_execution_time_ms: predictedExecutionTimeMs,
    })));

    const result = await executeApprovedLighterCoreWithdrawal({ plan: plan(), deps: d });

    expect(result).toMatchObject({ status: "submitted", predictedExecutionTimeMs });
    expect(d.intents.markApiAccepted).toHaveBeenCalledWith(
      expect.objectContaining({ predictedExecutionTimeMs }),
    );
  });

  it("reports reconciliation-only ambiguity when acceptance persistence fails after submission", async () => {
    const events: string[] = [];
    const send = vi.fn(async () => {
      events.push("sendtx");
      return {
        code: 200,
        tx_hash: "lighter-tx-hash",
        predicted_execution_time_ms: 1_787_650_372_010,
      };
    });
    const base = deps(events, send);
    const d: ExecuteApprovedLighterCoreWithdrawalDeps = {
      ...base,
      intents: {
        ...base.intents,
        markApiAccepted: vi.fn(async () => {
          events.push("acceptance_persist_failed");
          throw new Error('value "1787650372010" is out of range for type integer');
        }),
      },
    };

    const result = await executeApprovedLighterCoreWithdrawal({ plan: plan(), deps: d });

    expect(result).toMatchObject({
      status: "ambiguous",
      executionState: "ambiguous",
      reason: "api_acceptance_persist_failed",
      signerTxHash: "lighter-tx-hash",
    });
    expect(result.message).toContain("will not retry blindly");
    expect(send).toHaveBeenCalledTimes(1);
    expect(events.slice(-2)).toEqual(["acceptance_persist_failed", "ambiguous_persisted"]);
  });

  it("refuses changed live amount/identity before reading the secret", async () => {
    const events: string[] = [];
    const d: ExecuteApprovedLighterCoreWithdrawalDeps = {
      ...deps(events),
      readPreflight: vi.fn(async () => ({ ...preflight(), amountUnits: "3000000" })),
    };
    await expect(executeApprovedLighterCoreWithdrawal({ plan: plan(), deps: d }))
      .rejects.toThrow("no longer matches");
    expect(events).not.toContain("secret_read");
    expect(d.client.sendTx).not.toHaveBeenCalled();
  });
});

describe("approved RHC withdrawal execution", () => {
  it("uses only the RHC auth, nonce, signer, endpoint, and settlement identity", async () => {
    const events: string[] = [];
    const rhcPlan: LighterWithdrawalReadyForSignerPlan = {
      ...plan(), intentId: "lighter-rhc-withdrawal-1", environment: "rhc",
      endpoint: "https://api.rh.lighter.xyz", signingChainId: 466324,
      settlementChainId: 4663,
      settlementTokenAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      gatewayAddress: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",
      gatewayImplementation: "0x82DE5B1161C93afDFE21bA0D5343f01Cd7401d90",
      credentialReference: { ...plan().credentialReference, environment: "rhc",
        vaultCredentialId: "lighter/rhc/account-737810/api-key-4" },
      nonceScope: { environment: "rhc", accountIndex: 737_810, apiKeyIndex: 4 },
    };
    const corePreflight = preflight();
    const rhcPreflight: LighterRhcWithdrawalPreflightSnapshot = {
      ...corePreflight, environment: "rhc", endpoint: rhcPlan.endpoint,
      signingChainId: 466324, settlementChainId: 4663,
      settlementNetworkName: "Robinhood Chain mainnet", assetSymbol: "USDG",
      settlementTokenAddress: rhcPlan.settlementTokenAddress as `0x${string}`,
      gatewayAddress: rhcPlan.gatewayAddress as `0x${string}`,
      gatewayImplementationAddress: rhcPlan.gatewayImplementation as `0x${string}`,
      legacyPendingBalanceUnits: "0",
    };
    const base = deps(events);
    const d: ExecuteApprovedLighterCoreWithdrawalDeps = {
      ...base,
      readPreflight: vi.fn(async () => rhcPreflight),
      authSigner: {
        ...base.authSigner,
        createAccountAuth: vi.fn(async (input) => ({
          kind: "lighter_account_auth_signer_result" as const, environment: "rhc" as const,
          accountIndex: input.accountIndex, apiKeyIndex: input.apiKeyIndex,
          deadlineUnixSeconds: input.deadlineUnixSeconds,
          authToken: `${input.deadlineUnixSeconds}:${input.accountIndex}:${input.apiKeyIndex}:${"c".repeat(128)}`,
          publicKey: PUBLIC_KEY,
        })),
      },
      withdrawalSigner: {
        source: "official_lighter_signer",
        signWithdraw: vi.fn(async (input) => {
          events.push("withdraw_signed");
          expect(input).toMatchObject({ environment: "rhc", chainId: 466324, assetIndex: 3, routeType: 0 });
          const result = { kind: "lighter_rhc_withdrawal_signer_result" as const,
            environment: "rhc" as const, accountIndex: input.accountIndex,
            apiKeyIndex: input.apiKeyIndex, nonce: input.nonce, expiredAt: input.expiredAt,
            assetIndex: 3 as const, routeType: 0 as const, amountUnits: input.amountUnits,
            matchHash: input.matchHash, txType: 13 as const, txInfo: "opaque-rhc-payload",
            txHash: "lighter-tx-hash" };
          Object.defineProperty(result, "txInfo", { enumerable: false });
          return result;
        }),
      },
      client: {
        sendTx: vi.fn(async (environment) => {
          expect(environment).toBe("rhc");
          events.push("sendtx");
          return { code: 200, tx_hash: "lighter-tx-hash", predicted_execution_time_ms: 100 };
        }),
      },
    };
    const result = await executeApprovedLighterWithdrawal({ plan: rhcPlan, deps: d });
    expect(result).toMatchObject({ status: "submitted", executionState: "api_accepted" });
    expect(result.message).toContain("RHC USDG");
  });
});
