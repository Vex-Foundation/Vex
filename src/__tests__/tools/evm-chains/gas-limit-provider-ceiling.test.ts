/**
 * The Vex-owned CEILING on a provider-quoted EVM gas limit
 * (`gasLimitForProviderHintedCall`).
 *
 * WHY THIS SUITE EXISTS. The 2026-07-24 fix taught the signer that "a
 * provider's number is a hint, never a floor" — a lowball can never lower what
 * we sign. Fixing that direction opened the inverse hole: `max(providerGas,
 * ownEstimate x 2)` had no upper bound at all, so a compromised or buggy
 * provider could raise Vex's signed gas exposure without limit. Khalani is the
 * only caller of the provider-hinted variant, so this blocked every funded
 * Khalani bridge.
 *
 * The ceiling is calibrated against live Base measurements checked in next to
 * the policy (`src/tools/evm-chains/gas-limit-provider-ceiling-measurement.md`).
 * The numbers below are from that file — do not change them without re-running
 * the probe it documents.
 */

import { describe, expect, it } from "vitest";

import {
  GAS_LIMIT_PROVIDER_CEILING_MIN_GAS,
  GAS_LIMIT_PROVIDER_CEILING_PERCENT,
  gasLimitForProviderHintedCall,
  gasLimitWithHeadroom,
} from "@tools/evm-chains/gas-limit-headroom.js";
import { VexError, ErrorCodes } from "../../../errors.js";

/** Live Base measurement 2026-07-25: our own fresh estimate for a Hyperstream native deposit. */
const OWN_ESTIMATE = 125_164n;
/** The gas figure Khalani's Hyperstream route actually returned for that call (1.20x). */
const HYPERSTREAM_PROVIDER_GAS = 150_196n;
/** DeBridge's figure for the same shape — exactly the node's unbuffered estimate (1.00x). */
const DEBRIDGE_PROVIDER_GAS = 146_049n;
const DEBRIDGE_OWN_ESTIMATE = 146_049n;
/**
 * The measurement that forced the absolute exemption: DeBridge's ERC-20 deposit
 * leg quotes a FLAT 640,000 against an own estimate of 184,057 (allowance
 * granted via `eth_estimateGas` state override) — 3.477x, and ~7.2x whenever our
 * own estimate lands at the low end of its measured 2.07x swing.
 */
const DEBRIDGE_ERC20_PROVIDER_GAS = 640_000n;
const DEBRIDGE_ERC20_OWN_ESTIMATE = 184_057n;

/** Large enough that the absolute exemption is out of the way. */
const LARGE_ESTIMATE = 2_000_000n;

function expectRefusal(fn: () => unknown): VexError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(VexError);
    return err as VexError;
  }
  throw new Error("expected a refusal, but the call returned");
}

