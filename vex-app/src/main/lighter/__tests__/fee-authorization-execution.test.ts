import { requireValue } from "../../../../../src/__tests__/helpers/require-value.js";
import { describe, expect, it, vi } from "vitest";
import type { EvmWallet } from "@tools/wallet/multi-auth.js";
import type { LighterFeeAuthorizationIntentRow } from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import type { LighterNonceStateRow } from "@vex-agent/db/repos/lighter-nonce-state.js";
import {
  executeApprovedLighterFeeAuthorization,
  reconcileLighterFeeAuthorization,
  type LighterFeeAuthorizationExecutionDeps,
} from "../fee-authorization-execution.js";
import {
  buildLighterFeeAuthorizationTerms,
  feePolicyForStoredIntent,
  type LighterFeeAuthorizationObserved,
} from "../fee-authorization-preparation.js";
import type { LighterApproveIntegratorSignerResult } from "@tools/lighter/signer-integrator.js";
import {
  createLighterApiKeyGeneratorBinary,
  createLighterSignerBinaryApproveIntegratorAdapter,
  type LighterSignerBinaryRunner,
} from "@tools/lighter/signer-binary-adapter.js";
import {
  signerRunnerEmitting,
  signerRunnerExitingWithoutOutput,
  signerRunnerNeverClosing,
  signerRunnerRejectingWithoutEvidence,
} from "../../../../../src/__tests__/helpers/lighter-scripted-signer.js";
import { signApprovedLighterFeeAuthorization } from "../fee-authorization-signing.js";
import { LIGHTER_TRADING_CREDENTIAL_ACTIVE_STATE } from "../../secrets/lighter-trading-credential.js";

const NOW = Date.parse("2030-01-01T00:00:00Z"),
  HASH = "cd".repeat(40),
  KEY = "ab".repeat(40);
const wallet: EvmWallet = {
  family: "eip155",
  address: `0x${"1".repeat(40)}`,
  privateKey: `0x${"2".repeat(64)}`,
};
const input = {
  sessionId: "session-1",
  intentId: "lighter-fees-00000000-0000-4000-8000-000000000001",
  walletResolution: { source: "default" } as const,
  walletPolicy: { kind: "none" } as const,
};

