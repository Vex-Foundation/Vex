import { afterEach, describe, expect, it, vi } from "vitest";
import { LighterClient } from "@tools/lighter/client.js";
import { assertLighterFeeAllowance, assertLighterFeePolicyLive, getLighterFeePolicy, getLighterIntegratorFees, resolveLighterFeePolicy } from "@tools/lighter/fee-policy.js";
import { buildLighterApproveIntegratorSignatureBody, buildLighterApproveIntegratorSigningInput, signLighterApproveIntegratorWithAdapter } from "@tools/lighter/signer-integrator.js";
import { createLighterSignerBinaryApproveIntegratorAdapter } from "@tools/lighter/signer-binary-adapter.js";
import { materialFromSecret } from "@tools/lighter/trading-secret.js";
import { validateLighterAccount, validateLighterAccountLimits, validateLighterSystemConfig } from "@tools/lighter/validation.js";

const wallet = "0x1111111111111111111111111111111111111111";
const policy = resolveLighterFeePolicy("core", { enabled: true, accountIndex: 123, l1Address: wallet })!;
const limits = { code: 200, user_tier: "plus", user_tier_name: "Plus", current_maker_fee_tick: 50, current_taker_fee_tick: 50 };
const allowance = { account_index: 123, name: "VEX", max_perps_maker_fee: 1000, max_perps_taker_fee: 1000,
  max_spot_maker_fee: 2500, max_spot_taker_fee: 2500, approval_expiry: 1_900_000_000_000 };
const terms = { environment: "core" as const, accountIndex: 42, apiKeyIndex: 7, nonce: "9", expiredAt: "1893456000000",
  integratorAccountIndex: 123, maxPerpsMakerFee: 1000, maxPerpsTakerFee: 1000, maxSpotMakerFee: 2500, maxSpotTakerFee: 2500, approvalExpiry: 2_000_000_000_000 };

function signingInput() {
  return buildLighterApproveIntegratorSigningInput({ ...terms, expectedL1Address: wallet,
    l1Signature: `0x${"11".repeat(64)}1b`, secret: materialFromSecret(`0x${"1".repeat(80)}`) });
}

function helperOutput(overrides: Record<string, unknown> = {}) {
  const input = signingInput();
  return { ok: true, txType: 45, txHash: "ab".repeat(40), messageToSign: input.messageToSign,
    txInfo: JSON.stringify({ AccountIndex: 42, ApiKeyIndex: 7, IntegratorAccountIndex: 123, MaxPerpsMakerFee: 1000, MaxPerpsTakerFee: 1000,
      MaxSpotMakerFee: 2500, MaxSpotTakerFee: 2500, ApprovalExpiry: terms.approvalExpiry, ExpiredAt: Number(terms.expiredAt), Nonce: 9,
      L1Sig: input.l1Signature, L2TxAttributes: null, Sig: Buffer.alloc(80, 1).toString("base64"), ...overrides }) };
}

afterEach(() => vi.unstubAllGlobals());

