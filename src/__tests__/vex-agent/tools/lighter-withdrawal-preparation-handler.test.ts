import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LighterCoreWithdrawalPreflightSnapshot } from "@tools/lighter/withdrawal/core-preflight.js";
import type { CreateLighterWithdrawalIntentInput } from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";
import { makeProtocolContext } from "./_test-context.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const mocks = vi.hoisted(() => ({
  account: vi.fn(), preflight: vi.fn(), create: vi.fn(), nonterminal: vi.fn(),
  auth: vi.fn(), signingWallet: vi.fn(), sendTx: vi.fn(),
}));

vi.mock("@tools/lighter/client.js", () => ({ getLighterClient: () => ({
  getAccount: mocks.account, sendTx: mocks.sendTx,
}) }));
vi.mock("@tools/lighter/withdrawal/core-preflight.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tools/lighter/withdrawal/core-preflight.js")>(),
  readLighterCoreWithdrawalPreflight: mocks.preflight,
}));
vi.mock("@vex-agent/tools/protocols/lighter/read-account-auth.js", () => ({
  resolveLighterReadOnlyAccountAuth: mocks.auth,
}));
vi.mock("@vex-agent/tools/protocols/lighter/trading-credential-scope.js", () => ({
  listLighterTradingCredentialScopes: () => [{ environment: "core", accountIndex: 42, apiKeyIndex: 7 }],
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => OWNER,
  resolveSigningWallet: mocks.signingWallet,
  walletScopeErrorToResult: vi.fn(),
}));
vi.mock("@tools/uniswap/evm-client.js", () => ({ getUniswapPublicClient: () => ({}) }));
vi.mock("@vex-agent/db/repos/lighter-withdrawal-intents.js", () => ({
  findNonterminalForScope: mocks.nonterminal,
  createOrFindLiveApprovalPendingWith: mocks.create,
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLocks: async (_ids: string[], work: (db: object) => Promise<unknown>) => work({}),
}));

const { LIGHTER_WITHDRAWAL_HANDLERS } = await import("@vex-agent/tools/protocols/lighter/handlers/withdrawal.js");

function snapshot(): LighterCoreWithdrawalPreflightSnapshot {
  const deployment = getLighterFundingDeployment("core");
  const observedAt = new Date().toISOString();
  return {
    observedAt, expiresAt: new Date(Date.now() + 120_000).toISOString(),
    environment: "core", operationClass: "secure_l2_withdrawal",
    endpoint: "https://mainnet.zklighter.elliot.ai", signingChainId: 304,
    settlementChainId: 1, settlementNetworkName: "Ethereum mainnet",
    accountIndex: 42, apiKeyIndex: 7, walletAddress: OWNER, destinationAddress: OWNER,
    assetIndex: 3, assetSymbol: "USDC", assetDecimals: 6,
    settlementTokenAddress: deployment.settlementTokenProxy, routeType: 0,
    amountUnits: "2000000", minimumWithdrawalUnits: "1000000",
    availableBalanceUnits: "8000000", collateralUnits: "10000000",
    initialMarginRequirementUnits: "0", maintenanceMarginRequirementUnits: "0",
    pendingOrderCount: 0, openPositionCount: 0, activeOrderCount: 0,
    nextNonce: "9", registeredPublicKey: "b".repeat(80), keyTransactionTime: "1",
    withdrawalDelaySeconds: 360, delayObservedAt: observedAt,
    gatewayAddress: deployment.gatewayProxy,
    gatewayImplementationAddress: deployment.expectedGatewayImplementation!,
    gatewayCodeHash: `0x${"1".repeat(64)}`, settlementTokenCodeHash: `0x${"2".repeat(64)}`,
    settlementBlockNumber: "1234", pendingBalanceUnits: "0", legacyPendingBalanceUnits: "0",
    withdrawalHistoryCount: 0, nonterminalWithdrawalCount: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.account.mockResolvedValue({ code: 200, accounts: [{ index: 42, l1_address: OWNER }] });
  mocks.auth.mockResolvedValue({ source: "test-account-auth" });
  mocks.preflight.mockResolvedValue(snapshot());
  mocks.nonterminal.mockResolvedValue(null);
  mocks.create.mockImplementation(async (_db: object, input: CreateLighterWithdrawalIntentInput) => ({
    outcome: "created",
    intent: {
      ...input.preview.snapshot,
      intentId: input.intentId, sessionId: input.preview.identity.sessionId,
      previewId: input.preview.previewId, matchHash: input.preview.matchHash,
      initialMarginUnits: input.preview.snapshot.initialMarginRequirementUnits,
      gatewayImplementation: input.preview.snapshot.gatewayImplementationAddress,
      preflightObservedAt: input.preview.snapshot.observedAt,
      approvalStatus: "approval_pending", executionState: "approval_pending",
    },
  }));
});

describe("lighter.withdraw.prepare handler", () => {
  const context = makeProtocolContext({ sessionId: "withdrawal-preparation-test" });

  it("binds the exact amount and owning wallet to one durable approval without signing", async () => {
    const result = await LIGHTER_WITHDRAWAL_HANDLERS["lighter.withdraw.prepare"]!(
      { environment: "core", amountIn: "2" }, context);

    expect(result.success, result.output).toBe(true);
    expect(mocks.preflight).toHaveBeenCalledWith(expect.objectContaining({
      accountIndex: 42, apiKeyIndex: 7, walletAddress: OWNER, amountUnits: 2_000_000n,
    }));
    expect(result.preparedActionFollowUp).toMatchObject({
      args: { toolId: "lighter.withdraw" },
      approvalPreview: { criticalArgs: {
        amountUnits: "2000000", destinationAddress: OWNER, environment: "core", route: "secure",
      } },
    });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.signingWallet).not.toHaveBeenCalled();
    expect(mocks.sendTx).not.toHaveBeenCalled();
  });

  it("refuses a saved credential belonging to another wallet before preparing", async () => {
    mocks.account.mockResolvedValue({ code: 200, accounts: [{
      index: 42, l1_address: "0x2222222222222222222222222222222222222222",
    }] });
    const result = await LIGHTER_WITHDRAWAL_HANDLERS["lighter.withdraw.prepare"]!(
      { environment: "core", amountIn: "2" }, context);

    expect(result.success).toBe(false);
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.signingWallet).not.toHaveBeenCalled();
  });

  it("does not prepare while account authorization is unavailable", async () => {
    mocks.auth.mockResolvedValue(null);
    const result = await LIGHTER_WITHDRAWAL_HANDLERS["lighter.withdraw.prepare"]!(
      { environment: "core", amountIn: "2" }, context);

    expect(result.success).toBe(false);
    expect(result.output).toContain("vault must be unlocked");
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