function setup(
  options: {
    tier?: string;
    state?: LighterFeeAuthorizationIntentRow["executionState"];
    confirmed?: boolean;
    revoke?: boolean;
    now?: number;
    consumed?: boolean;
  } = {},
) {
  let tier = options.tier ?? "plus",
    consumed = options.consumed ?? false,
    confirmed = options.confirmed ?? false;
  let current: LighterFeeAuthorizationIntentRow = {
    ...input,
    environment: "core",
    walletAddress: wallet.address,
    accountIndex: 42,
    apiKeyIndex: 4,
    terms: {
      collectorAccountIndex: 99,
      collectorL1Address: `0x${"3".repeat(40)}`,
      maxPerpsMakerFee: options.revoke ? 0 : 1000,
      maxPerpsTakerFee: options.revoke ? 0 : 1000,
      maxSpotMakerFee: options.revoke ? 0 : 2500,
      maxSpotTakerFee: options.revoke ? 0 : 2500,
      authorizationExpiryMs: options.revoke ? 0 : NOW + 315360000000,
      revoke: options.revoke ?? false,
      publicKey: KEY,
      currentTier: tier,
      targetTier: tier === "standard" && !options.revoke ? "plus" : null,
      exchangeMakerFeeTick: 50,
      exchangeTakerFeeTick: 50,
      currentExchangeMakerFeeTick: 50,
      currentExchangeTakerFeeTick: 50,
    },
    approvalId: "approval-1",
    approvalStatus: "approved",
    executionState: options.state ?? "approved",
    nonceValue: options.state ? "7" : null,
    txHash: options.state ? HASH : null,
    txExpiryMs: options.state ? NOW + 240000 : null,
    failureReason: null,
    expiresAt: new Date(NOW + 900000),
    verifiedAt: null,
  };
  const observed = (): LighterFeeAuthorizationObserved => ({
    walletAddress: wallet.address,
    accountIndex: 42,
    apiKeyIndex: 4,
    publicKey: KEY,
    auth: { token: "fixture-auth", accountIndex: 42 },
    policy: {
      environment: "core",
      collectorAccountIndex: 99,
      collectorL1Address: `0x${"3".repeat(40)}`,
      perpsMakerFee: 1000,
      perpsTakerFee: 1000,
      spotMakerFee: 2500,
      spotTakerFee: 2500,
    },
    limits: {
      code: 200,
      user_tier: tier,
      user_tier_name: tier,
      current_maker_fee_tick: 50,
      current_taker_fee_tick: 50,
    },
    account: {
      account_index: 42,
      l1_address: wallet.address,
      approved_integrators:
        confirmed && !options.revoke
          ? [
              {
                account_index: 99,
                name: "VEX",
                max_perps_maker_fee: 1000,
                max_perps_taker_fee: 1000,
                max_spot_maker_fee: 2500,
                max_spot_taker_fee: 2500,
                approval_expiry: current.terms.authorizationExpiryMs,
              },
            ]
          : [],
    },
  });
  const events: string[] = [];
  const nonce: LighterNonceStateRow = {
    environment: "core",
    accountIndex: 42,
    apiKeyIndex: 4,
    providerNonce: "7",
    publicKey: KEY,
    providerTransactionTime: null,
    status: "observed",
    reservedNonce: null,
    reservationId: null,
    source: "fixture",
    observedAt: "",
    updatedAt: "",
  };
  const deps: LighterFeeAuthorizationExecutionDeps = {
    client: {
      getNextNonce: vi.fn(async () => ({ code: 200, nonce: consumed ? 8 : 7 })),
      changeAccountTier: vi.fn(async () => {
        events.push("changeTier");
        tier = "plus";
        return { code: 200 };
      }),
      getTx: vi.fn(async () => {
        throw new Error("not found");
      }),
      sendTx: vi.fn(async () => {
        events.push("send");
        consumed = true;
        confirmed = true;
        return { code: 200, tx_hash: HASH, predicted_execution_time_ms: 0 };
      }),
    },
    readIntent: vi.fn(async () => current),
    readSetup: vi.fn(async () => observed()),
    transition: vi.fn(async (_intent, state, details) => {
      events.push(state);
      current = {
        ...current,
        executionState: state,
        ...(details?.txHash ? { txHash: details.txHash } : {}),
        failureReason: details?.failureReason ?? current.failureReason,
      };
      return current;
    }),
    reserveSigning: vi.fn(async (_intent, expiry) => {
      events.push("reserve");
      current = {
        ...current,
        executionState: "signing",
        nonceValue: "7",
        txExpiryMs: expiry,
      };
      return current;
    }),
    recordNonce: vi.fn(async () => nonce),
    admitSend: vi.fn(async () => true),
    releaseUnsubmittedNonce: vi.fn(async () => null),
    releaseNonce: vi.fn(async () => nonce),
    resolveWallet: vi.fn(() => wallet),
    selectedAddress: vi.fn(() => wallet.address),
    sign: vi.fn(async () => {
      events.push("sign");
      return {
        kind: "lighter_approve_integrator_signer_result",
        environment: "core",
        accountIndex: 42,
        apiKeyIndex: 4,
        nonce: "7",
        expiredAt: String(current.txExpiryMs),
        integratorAccountIndex: 99,
        maxPerpsMakerFee: current.terms.maxPerpsMakerFee,
        maxPerpsTakerFee: current.terms.maxPerpsTakerFee,
        maxSpotMakerFee: current.terms.maxSpotMakerFee,
        maxSpotTakerFee: current.terms.maxSpotTakerFee,
        approvalExpiry: current.terms.authorizationExpiryMs,
        expectedL1Address: wallet.address,
        messageToSign: "fixture",
        txType: 45,
        txInfo: "fixture",
        txHash: HASH,
      } satisfies LighterApproveIntegratorSignerResult;
    }),
    now: vi.fn(() => options.now ?? NOW),
    sleep: vi.fn(async () => {}),
    attempts: 1,
  };
  return {
    deps,
    events,
    observed,
    current: () => current,
    setCurrent: (patch: Partial<LighterFeeAuthorizationIntentRow>) => {
      current = { ...current, ...patch };
    },
    confirm: () => {
      consumed = true;
      confirmed = true;
    },
  };
}

