import { requireValue } from "../helpers/require-value.js";
import type { LighterClient } from "@tools/lighter/client.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as policyModule from "@tools/lighter/fee-policy.js";
import { getLighterIntegratorFees, resolveLighterFeePolicy } from "@tools/lighter/fee-policy.js";
import { estimateLighterOrderFee, lighterOrderFeeCriticalArgs, readLighterOrderFeeTerms } from "@tools/lighter/order-fee-terms.js";
import { resolveLighterOrderFees, revalidateLighterOrderFees } from "@vex-agent/tools/protocols/lighter/order-fees.js";
import { configureLighterReadOnlyAccountAuthResolver } from "@vex-agent/tools/protocols/lighter/read-account-auth.js";
import { lighterTradeFeeEvidence } from "@vex-agent/tools/protocols/lighter/order-evidence.js";
import { ErrorCodes, VexError } from "../../errors.js";
import type { LighterAccount, LighterAccountLimitsResponse, LighterSystemConfigResponse, LighterTrade } from "@tools/lighter/types.js";

const WALLET = `0x${"1".repeat(40)}`;
const policy = requireValue(resolveLighterFeePolicy("core", { enabled: true, accountIndex: 99, l1Address: WALLET }));
const fees = getLighterIntegratorFees(policy, "perp");
const NOW = 1_900_000_000_000;
const trader: LighterAccount = { index: 42, status: 1, approved_integrators: [{
  account_index: 99, name: "VEX", max_perps_maker_fee: 1000, max_perps_taker_fee: 1000,
  max_spot_maker_fee: 2500, max_spot_taker_fee: 2500, approval_expiry: NOW + 60_000,
}] };
const collector: LighterAccount = { index: 99, status: 1, l1_address: WALLET };
const limits: LighterAccountLimitsResponse = { code: 200, user_tier: "plus", user_tier_name: "Plus", current_maker_fee_tick: 50, current_taker_fee_tick: 50 };

function client(account = trader) {
  return {
    getAccount: vi.fn<LighterClient["getAccount"]>(async (_environment, params) => ({ code: 200, total: 1, accounts: [params.value === 99 ? collector : account] })),
    getSystemConfig: vi.fn(async () => ({ code: 200, max_integrator_perps_maker_fee: 1000, max_integrator_perps_taker_fee: 1000, max_integrator_spot_maker_fee: 10_000, max_integrator_spot_taker_fee: 10_000 } as LighterSystemConfigResponse)),
    getAccountLimits: vi.fn(async () => limits),
  };
}
const scope = { environment: "core" as const, accountIndex: 42, market: { market_type: "perp" as const }, reduceOnly: false, side: "buy" as const, nowMs: NOW };

afterEach(() => { vi.restoreAllMocks(); configureLighterReadOnlyAccountAuthResolver(null); });

