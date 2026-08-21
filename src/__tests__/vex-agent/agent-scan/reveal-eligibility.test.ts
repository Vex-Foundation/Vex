/**
 * W0 target contract — implementation lands in W-SPINE.
 *
 * The Kyber-failure fallback-eligible set is COORDINATOR-FIXED (plan §11.2,
 * Blocker B — builders have no discretion to widen or narrow it):
 *
 *   ELIGIBLE:     local chain-not-Kyber-supported (registry gate, pre-call);
 *                 Kyber code 4008; Kyber code 4010; Kyber code 4011 — but
 *                 ONLY when the token inputs already passed address/native
 *                 validation + on-chain metadata resolution (4011 fired for a
 *                 genuinely well-formed, unknown-to-Kyber token — not for a
 *                 malformed address that never got that far).
 *   NEVER:        4221 (config anomaly, not route-not-found — explicitly
 *                 excluded even though it is numerically adjacent to the
 *                 route-not-found family); 4001, 4002, 4005, 4007, 4009
 *                 (malformed params / fee-exceeds-amount / amount-too-large —
 *                 none of these mean "route not found").
 *
 * `mapAggregatorError` (src/tools/kyberswap/aggregator/errors.ts) already
 * maps these HTTP-response codes to VexError codes
 * (KYBER_ROUTE_NOT_FOUND for 4008/4010, KYBER_TOKEN_NOT_FOUND for 4011,
 * KYBER_WETH_NOT_CONFIGURED for 4221, KYBER_MALFORMED_PARAMS for 4001/4002,
 * KYBER_FEE_EXCEEDS_AMOUNT for 4005/4007, KYBER_AMOUNT_TOO_LARGE for 4009) —
 * that mapping is unchanged by this plan. The reveal-eligibility classifier
 * is a NEW, narrower filter on top of it, so this suite drives the
 * classifier directly with the raw numeric codes rather than re-deriving the
 * VexError mapping (already pinned in
 * `src/__tests__/kyberswap/kyberswap-aggregator-errors.test.ts`).
 *
 * The "typed numeric comparison" requirement means the classifier must
 * compare the CODE TYPE, not just its printed value — a string "4008" must
 * NOT satisfy the same branch as the number 4008 (guards against a JSON
 * response field arriving as a numeric-looking string and silently widening
 * eligibility via loose ("==") comparison or string-includes checks).
 *
 * Module path is illustrative — see the disclaimer in
 * agent-activity-cas.test.ts. W-SPINE has landed
 * `tools/registry/venue-fallback-eligibility.ts` (see the import path below —
 * renamed from the illustrative `tools/protocols/uniswap/reveal-eligibility.ts`
 * to keep it out of W2b's owned `protocols/uniswap/**` tree), so this suite is
 * now ACTIVE (`describe.skip` removed).
 */
import { describe, it, expect } from "vitest";
import type { KyberVenueUnavailableReason } from "../../../vex-agent/tools/registry/venue-fallback-eligibility.js";

