/**
 * W0 target contract — implementation lands in W-SPINE.
 *
 * The Kyber-failure reveal-eligible set is COORDINATOR-FIXED (plan §11.2,
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
 * `tools/registry/uniswap-reveal-eligibility.ts` (see the import path below —
 * renamed from the illustrative `tools/protocols/uniswap/reveal-eligibility.ts`
 * to keep it out of W2b's owned `protocols/uniswap/**` tree), so this suite is
 * now ACTIVE (`describe.skip` removed).
 */
import { describe, it, expect } from "vitest";

describe("Kyber-failure reveal eligibility (target contract)", () => {
  it("local chain-not-Kyber-supported is eligible", async () => {
    const { isRevealEligibleKyberFailure } = await import(
      "../../../vex-agent/tools/registry/uniswap-reveal-eligibility.js"
    );
    expect(isRevealEligibleKyberFailure({ kind: "chain_unsupported" })).toBe(true);
  });

  it("codes 4008 and 4010 (route not found) are eligible", async () => {
    const { isRevealEligibleKyberFailure } = await import(
      "../../../vex-agent/tools/registry/uniswap-reveal-eligibility.js"
    );
    expect(isRevealEligibleKyberFailure({ kind: "kyber_code", code: 4008 })).toBe(true);
    expect(isRevealEligibleKyberFailure({ kind: "kyber_code", code: 4010 })).toBe(true);
  });

  it("code 4011 is eligible ONLY after token inputs passed address/native validation", async () => {
    const { isRevealEligibleKyberFailure } = await import(
      "../../../vex-agent/tools/registry/uniswap-reveal-eligibility.js"
    );
    expect(
      isRevealEligibleKyberFailure({ kind: "kyber_code", code: 4011, tokenInputsValidated: true }),
    ).toBe(true);
    expect(
      isRevealEligibleKyberFailure({ kind: "kyber_code", code: 4011, tokenInputsValidated: false }),
    ).toBe(false);
    expect(
      isRevealEligibleKyberFailure({ kind: "kyber_code", code: 4011 }),
    ).toBe(false); // omitted defaults to "not yet validated" — fail closed
  });

  it("4221 is NEVER eligible, even though it is numerically adjacent to the route-not-found family", async () => {
    const { isRevealEligibleKyberFailure } = await import(
      "../../../vex-agent/tools/registry/uniswap-reveal-eligibility.js"
    );
    expect(isRevealEligibleKyberFailure({ kind: "kyber_code", code: 4221 })).toBe(false);
  });

  it("4001, 4002, 4005, 4007, 4009 are NEVER eligible", async () => {
    const { isRevealEligibleKyberFailure } = await import(
      "../../../vex-agent/tools/registry/uniswap-reveal-eligibility.js"
    );
    for (const code of [4001, 4002, 4005, 4007, 4009]) {
      expect(isRevealEligibleKyberFailure({ kind: "kyber_code", code })).toBe(false);
    }
  });

  it("typed numeric comparison: a string '4008' does NOT satisfy the eligible branch", async () => {
    const { isRevealEligibleKyberFailure } = await import(
      "../../../vex-agent/tools/registry/uniswap-reveal-eligibility.js"
    );
    expect(
      isRevealEligibleKyberFailure({
        kind: "kyber_code",
        // @ts-expect-error — deliberately the wrong type for this guard test:
        // a numeric-looking string must not slip past a loose equality check.
        code: "4008",
      }),
    ).toBe(false);
  });

  it("an unrecognized numeric code is NOT eligible by default (closed set, not a deny-list)", async () => {
    const { isRevealEligibleKyberFailure } = await import(
      "../../../vex-agent/tools/registry/uniswap-reveal-eligibility.js"
    );
    expect(isRevealEligibleKyberFailure({ kind: "kyber_code", code: 9999 })).toBe(false);
  });
});