describe("native Lighter fees", () => {
  it("stays disabled without reviewed collectors and rejects malformed enabled configuration", () => {
    expect(getLighterFeePolicy("core")).toBeNull();
    expect(getLighterFeePolicy("rhc")).toBeNull();
    expect(() => resolveLighterFeePolicy("core", { enabled: true, accountIndex: null, l1Address: null })).toThrow(/configured/);
    expect(getLighterIntegratorFees(policy, "perp")).toEqual({ integratorAccountIndex: 123, integratorMakerFee: 1000, integratorTakerFee: 1000 });
    expect(getLighterIntegratorFees(policy, "spot").integratorMakerFee).toBe(2500);
  });

  it("requires collector ownership and current caps", () => {
    const systemConfig = validateLighterSystemConfig({ code: 200, liquidity_pool_index: 1, staking_pool_index: 1, funding_fee_rebate_account_index: 1,
      market_maker_incentive_account_index: 1, liquidity_pool_cooldown_period: 0, staking_pool_lockup_period: 0,
      max_integrator_perps_maker_fee: 1000, max_integrator_perps_taker_fee: 1000, max_integrator_spot_maker_fee: 10000, max_integrator_spot_taker_fee: 10000 });
    const collectorAccount = { index: 123, l1_address: wallet };
    expect(() => assertLighterFeePolicyLive(policy, { systemConfig, collectorAccount })).not.toThrow();
    expect(() => assertLighterFeePolicyLive(policy, { systemConfig, collectorAccount: { ...collectorAccount, index: 124 } })).toThrow(/collector/);
    expect(() => assertLighterFeePolicyLive(policy, { systemConfig: { ...systemConfig, max_integrator_spot_maker_fee: 2000 }, collectorAccount })).toThrow(/limit/);
  });

  it("requires current allowance for both markets and rejects expiry, revocation and Standard", () => {
    const account = validateLighterAccount({ code: 200, accounts: [{ index: 42, approved_integrators: [allowance] }] }).accounts[0]!;
    const accountLimits = validateLighterAccountLimits(limits);
    expect(validateLighterAccount({ code: 200, accounts: [{ index: 42 }] }).accounts[0]!.approved_integrators).toBeUndefined();
    expect(() => assertLighterFeeAllowance(policy, { account, accountLimits, nowMs: 1_800_000_000_000 })).not.toThrow();
    expect(() => assertLighterFeeAllowance(policy, { account, accountLimits, nowMs: allowance.approval_expiry })).toThrow(/Approve/);
    expect(() => assertLighterFeeAllowance(policy, { account: { ...account, approved_integrators: [] }, accountLimits })).toThrow(/Approve/);
    expect(() => assertLighterFeeAllowance(policy, { account, accountLimits: { ...accountLimits, user_tier: "standard" } })).toThrow(/Plus or Premium/);
    expect(() => assertLighterFeeAllowance(policy, { account: { ...account, approved_integrators: [{ ...allowance, max_spot_taker_fee: 2499 }] }, accountLimits, nowMs: 1 })).toThrow(/Approve/);
  });

  it("binds wallet message to the collector, both fee limits, expiry and deployment", () => {
    const body = buildLighterApproveIntegratorSignatureBody(terms);
    expect(body).toContain("integrator account index: 0x000000000000007b");
    expect(body).toContain("max spot taker fee: 0x00000000000009c4");
    expect(body).toContain("chainId: 0x0000000000000130");
    expect(buildLighterApproveIntegratorSignatureBody({ ...terms, environment: "rhc" })).not.toBe(body);
    expect(() => buildLighterApproveIntegratorSignatureBody({ ...terms, approvalExpiry: 0 })).toThrow(/caps/);
  });

  it("checks exact signed Tx45 terms and keeps signatures out of serialized results", async () => {
    const input = signingInput();
    const adapter = createLighterSignerBinaryApproveIntegratorAdapter({ runner: async (request) => {
      expect(request.payload.operation).toBe("signApproveIntegrator");
      return helperOutput();
    } });
    const result = await signLighterApproveIntegratorWithAdapter(input, adapter);
    expect(result.txType).toBe(45);
    expect(result.txInfo).toContain("IntegratorAccountIndex");
    expect(JSON.stringify(result)).not.toContain(input.l1Signature);
    expect(JSON.stringify(input)).not.toContain(input.l1Signature);
    for (const overrides of [{ IntegratorAccountIndex: 124 }, { MaxSpotTakerFee: 2501 }, { ApprovalExpiry: terms.approvalExpiry + 1 }, { Nonce: 10 }, { L2TxAttributes: {} }]) {
      const forged = createLighterSignerBinaryApproveIntegratorAdapter({ runner: async () => helperOutput(overrides) });
      await expect(signLighterApproveIntegratorWithAdapter(input, forged)).rejects.toThrow(/differs/);
    }
  });

  it("allows a locally approved L2-only revocation", () => {
    const input = buildLighterApproveIntegratorSigningInput({ ...terms, maxPerpsMakerFee: 0, maxPerpsTakerFee: 0,
      maxSpotMakerFee: 0, maxSpotTakerFee: 0, approvalExpiry: 0, l1Signature: "", expectedL1Address: wallet, secret: signingInput().secret });
    expect(input.l1Signature).toBe("");
  });

  it("keeps account limit reads fresh and sends tier authorization only in headers", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(limits), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new LighterClient();
    const auth = { accountIndex: 42, token: "private-test-auth" };
    await client.getAccountLimits("core", { accountIndex: 42 }, auth);
    await client.getAccountLimits("core", { accountIndex: 42 }, auth);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 200 }), { status: 200 }));
    await client.changeAccountTier("rhc", { accountIndex: 42, newTier: "premium" }, auth);
    const [url, options] = fetchMock.mock.calls[2]!;
    expect(url).toBe("https://api.rh.lighter.xyz/api/v1/changeAccountTier");
    expect(options.headers.Authorization).toBe(auth.token);
    expect(options.body.toString()).toBe("account_index=42&new_tier=premium");
    expect(String(url)).not.toContain(auth.token);
    await expect(client.changeAccountTier("core", { accountIndex: 43, newTier: "plus" }, auth)).rejects.toThrow(/match/);
  });
});