describe("Kyber-failure reveal eligibility (target contract)", () => {
  it("local chain-not-Kyber-supported is eligible", async () => {
    const { isVenueFallbackWorthwhile } = await import(
      "../../../vex-agent/tools/registry/venue-fallback-eligibility.js"
    );
    expect(isVenueFallbackWorthwhile({ kind: "chain_unsupported" })).toBe(true);
  });

  it("codes 4008 and 4010 (route not found) are eligible", async () => {
    const { isVenueFallbackWorthwhile } = await import(
      "../../../vex-agent/tools/registry/venue-fallback-eligibility.js"
    );
    expect(isVenueFallbackWorthwhile({ kind: "kyber_code", code: 4008 })).toBe(true);
    expect(isVenueFallbackWorthwhile({ kind: "kyber_code", code: 4010 })).toBe(true);
  });

  it("code 4011 is eligible ONLY after token inputs passed address/native validation", async () => {
    const { isVenueFallbackWorthwhile } = await import(
      "../../../vex-agent/tools/registry/venue-fallback-eligibility.js"
    );
    expect(
      isVenueFallbackWorthwhile({ kind: "kyber_code", code: 4011, tokenInputsValidated: true }),
    ).toBe(true);
    expect(
      isVenueFallbackWorthwhile({ kind: "kyber_code", code: 4011, tokenInputsValidated: false }),
    ).toBe(false);
    expect(
      isVenueFallbackWorthwhile({ kind: "kyber_code", code: 4011 }),
    ).toBe(false); // omitted defaults to "not yet validated" — fail closed
  });

  // Live 2026-08-10: a user in Vietnam was answered HTTP 403 by KyberSwap's
  // edge and the fallback stayed locked. The venue failed to serve us at all
  // rather than refusing this trade, so no fresh quote and no corrected
  // amount can clear it - a second venue is the only remedy Vex has.
  describe("a venue-availability failure unlocks the fallback venue", () => {
    it("every closed availability reason is eligible", async () => {
      const { isVenueFallbackWorthwhile } = await import(
        "../../../vex-agent/tools/registry/venue-fallback-eligibility.js"
      );
      for (const reason of ["edge_refused", "endpoint_missing", "rate_limited", "server_error", "timeout", "unreachable"] as const) {
        expect(isVenueFallbackWorthwhile({ kind: "venue_unavailable", reason })).toBe(true);
      }
    });

    it("an off-union reason is NOT eligible (closed set, not a deny-list)", async () => {
      const { isVenueFallbackWorthwhile } = await import(
        "../../../vex-agent/tools/registry/venue-fallback-eligibility.js"
      );
      // The single cast simulates a reason arriving through an untyped
      // boundary, which is the only way an off-union value can reach here.
      const offUnionReason = "probably_fine" as KyberVenueUnavailableReason;
      expect(isVenueFallbackWorthwhile({ kind: "venue_unavailable", reason: offUnionReason })).toBe(false);
    });
  });

  it("a MINED on-chain revert of the swap leg is eligible", async () => {
    const { isVenueFallbackWorthwhile } = await import(
      "../../../vex-agent/tools/registry/venue-fallback-eligibility.js"
    );
    expect(isVenueFallbackWorthwhile({ kind: "swap_mined_revert" })).toBe(true);
  });

  it("4221 is NEVER eligible, even though it is numerically adjacent to the route-not-found family", async () => {
    const { isVenueFallbackWorthwhile } = await import(
      "../../../vex-agent/tools/registry/venue-fallback-eligibility.js"
    );
    expect(isVenueFallbackWorthwhile({ kind: "kyber_code", code: 4221 })).toBe(false);
  });

  it("4001, 4002, 4005, 4007, 4009 are NEVER eligible", async () => {
    const { isVenueFallbackWorthwhile } = await import(
      "../../../vex-agent/tools/registry/venue-fallback-eligibility.js"
    );
    for (const code of [4001, 4002, 4005, 4007, 4009]) {
      expect(isVenueFallbackWorthwhile({ kind: "kyber_code", code })).toBe(false);
    }
  });

  it("typed numeric comparison: a string '4008' does NOT satisfy the eligible branch", async () => {
    const { isVenueFallbackWorthwhile } = await import(
      "../../../vex-agent/tools/registry/venue-fallback-eligibility.js"
    );
    expect(
      isVenueFallbackWorthwhile({
        kind: "kyber_code",
        // @ts-expect-error — deliberately the wrong type for this guard test:
        // a numeric-looking string must not slip past a loose equality check.
        code: "4008",
      }),
    ).toBe(false);
  });

  it("an unrecognized numeric code is NOT eligible by default (closed set, not a deny-list)", async () => {
    const { isVenueFallbackWorthwhile } = await import(
      "../../../vex-agent/tools/registry/venue-fallback-eligibility.js"
    );
    expect(isVenueFallbackWorthwhile({ kind: "kyber_code", code: 9999 })).toBe(false);
  });

  // Added 2026-07-25. A live 4663 swap was refused by the pre-sign calldata
  // guard with no venue to fall back to: the refusal is filed
  // `route_not_found`, but it never reached the classifier at all, so the one
  // venue that could serve the trade stayed locked.
  describe("a pre-sign build refusal unlocks the fallback venue", () => {
    it("`unsafe_build` is eligible", async () => {
      const { isVenueFallbackWorthwhile } = await import(
        "../../../vex-agent/tools/registry/venue-fallback-eligibility.js"
      );
      expect(isVenueFallbackWorthwhile({ kind: "unsafe_build" })).toBe(true);
    });

    it("KYBER_UNSAFE_BUILD, thrown locally with no provider code, derives the eligible signal", async () => {
      const { deriveKyberFallbackSignal } = await import(
        "../../../vex-agent/tools/protocols/kyberswap/failure-mapping.js"
      );
      const { VexError, ErrorCodes } = await import("../../../errors.js");
      // Exactly how the handler builds it: no `externalName`, so the numeric
      // Kyber-code path cannot see it.
      const err = new VexError(
        ErrorCodes.KYBER_UNSAFE_BUILD,
        "Refused before signing: it sends 1 to 0xdead, which the quoted route never names.",
        "Nothing was signed. Re-quote; do not retry this build.",
      );
      expect(err.externalName).toBeUndefined();
      expect(deriveKyberFallbackSignal(err, true)).toEqual({ kind: "unsafe_build" });
    });

    it("still files as route_not_found — the reveal changes the venue, not the activity code", async () => {
      const { mapKyberFailureToActivityCode } = await import(
        "../../../vex-agent/tools/protocols/kyberswap/failure-mapping.js"
      );
      const { VexError, ErrorCodes } = await import("../../../errors.js");
      expect(
        mapKyberFailureToActivityCode(new VexError(ErrorCodes.KYBER_UNSAFE_BUILD, "x")),
      ).toBe("route_not_found");
    });

    // A price-floor breach is a PRICE condition a genuinely fresh quote can
    // clear, so it keeps its own "get a fresh quote" remedy rather than
    // unlocking a second venue.
    it("KYBER_PRICE_FLOOR_VIOLATED does NOT unlock the fallback", async () => {
      const { deriveKyberFallbackSignal } = await import(
        "../../../vex-agent/tools/protocols/kyberswap/failure-mapping.js"
      );
      const { VexError, ErrorCodes } = await import("../../../errors.js");
      expect(
        deriveKyberFallbackSignal(new VexError(ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED, "x"), true),
      ).toBeNull();
    });
  });

  // Added 2026-07-30. Live session on Robinhood Chain (4663): the swap leg's
  // PRE-SIGN gas estimate reverted twice with `"Call failed"`, nothing was
  // broadcast, and the fallback venue stayed locked — while the very same
  // calldata reverting AFTER it was mined (gas burned, strictly WEAKER
  // evidence of nothing having been spent) would have unlocked it.
  describe("a pre-sign gas-estimate revert of the swap leg unlocks the fallback venue", () => {
    it("`pre_sign_revert` is eligible for the codes a fresh quote cannot clear", async () => {
      const { isVenueFallbackWorthwhile } = await import(
        "../../../vex-agent/tools/registry/venue-fallback-eligibility.js"
      );
      for (const failureCode of ["simulation_reverted", "route_not_found", "insufficient_liquidity"] as const) {
        expect(isVenueFallbackWorthwhile({ kind: "pre_sign_revert", failureCode })).toBe(true);
      }
    });

    it("a PRICE / WALLET / STALENESS condition a fresh quote can clear is NOT eligible", async () => {
      const { isVenueFallbackWorthwhile } = await import(
        "../../../vex-agent/tools/registry/venue-fallback-eligibility.js"
      );
      for (const failureCode of ["slippage", "allowance_or_balance", "deadline_expired"] as const) {
        expect(isVenueFallbackWorthwhile({ kind: "pre_sign_revert", failureCode })).toBe(false);
      }
    });

    it("an unlisted failure code is NOT eligible by default (closed set, not a deny-list)", async () => {
      const { isVenueFallbackWorthwhile } = await import(
        "../../../vex-agent/tools/registry/venue-fallback-eligibility.js"
      );
      expect(isVenueFallbackWorthwhile({ kind: "pre_sign_revert", failureCode: "broadcast_error" })).toBe(false);
      expect(isVenueFallbackWorthwhile({ kind: "pre_sign_revert", failureCode: "chain_unsupported" })).toBe(false);
    });

    it("the signal is constructed ONLY for the swap leg with nothing broadcast", async () => {
      const { deriveKyberPreSignRevertFallbackSignal } = await import(
        "../../../vex-agent/tools/protocols/kyberswap/failure-mapping.js"
      );
      expect(
        deriveKyberPreSignRevertFallbackSignal({
          eventRole: "swap", legBroadcastAttempted: false, failureCode: "simulation_reverted",
        }),
      ).toEqual({ kind: "pre_sign_revert", failureCode: "simulation_reverted" });

      // An approve leg being refused is an ERC-20 allowance condition, not
      // venue evidence — the same R1 rule the mined-revert path already obeys.
      for (const eventRole of ["allowance", "allowance_reset"] as const) {
        expect(
          deriveKyberPreSignRevertFallbackSignal({
            eventRole, legBroadcastAttempted: false, failureCode: "simulation_reverted",
          }),
        ).toBeNull();
      }

      // Bytes already went to the wire: this is no longer a pre-sign refusal.
      expect(
        deriveKyberPreSignRevertFallbackSignal({
          eventRole: "swap", legBroadcastAttempted: true, failureCode: "simulation_reverted",
        }),
      ).toBeNull();
    });
  });
});