describe("Lighter fee authorization lifecycle", () => {
  it("reserves durably, signs once, stages before sending and confirms native allowance", async () => {
    const h = setup();
    expect(
      (await executeApprovedLighterFeeAuthorization(input, h.deps)).status,
    ).toBe("active");
    expect(h.events).toEqual([
      "reserve",
      "sign",
      "signing",
      "submission_staged",
      "send",
      "submitted",
      "active",
    ]);
    expect(h.deps.sign).toHaveBeenCalledTimes(1);
    expect(h.deps.client.sendTx).toHaveBeenCalledTimes(1);
  });
  it("performs only the approved tier upgrade before authorizing fees", async () => {
    const h = setup({ tier: "standard" });
    expect(
      (await executeApprovedLighterFeeAuthorization(input, h.deps)).status,
    ).toBe("active");
    expect(h.events.slice(0, 3)).toEqual([
      "tier_change_staged",
      "changeTier",
      "tier_ready",
    ]);
  });
  it("refuses changed exchange fees before reserving or signing", async () => {
    const h = setup();
    vi.mocked(h.deps.readSetup).mockImplementation(async () => ({
      ...h.observed(),
      limits: { ...h.observed().limits, current_taker_fee_tick: 51 },
    }));
    await expect(
      executeApprovedLighterFeeAuthorization(input, h.deps),
    ).rejects.toThrow("exchange fees differ");
    expect(h.deps.sign).not.toHaveBeenCalled();
    expect(h.deps.reserveSigning).not.toHaveBeenCalled();
  });
  it("does not sign or submit twice after a timeout or restart", async () => {
    const h = setup();
    vi.mocked(h.deps.client.sendTx).mockRejectedValue(new Error("timeout"));
    expect(
      (await executeApprovedLighterFeeAuthorization(input, h.deps)).status,
    ).toBe("pending_verification");
    expect(
      (await executeApprovedLighterFeeAuthorization(input, h.deps)).status,
    ).toBe("pending_verification");
    h.confirm();
    expect((await reconcileLighterFeeAuthorization(input, h.deps)).status).toBe(
      "active",
    );
    expect(h.deps.sign).toHaveBeenCalledTimes(1);
    expect(h.deps.client.sendTx).toHaveBeenCalledTimes(1);
  });
  it("releases an expired unused nonce and requires a new approval", async () => {
    const h = setup({ state: "ambiguous", now: NOW + 300001 });
    expect((await reconcileLighterFeeAuthorization(input, h.deps)).status).toBe(
      "failed",
    );
    expect(h.deps.releaseNonce).toHaveBeenCalledOnce();
    expect(h.deps.sign).not.toHaveBeenCalled();
  });
  it("retires unconfirmed authorization after expiry when its nonce was consumed", async () => {
    const h = setup({ state: "submitted", now: NOW + 300001, consumed: true });
    expect((await reconcileLighterFeeAuthorization(input, h.deps)).status).toBe(
      "failed",
    );
    expect(h.deps.client.getTx).toHaveBeenCalledOnce();
    expect(h.deps.recordNonce).toHaveBeenCalledOnce();
    expect(h.deps.releaseNonce).not.toHaveBeenCalled();
    expect(h.deps.sign).not.toHaveBeenCalled();
  });
  it("retires a definitive tier rejection without signing", async () => {
    const h = setup({ tier: "standard" });
    vi.mocked(h.deps.client.changeAccountTier).mockResolvedValue({ code: 400 });
    expect(
      (await executeApprovedLighterFeeAuthorization(input, h.deps)).status,
    ).toBe("failed");
    expect(h.deps.sign).not.toHaveBeenCalled();
    expect(h.current().failureReason).toBe("tier_change_rejected");
  });
  it("stops before a tier upgrade when canceled", async () => {
    const h = setup({ tier: "standard" }),
      abort = new AbortController();
    abort.abort();
    await expect(
      executeApprovedLighterFeeAuthorization(
        { ...input, abortSignal: abort.signal },
        h.deps,
      ),
    ).rejects.toThrow("cancelled_before_reservation");
    expect(h.deps.client.changeAccountTier).not.toHaveBeenCalled();
    expect(h.deps.sign).not.toHaveBeenCalled();
  });
  it("retires and releases when cancellation arrives after signing", async () => {
    const h = setup(),
      abort = new AbortController(),
      original = h.deps.sign;
    vi.mocked(h.deps.sign).mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      abort.abort();
      return result;
    });
    // A RESOLVED signer call is exit evidence by construction, so nothing can
    // still be signing: the unsubmitted transaction is retired and its nonce
    // released rather than parked as ambiguous for a reconciler to unpick.
    expect(
      (
        await executeApprovedLighterFeeAuthorization(
          { ...input, abortSignal: abort.signal },
          h.deps,
        )
      ).status,
    ).toBe("failed");
    expect(h.current()).toMatchObject({ txHash: HASH, executionState: "expired_unsubmitted" });
    expect(h.deps.releaseUnsubmittedNonce).toHaveBeenCalledOnce();
    expect(h.deps.client.sendTx).not.toHaveBeenCalled();
  });
  it("checks both cap classes when verifying allowance", async () => {
    const h = setup({ state: "submitted", confirmed: true, consumed: true });
    vi.mocked(h.deps.readSetup).mockImplementation(async () => {
      const result = h.observed();
      return {
        ...result,
        account: {
          ...result.account,
          approved_integrators: requireValue(result.account.approved_integrators).map(
            (row) => ({ ...row, max_spot_taker_fee: 0 }),
          ),
        },
      };
    });
    expect((await reconcileLighterFeeAuthorization(input, h.deps)).status).toBe(
      "pending_verification",
    );
  });
  it("confirms an approved revocation without changing account tier", async () => {
    const h = setup({ revoke: true });
    expect(
      (await executeApprovedLighterFeeAuthorization(input, h.deps)).status,
    ).toBe("revoked");
    expect(h.deps.client.changeAccountTier).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.readSetup).mock.calls[0]?.[2]).toMatchObject({
      approvalId: "approval-1",
      terms: { revoke: true },
    });
  });
  it("only reuses a previously host-approved collector when collection is disabled", () => {
    const h = setup();
    expect(feePolicyForStoredIntent(h.current()).collectorAccountIndex).toBe(
      99,
    );
    expect(() =>
      feePolicyForStoredIntent({
        ...h.current(),
        approvalStatus: "approval_pending",
        approvalId: null,
      }),
    ).toThrow("host-approved");
    expect(() =>
      feePolicyForStoredIntent({
        ...h.current(),
        terms: { ...h.current().terms, maxSpotMakerFee: 9000 },
      }),
    ).toThrow("host-approved");
  });
  it("refuses reconciliation for a different selected wallet before provider reads", async () => {
    const h = setup({ state: "submitted" });
    vi.mocked(h.deps.selectedAddress).mockReturnValue(`0x${"9".repeat(40)}`);
    await expect(
      reconcileLighterFeeAuthorization(input, h.deps),
    ).rejects.toThrow("selected wallet");
    expect(h.deps.readSetup).not.toHaveBeenCalled();
  });
  it("retires a timed-out tier change after observing the unchanged tier past the card deadline", async () => {
    const h = setup({
      tier: "standard",
      state: "ambiguous",
      now: NOW + 900001,
    });
    h.setCurrent({ nonceValue: null, txHash: null, txExpiryMs: null });
    expect((await reconcileLighterFeeAuthorization(input, h.deps)).status).toBe(
      "failed",
    );
    expect(h.deps.client.changeAccountTier).not.toHaveBeenCalled();
    expect(h.deps.sign).not.toHaveBeenCalled();
  });
  it("does not treat omitted allowance evidence as an expired authorization failure", async () => {
    const h = setup({ state: "submitted", now: NOW + 300001, consumed: true });
    vi.mocked(h.deps.readSetup).mockImplementation(async () => ({
      ...h.observed(),
      account: { account_index: 42, l1_address: wallet.address },
    }));
    expect((await reconcileLighterFeeAuthorization(input, h.deps)).status).toBe(
      "pending_verification",
    );
  });
  it("uses the deployment's published tier fee ceilings", () => {
    const h = setup({ tier: "standard" }),
      core = buildLighterFeeAuthorizationTerms(h.observed(), false, NOW);
    expect(core).toMatchObject({
      targetTier: "plus",
      exchangeMakerFeeTick: 50,
      exchangeTakerFeeTick: 50,
      currentExchangeMakerFeeTick: 50,
      currentExchangeTakerFeeTick: 50,
    });
    const rhc = buildLighterFeeAuthorizationTerms(
      {
        ...h.observed(),
        policy: { ...h.observed().policy, environment: "rhc" },
      },
      false,
      NOW,
    );
    expect(rhc).toMatchObject({
      targetTier: "premium",
      exchangeMakerFeeTick: 120,
      exchangeTakerFeeTick: 350,
      currentExchangeMakerFeeTick: 50,
      currentExchangeTakerFeeTick: 50,
    });
  });
});

function controlledGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
describe("fee consent races", () => {
  for (const kind of ["expiry", "cancellation"] as const) {
    it.each(["reservation", "signing", "staging", "send-admission"] as const)(`${kind} at %s refuses a new fee submission`, async (phase) => {
      const h = setup(), entered = controlledGate(), finish = controlledGate(), controller = new AbortController();
      let nowMs = NOW;
      vi.mocked(h.deps.now).mockImplementation(() => nowMs);
      const pause = async () => { entered.release(); await finish.promise; };
      if (phase === "reservation") {
        const original = h.deps.reserveSigning;
        const implementation = requireValue(vi.mocked(original).getMockImplementation());
        vi.mocked(original).mockImplementation(async (...args) => { const row = await implementation(...args); await pause(); return row; });
      } else if (phase === "signing") {
        const implementation = requireValue(vi.mocked(h.deps.sign).getMockImplementation());
        vi.mocked(h.deps.sign).mockImplementation(async (...args) => { const signed = await implementation(...args); await pause(); return signed; });
      } else if (phase === "staging") {
        const implementation = requireValue(vi.mocked(h.deps.transition).getMockImplementation());
        vi.mocked(h.deps.transition).mockImplementation(async (...args) => { const row = await implementation(...args); if (args[1] === "submission_staged") await pause(); return row; });
      } else {
        vi.mocked(h.deps.admitSend).mockImplementation(async () => { await pause(); return true; });
      }
      const execution = executeApprovedLighterFeeAuthorization({ ...input, abortSignal: controller.signal }, h.deps);
      await entered.promise;
      if (kind === "expiry") nowMs = h.current().expiresAt.getTime(); else controller.abort("lock");
      expect(h.deps.releaseUnsubmittedNonce).not.toHaveBeenCalled();
      finish.release();
      await execution;
      expect(h.deps.client.sendTx).not.toHaveBeenCalled();
      expect(h.deps.sign).toHaveBeenCalledTimes(phase === "reservation" ? 0 : 1);
      if (phase === "signing") expect(h.current()).toMatchObject({ txHash: HASH, executionState: "expired_unsubmitted" });
      if (phase === "send-admission") expect(h.deps.releaseUnsubmittedNonce).not.toHaveBeenCalled();
    });
  }
  it("reports a successful tier change when consent expires before fee signing", async () => {
    const h = setup({ tier: "standard" });
    const original = requireValue(vi.mocked(h.deps.client.changeAccountTier).getMockImplementation());
    vi.mocked(h.deps.client.changeAccountTier).mockImplementation(async (...args) => {
      const response = await original(...args);
      vi.mocked(h.deps.now).mockReturnValue(h.current().expiresAt.getTime());
      return response;
    });
    const result = await executeApprovedLighterFeeAuthorization(input, h.deps);
    expect(result.message).toContain("Tier changed, fee authorization not submitted");
    expect(h.deps.sign).not.toHaveBeenCalled();
    expect(h.deps.client.sendTx).not.toHaveBeenCalled();
    expect(h.deps.client.changeAccountTier).toHaveBeenCalledOnce();
  });
});