describe("gasLimitForProviderHintedCall — the Vex-owned ceiling", () => {
  it("keeps the headroomed estimate as the floor when no provider figure is supplied", () => {
    // Live-measured 2026-07-25: Khalani's default Hyperstream ERC-20 route
    // supplies NO `gas` field at all, so this is the ordinary path.
    expect(gasLimitForProviderHintedCall(OWN_ESTIMATE, undefined)).toBe(gasLimitWithHeadroom(OWN_ESTIMATE));
  });

  it("admits the real provider figures measured on Khalani's live routes", () => {
    // Both are BELOW our headroomed floor, so the floor wins — but the point of
    // the assertion is that neither is refused. A ceiling that rejected a real
    // route would strand an autonomous bridge.
    expect(gasLimitForProviderHintedCall(OWN_ESTIMATE, HYPERSTREAM_PROVIDER_GAS))
      .toBe(gasLimitWithHeadroom(OWN_ESTIMATE));
    expect(gasLimitForProviderHintedCall(DEBRIDGE_OWN_ESTIMATE, DEBRIDGE_PROVIDER_GAS))
      .toBe(gasLimitWithHeadroom(DEBRIDGE_OWN_ESTIMATE));
  });

  it("still honours a provider figure above our headroomed floor but under the ceiling", () => {
    // The provider may know about state our estimate cannot see. 3x the fresh
    // estimate is above our 2x floor and below the 4x ceiling.
    const providerGas = LARGE_ESTIMATE * 3n;
    expect(gasLimitForProviderHintedCall(LARGE_ESTIMATE, providerGas)).toBe(providerGas);
  });

  it("admits a provider figure exactly AT the ceiling", () => {
    const atCeiling = (LARGE_ESTIMATE * GAS_LIMIT_PROVIDER_CEILING_PERCENT) / 100n;
    expect(gasLimitForProviderHintedCall(LARGE_ESTIMATE, atCeiling)).toBe(atCeiling);
  });

  it("refuses a provider figure one wei of gas above the ceiling", () => {
    const overCeiling = (LARGE_ESTIMATE * GAS_LIMIT_PROVIDER_CEILING_PERCENT) / 100n + 1n;
    const err = expectRefusal(() => gasLimitForProviderHintedCall(LARGE_ESTIMATE, overCeiling));
    expect(err.code).toBe(ErrorCodes.PROVIDER_GAS_LIMIT_EXCESSIVE);
  });

  /**
   * THE MEASUREMENT THAT CHANGED THE RULE. DeBridge's ERC-20 leg quotes a flat
   * 640,000 whatever the size, so its ratio to our own estimate is whatever the
   * estimator happens to say that block. A pure 4x ceiling refuses this real,
   * already-quoted bridge as soon as our estimate dips — which is a stranded
   * mission, not a saved dollar.
   */
  it("admits the live DeBridge ERC-20 leg, whose flat quote is 3.477x our own estimate", () => {
    expect(gasLimitForProviderHintedCall(DEBRIDGE_ERC20_OWN_ESTIMATE, DEBRIDGE_ERC20_PROVIDER_GAS))
      .toBe(DEBRIDGE_ERC20_PROVIDER_GAS);
  });

  it("still admits that leg when our own estimate dips to the low end of its 2.07x swing", () => {
    // 640,000 / 88,916 = 7.2x — far past the relative ceiling, still far below
    // the absolute exemption, so it must be signed rather than refused.
    const dippedEstimate = DEBRIDGE_ERC20_OWN_ESTIMATE / 2n;
    expect(gasLimitForProviderHintedCall(dippedEstimate, DEBRIDGE_ERC20_PROVIDER_GAS))
      .toBe(DEBRIDGE_ERC20_PROVIDER_GAS);
  });

  it("never refuses below the absolute exemption, however extreme the ratio", () => {
    // 100x the estimate, but the whole exposure is still under the floor.
    const providerGas = GAS_LIMIT_PROVIDER_CEILING_MIN_GAS;
    expect(gasLimitForProviderHintedCall(30_000n, providerGas)).toBe(providerGas);
  });

  it("fires once the ask is BOTH over the ratio and over the absolute exemption", () => {
    const providerGas = GAS_LIMIT_PROVIDER_CEILING_MIN_GAS + 1n;
    const err = expectRefusal(() => gasLimitForProviderHintedCall(30_000n, providerGas));
    expect(err.code).toBe(ErrorCodes.PROVIDER_GAS_LIMIT_EXCESSIVE);
  });

  it("keeps the exemption above every provider figure and signed limit on record", () => {
    // Largest Khalani provider figure observed: 640,000. Largest limit Vex has
    // ever signed anywhere: 2,052,472 (headroomed Base KyberSwap swap).
    expect(GAS_LIMIT_PROVIDER_CEILING_MIN_GAS).toBeGreaterThan(DEBRIDGE_ERC20_PROVIDER_GAS);
    expect(GAS_LIMIT_PROVIDER_CEILING_MIN_GAS).toBeGreaterThan(2_052_472n);
  });

  it("names every number the agent needs in the refusal", () => {
    // The 4.6x shape of the KyberSwap lowball, inverted: a provider asking for
    // 4.6x what we measured, at a size the exemption no longer covers.
    const providerGas = 9_200_000n;
    const ceiling = (LARGE_ESTIMATE * GAS_LIMIT_PROVIDER_CEILING_PERCENT) / 100n;
    const err = expectRefusal(() => gasLimitForProviderHintedCall(LARGE_ESTIMATE, providerGas));

    expect(err.message).toContain(String(providerGas));
    expect(err.message).toContain(String(ceiling));
    expect(err.message).toContain(String(LARGE_ESTIMATE));
    // Autonomy: says nothing was spent, and says what to do next.
    expect(err.message).toMatch(/[Nn]othing was signed or spent/);
    expect(err.message).toMatch(/re-quote/i);
    // ...and must NOT tell the agent to wait: a gas ESTIMATE does not move with
    // congestion, so "try again later" is the one useless instruction here.
    expect(err.hint).toMatch(/will not clear by waiting/i);
  });

  /**
   * `summarizeProtocolError` joins message + hint and truncates the pair at
   * `MAX_SAFE_ERROR_MESSAGE` (200). Everything the agent cannot act without —
   * the three numbers and "nothing was spent" — must therefore survive that
   * cut. This is the assertion that keeps a future reworded refusal honest.
   */
  it("fits the numbers and the outcome inside the 200-char agent-facing cap", () => {
    const providerGas = 9_200_000n;
    const ceiling = (LARGE_ESTIMATE * GAS_LIMIT_PROVIDER_CEILING_PERCENT) / 100n;
    const err = expectRefusal(() => gasLimitForProviderHintedCall(LARGE_ESTIMATE, providerGas));

    const bounded = `${err.message} — ${err.hint}`.replace(/\s+/g, " ").trim().slice(0, 200);
    expect(bounded).toContain(String(providerGas));
    expect(bounded).toContain(String(ceiling));
    expect(bounded).toContain(String(LARGE_ESTIMATE));
    expect(bounded).toMatch(/[Nn]othing was signed or spent/);
    expect(bounded).toMatch(/re-quote/i);
  });

  it("does not lower what we sign when the provider lowballs", () => {
    // Regression guard for the direction fixed on 2026-07-24 — the ceiling must
    // not have turned the floor into a clamp.
    const kyberLowball = 356_167n;
    const kyberOwnEstimate = 1_026_236n;
    expect(gasLimitForProviderHintedCall(kyberOwnEstimate, kyberLowball))
      .toBe(gasLimitWithHeadroom(kyberOwnEstimate));
  });

  it("keeps the relative ceiling above our own headroomed floor", () => {
    // The floor is 2x. A ceiling at or below it would turn every provider
    // figure above the floor into a refusal, which is the opposite of the
    // 2026-07-24 fix.
    expect(GAS_LIMIT_PROVIDER_CEILING_PERCENT).toBeGreaterThan(200n);
  });
});
