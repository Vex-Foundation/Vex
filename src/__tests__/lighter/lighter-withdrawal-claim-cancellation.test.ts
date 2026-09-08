import { requireValue } from "../helpers/require-value.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalSignedRequest, StagedBroadcastHooks } from "@tools/evm-chains/staged-broadcast.js";
import type { LighterWithdrawalClaimAttemptRow } from "@vex-agent/db/repos/lighter-withdrawal-claims.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const h = vi.hoisted(() => ({
  current: {} as LighterWithdrawalClaimAttemptRow,
  reserve: vi.fn(), stage: vi.fn(), admit: vi.fn(), send: vi.fn(), beforeSign: vi.fn(),
  release: vi.fn(), expire: vi.fn(), terminalize: vi.fn(),
  address: "0x1111111111111111111111111111111111111111" as const,
  txHash: `0x${"a".repeat(64)}` as `0x${string}`,
}));
vi.mock("@utils/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@vex-agent/tools/protocols/lighter/withdrawal-claim-approval-binding.js", () => ({ assertLighterWithdrawalClaimApprovalBinding: vi.fn() }));
vi.mock("@tools/lighter/wallet-funding/execution-lease.js", () => ({
  acquireLighterDepositExecutionLease: async () => ({ acquired: true, handle: { assertOwned: vi.fn(), releaseExecutionLease: h.release } }),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  withSessionControlLock: async (_id: string, fn: (client: object) => Promise<unknown>) => fn({}),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSigningWallet: () => ({ family: "eip155", address: h.address, privateKey: `0x${"1".repeat(64)}` }),
}));
vi.mock("@tools/uniswap/deployments.js", () => ({ getUniswapDeployment: () => ({ chainId: 1 }) }));
vi.mock("@tools/uniswap/evm-client.js", () => ({
  getUniswapEvmClients: () => ({ publicClient: { sendRawTransaction: h.send }, walletClient: { chain: { id: 1 } } }),
}));
vi.mock("@tools/lighter/withdrawal/core-claim.js", async (importOriginal) => ({
  ...await importOriginal<object>(),
  readLighterWithdrawalClaimPreflight: async () => ({}),
  assertLighterWithdrawalClaimPreflightWithinApproval: vi.fn(),
}));
vi.mock("@vex-agent/db/repos/evm-nonce-reservations.js", () => ({
  reserveLegacyEvmNonce: h.reserve, stageLegacyEvmNonce: vi.fn(),
  markLegacyEvmNonceAccepted: vi.fn(), terminalizeLegacyEvmNonce: h.terminalize,
}));
vi.mock("@vex-agent/db/repos/lighter-withdrawal-claims.js", () => ({
  findByClaimId: async () => h.current,
  markDecisionWith: async () => { h.current = { ...h.current, state: "approved" }; return h.current; },
  markStagedWith: h.stage, markSendAttemptStartedWith: h.admit,
  markUnsubmittedFailureWith: async () => true, markExpiredUnsubmittedWith: h.expire,
  markOutcomeWith: vi.fn(async () => true),
}));
/** The exact request the claim path would sign, as the fence hands it back. */
const FINAL_REQUEST: FinalSignedRequest = {
  to: h.address, data: "0x", value: 0n, gas: 200_000n, nonce: 7,
  gasPrice: undefined, maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 1_000_000n,
};
vi.mock("@tools/evm-chains/staged-broadcast.js", () => ({
  signStageBroadcast: async (_client: unknown, _signer: unknown, _tx: unknown, hooks: StagedBroadcastHooks) => {
    await hooks.onNonceReserved({ fromAddress: h.address, chainId: 1, nodePendingNonce: 7 });
    await hooks.onBeforeSign?.(FINAL_REQUEST);
    await h.beforeSign();
    await hooks.onHashStaged({ txHash: h.txHash, fromAddress: h.address, nonce: 7 });
    await h.send();
    return { kind: "ambiguous", stage: "send", txHash: h.txHash, reason: "fixture" };
  },
}));
const { LIGHTER_WITHDRAWAL_HANDLERS } = await import("@vex-agent/tools/protocols/lighter/handlers/withdrawal.js");
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
beforeEach(() => {
  vi.resetAllMocks();
  h.current = {
    claimId: "claim-1", sessionId: "session-1", withdrawalIntentId: "withdrawal-1", approvalId: "approval-1",
    operationClass: "manual_core_usdc_claim", expiresAt: new Date(Date.now() + 60000).toISOString(),
    walletAddress: h.address, gatewayAddress: h.address, gatewayImplementation: h.address,
    gatewayCodeHash: h.txHash, settlementTokenAddress: h.address, settlementTokenCodeHash: h.txHash,
    amountUnits: "1000000", calldata: "0x1234", preflightJson: {}, gasLimit: "100000",
    feeCeilingPerGasWei: "100", priorityFeeCeilingWei: "1", networkFeeCeilingWei: "10000000",
    txHash: null, state: "prepared",
  } as LighterWithdrawalClaimAttemptRow;
  h.reserve.mockResolvedValue({ id: 71, nonce: 7 });
  h.stage.mockImplementation(async (_client, input) => {
    h.current = { ...h.current, txHash: input.txHash, state: "staged" }; return h.current;
  });
  h.admit.mockResolvedValue(true); h.expire.mockResolvedValue(true);
  h.release.mockResolvedValue(undefined); h.beforeSign.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("manual claim consent hooks", () => {
  for (const kind of ["expiry", "cancellation"] as const) {
  it.each(["reservation", "signing", "staging", "send-admission"] as const)(`${kind} during %s cannot broadcast`, async (phase) => {
    const controller = new AbortController(), entered = gate(), finish = gate();
    const pause = async () => { entered.release(); await finish.promise; };
    if (phase === "reservation") h.reserve.mockImplementation(async () => { await pause(); return { id: 71, nonce: 7 }; });
    else if (phase === "signing") h.beforeSign.mockImplementation(pause);
    else if (phase === "staging") h.stage.mockImplementation(async (_client, input) => {
      h.current = { ...h.current, state: "staged", txHash: input.txHash }; await pause(); return h.current;
    });
    else h.admit.mockImplementation(async () => { await pause(); return true; });
    const context = { sessionId: "session-1", approved: true, approvalId: "approval-1", abortSignal: controller.signal } as ProtocolExecutionContext;
    const execution = requireValue(LIGHTER_WITHDRAWAL_HANDLERS["lighter.withdraw.claim"])({ claimId: "claim-1" }, context);
    await entered.promise;
    if (kind === "expiry") vi.spyOn(Date, "now").mockReturnValue(Date.parse(h.current.expiresAt));
    else controller.abort("lock");
    finish.release();
    await execution;
    expect(h.send).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
    if (phase !== "reservation") {
      expect(h.stage).toHaveBeenCalledOnce();
      expect(h.current.txHash).toBe(h.txHash);
    }
    if (phase === "send-admission") {
      expect(h.expire).not.toHaveBeenCalled();
      expect(h.terminalize).not.toHaveBeenCalled();
    } else if (phase !== "reservation") expect(h.expire).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ nonceReservationId: 71 }));
  });
  }
});