describe("native Lighter order fees", () => {
  it("does no fee provider or auth work while collection is disabled", async () => {
    vi.spyOn(policyModule, "getLighterFeePolicy").mockReturnValue(null);
    const provider = client();
    expect(await resolveLighterOrderFees({ ...scope, client: provider })).toBeNull();
    expect(provider.getAccount).not.toHaveBeenCalled();
    expect(provider.getAccountLimits).not.toHaveBeenCalled();
  });

  it("derives the trusted fee only after fresh collector, caps, tier and consent checks", async () => {
    vi.spyOn(policyModule, "getLighterFeePolicy").mockReturnValue(policy);
    configureLighterReadOnlyAccountAuthResolver(async () => ({ accountIndex: 42, token: "test-read-auth" }));
    const provider = client();
    expect(await resolveLighterOrderFees({ ...scope, client: provider })).toEqual(fees);
    expect(provider.getAccount).toHaveBeenCalledWith("core", { by: "index", value: 99 }, { fresh: true });
    expect(provider.getAccount).toHaveBeenCalledWith("core", { by: "index", value: 42 }, { fresh: true });
    expect(await resolveLighterOrderFees({ ...scope, client: provider, market: { market_type: "spot" } })).toEqual({ ...fees, integratorMakerFee: 2500, integratorTakerFee: 2500 });
  });

  it("reuses only an explicitly fresh preview account and still checks collector, caps and limits", async () => {
    vi.spyOn(policyModule, "getLighterFeePolicy").mockReturnValue(policy);
    configureLighterReadOnlyAccountAuthResolver(async () => ({ accountIndex: 42, token: "test-read-auth" }));
    const provider = client();
    const freshAccount = { code: 200, total: 1, accounts: [trader] };
    expect(await resolveLighterOrderFees({ ...scope, client: provider, freshAccount })).toEqual(fees);
    expect(provider.getAccount).toHaveBeenCalledTimes(1);
    expect(provider.getAccount).toHaveBeenCalledWith("core", { by: "index", value: 99 }, { fresh: true });
    expect(provider.getSystemConfig).toHaveBeenCalledTimes(1);
    expect(provider.getAccountLimits).toHaveBeenCalledTimes(1);
  });

  it("revalidation refetches the trading account even if a preview response is supplied", async () => {
    vi.spyOn(policyModule, "getLighterFeePolicy").mockReturnValue(policy);
    configureLighterReadOnlyAccountAuthResolver(async () => ({ accountIndex: 42, token: "test-read-auth" }));
    const provider = client({ ...trader, approved_integrators: [] });
    await expect(revalidateLighterOrderFees({
      ...scope, client: provider, freshAccount: { code: 200, total: 1, accounts: [trader] }, integratorFees: fees,
    })).rejects.toThrow("fee setup is required");
    expect(provider.getAccount).toHaveBeenCalledWith("core", { by: "index", value: 42 }, { fresh: true });
  });

  it.each([
    { ...trader, approved_integrators: [] },
    { ...trader, approved_integrators: [...requireValue(trader.approved_integrators), ...requireValue(trader.approved_integrators)] },
    { ...trader, approved_integrators: requireValue(trader.approved_integrators).map((row) => ({ ...row, approval_expiry: NOW })) },
    { ...trader, approved_integrators: requireValue(trader.approved_integrators).map((row) => ({ ...row, max_spot_taker_fee: 2499 })) },
  ])("refuses new risk without the exact active allowance", async (account) => {
    vi.spyOn(policyModule, "getLighterFeePolicy").mockReturnValue(policy);
    configureLighterReadOnlyAccountAuthResolver(async () => ({ accountIndex: 42, token: "test-read-auth" }));
    await expect(resolveLighterOrderFees({ ...scope, client: client(account) })).rejects.toThrow("fee setup is required");
  });

  it("refuses unsuccessful account evidence even when its fields resemble an allowance", async () => {
    vi.spyOn(policyModule, "getLighterFeePolicy").mockReturnValue(policy);
    configureLighterReadOnlyAccountAuthResolver(async () => ({ accountIndex: 42, token: "test-read-auth" }));
    const provider = client();
    provider.getAccount.mockImplementation(async (_environment, params) => ({
      code: 400, total: 1, accounts: [params.value === 99 ? collector : trader],
    }));
    await expect(resolveLighterOrderFees({ ...scope, client: provider })).rejects.toThrow("could not be verified");
  });

  it("passes an unreachable Lighter through instead of calling it missing fee setup", async () => {
    // 2026-09-24, Wi-Fi off: an approved order read "Lighter fee setup is required
    // before this trade. fetch failed", and the hint would have sent the agent to a
    // fee approval the account already had.
    vi.spyOn(policyModule, "getLighterFeePolicy").mockReturnValue(policy);
    configureLighterReadOnlyAccountAuthResolver(async () => ({ accountIndex: 42, token: "test-read-auth" }));
    const provider = client();
    const offline = new VexError(ErrorCodes.LIGHTER_API_ERROR, "fetch failed", "Check network connectivity");
    provider.getSystemConfig.mockRejectedValue(offline);

    const failure = await resolveLighterOrderFees({ ...scope, client: provider }).then(() => null, (error: unknown) => error);

    expect(failure).toBe(offline);
  });

  it("permits freshly disclosed no-fee exits but never drops an already approved fee", async () => {
    vi.spyOn(policyModule, "getLighterFeePolicy").mockReturnValue(policy);
    const provider = client({ ...trader, approved_integrators: [] });
    const exit = { ...scope, client: provider, reduceOnly: true, side: "sell" as const };
    expect(await resolveLighterOrderFees(exit)).toBeNull();
    await expect(revalidateLighterOrderFees({ ...exit, integratorFees: fees })).rejects.toThrow("changed after this preview");
  });

  it("invalidates a fee-bearing approval when collection is disabled", async () => {
    vi.spyOn(policyModule, "getLighterFeePolicy").mockReturnValue(null);
    await expect(revalidateLighterOrderFees({ ...scope, client: client(), integratorFees: fees })).rejects.toThrow("changed after this preview");
  });

  it("strictly decodes durable fee terms and computes exact decimal estimates", () => {
    expect(readLighterOrderFeeTerms(fees)).toEqual(fees);
    expect(() => readLighterOrderFeeTerms({ ...fees, collectorOverride: 1 })).toThrow();
    expect(() => readLighterOrderFeeTerms({ ...fees, integratorMakerFee: "1000" })).toThrow();
    expect(lighterOrderFeeCriticalArgs(fees).vexFeeSummary).toContain("0.1% maker / 0.1% taker");
    expect(estimateLighterOrderFee("1000000000", 6, 1000)).toBe("1");
    expect(estimateLighterOrderFee("1", 18, 2500)).toBe("0.0000000000000000000025");
  });

  it("reports spot partial-fill fees in the received asset without claiming collector settlement", () => {
    const spotFees = getLighterIntegratorFees(policy, "spot");
    const trade = { size: "0.4", price: "2000", is_maker_ask: true, integrator_taker_fee: 2500, integrator_taker_fee_collector_index: 99, taker_fee: 50 } as LighterTrade;
    const evidence = lighterTradeFeeEvidence(trade, { accountIndex: 42, marketIndex: 2048, side: "buy", integratorFees: spotFees });
    expect(evidence).toMatchObject({ liquidityRole: "taker", exchangeFeeTicks: 50, vexFee: { collectorAccountIndex: 99, attributionMatchesApproved: true, amountBeforeProviderRounding: "0.001", amountUnit: "received_base_asset", collectorCreditVerified: false } });
    expect(lighterTradeFeeEvidence({ ...trade, integrator_taker_fee_collector_index: 98 }, { accountIndex: 42, marketIndex: 2048, side: "buy", integratorFees: spotFees })).toMatchObject({ vexFee: { attributionMatchesApproved: false } });
  });
});