it("reports known provider authorization ahead of an earlier partial-effect reason", async () => {
  const h = setup({ state: "submitted", confirmed: true, consumed: true });
  h.setCurrent({ failureReason: "tier_changed_fee_authorization_not_submitted" });
  const result = await reconcileLighterFeeAuthorization(input, h.deps);
  expect(result.status).toBe("active");
  expect(result.message).toContain("Lighter confirmed");
  expect(h.deps.client.sendTx).not.toHaveBeenCalled();
});


/**
 * THE SIGNER SETTLEMENT CONTRACT across the privileged fee wrapper (round-1 fix
 * F2).
 *
 * The wrapper deliberately replaces every signing failure with one sanitized
 * message, so nothing of the helper's stderr, the trading key or the wallet
 * signature can travel upstream. What it must NOT drop is the child's end
 * state: the executor releases the reserved nonce only on proven exit. These
 * tests drive the real wrapper over the real approve-integrator adapter over a
 * real `runLighterSignerBinary` run against a scripted child, so the evidence
 * the executor acts on is produced, not declared.
 */
describe("Lighter fee authorization signer settlement contract", () => {
  function composedSign(
    h: ReturnType<typeof setup>,
    signRunner: LighterSignerBinaryRunner,
  ): LighterFeeAuthorizationExecutionDeps["sign"] {
    return (args) => signApprovedLighterFeeAuthorization(args, {
      readVaultPrivateKey: () => `0x${"1".repeat(80)}`,
      readVaultRegistrationState: () => LIGHTER_TRADING_CREDENTIAL_ACTIVE_STATE,
      keyGenerator: createLighterApiKeyGeneratorBinary({
        binaryPath: "/tmp/vex-lighter-signer-test",
        runner: signerRunnerEmitting({ ok: true, publicKey: h.current().terms.publicKey }),
      }),
      signer: createLighterSignerBinaryApproveIntegratorAdapter({
        binaryPath: "/tmp/vex-lighter-signer-test",
        // Small enough that a child which never closes is killed inside the test.
        timeoutMs: 5,
        runner: signRunner,
      }),
      signWalletMessage: async () => `0x${"1".repeat(128)}1b`,
    });
  }

  it("releases the reserved nonce when the signer child provably exited", async () => {
    const h = setup();
    vi.mocked(h.deps.sign).mockImplementation(composedSign(h, signerRunnerExitingWithoutOutput()));

    const result = await executeApprovedLighterFeeAuthorization(input, h.deps);

    expect(result.status).toBe("failed");
    expect(h.current().executionState).toBe("failed");
    expect(h.deps.releaseUnsubmittedNonce).toHaveBeenCalledOnce();
    expect(h.deps.client.sendTx).not.toHaveBeenCalled();
  });

  it.each([
    ["a child that never closed", signerRunnerNeverClosing],
    ["a failure that never reached the child", signerRunnerRejectingWithoutEvidence],
  ])("keeps the nonce reserved after %s", async (_name, runner) => {
    const h = setup();
    vi.mocked(h.deps.sign).mockImplementation(composedSign(h, runner()));

    const result = await executeApprovedLighterFeeAuthorization(input, h.deps);

    expect(result.status).toBe("pending_verification");
    expect(h.current().executionState).toBe("ambiguous");
    expect(h.deps.releaseUnsubmittedNonce).not.toHaveBeenCalled();
    expect(h.deps.client.sendTx).not.toHaveBeenCalled();
  });
});
