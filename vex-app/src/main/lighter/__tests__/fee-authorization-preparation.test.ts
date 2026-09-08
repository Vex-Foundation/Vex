import { describe, expect, it } from "vitest";
import type { LighterAccountLimitsResponse } from "@tools/lighter/types.js";
import {
  buildLighterFeeAuthorizationTerms,
  type LighterFeeAuthorizationObserved,
} from "../fee-authorization-preparation.js";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const WALLET = `0x${"1".repeat(40)}`;

function observed(
  limits: Partial<LighterAccountLimitsResponse> & { user_tier: string },
  environment: "core" | "rhc" = "core",
): LighterFeeAuthorizationObserved {
  return {
    walletAddress: WALLET,
    accountIndex: 42,
    apiKeyIndex: 4,
    publicKey: "ab".repeat(40),
    account: { account_index: 42, l1_address: WALLET },
    limits: {
      code: 200,
      user_tier_name: limits.user_tier,
      current_maker_fee_tick: 0,
      current_taker_fee_tick: 0,
      ...limits,
    },
    auth: { token: "token", accountIndex: 42 },
    policy: {
      environment,
      collectorAccountIndex: environment === "core" ? 743799 : 22869,
      collectorL1Address: "0x10ce97cf3142be2a1a28ac83a55b21fdce493c03",
      perpsMakerFee: 1000,
      perpsTakerFee: 1000,
      spotMakerFee: 2500,
      spotTakerFee: 2500,
    },
  } satisfies LighterFeeAuthorizationObserved;
}

describe("buildLighterFeeAuthorizationTerms", () => {
  it("records the account's fees today next to the tier the change targets", () => {
    const terms = buildLighterFeeAuthorizationTerms(
      observed({ user_tier: "standard" }),
      false,
      NOW,
    );
    expect(terms.currentTier).toBe("standard");
    expect(terms.targetTier).toBe("plus");
    expect(terms.currentExchangeMakerFeeTick).toBe(0);
    expect(terms.currentExchangeTakerFeeTick).toBe(0);
    expect(terms.exchangeMakerFeeTick).toBe(50);
    expect(terms.exchangeTakerFeeTick).toBe(50);
  });

  it("records Robinhood Chain's Premium ceilings beside today's fees", () => {
    const terms = buildLighterFeeAuthorizationTerms(
      observed(
        {
          user_tier: "standard",
          current_maker_fee_tick: 10,
          current_taker_fee_tick: 20,
        },
        "rhc",
      ),
      false,
      NOW,
    );
    expect(terms.targetTier).toBe("premium");
    expect(terms.currentExchangeMakerFeeTick).toBe(10);
    expect(terms.currentExchangeTakerFeeTick).toBe(20);
    expect(terms.exchangeMakerFeeTick).toBe(120);
    expect(terms.exchangeTakerFeeTick).toBe(350);
  });

  it("keeps today's fees for an account that needs no tier change", () => {
    const terms = buildLighterFeeAuthorizationTerms(
      observed({
        user_tier: "plus",
        current_maker_fee_tick: 50,
        current_taker_fee_tick: 50,
      }),
      false,
      NOW,
    );
    expect(terms.targetTier).toBeNull();
    expect(terms.currentExchangeMakerFeeTick).toBe(50);
    expect(terms.exchangeMakerFeeTick).toBe(50);
  });

  it("reports a fee Lighter did not send as unreported, never as zero", () => {
    const terms = buildLighterFeeAuthorizationTerms(
      observed({
        user_tier: "standard",
        // The provider omitted the tick. `observed` takes a Partial of the
        // response, so an explicit `undefined` is the typed way to say the key
        // arrived without a value; the spread below then carries it through.
        current_maker_fee_tick: undefined,
        current_taker_fee_tick: -1,
      }),
      false,
      NOW,
    );
    expect(terms.currentExchangeMakerFeeTick).toBeNull();
    expect(terms.currentExchangeTakerFeeTick).toBeNull();
  });

  it("zeroes every cap and the expiry on revoke while still reporting today's fees", () => {
    const terms = buildLighterFeeAuthorizationTerms(
      observed({
        user_tier: "plus",
        current_maker_fee_tick: 50,
        current_taker_fee_tick: 50,
      }),
      true,
      NOW,
    );
    expect(terms.revoke).toBe(true);
    expect(terms.targetTier).toBeNull();
    expect(terms.authorizationExpiryMs).toBe(0);
    expect(terms.maxPerpsMakerFee).toBe(0);
    expect(terms.maxSpotTakerFee).toBe(0);
    expect(terms.currentExchangeMakerFeeTick).toBe(50);
  });
});
