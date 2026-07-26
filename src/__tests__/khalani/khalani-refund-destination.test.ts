/**
 * Khalani `refundTo` — a model-supplied refund destination must NEVER reach the
 * outbound provider request, and must be REJECTED BY NAME rather than silently
 * dropped.
 *
 * Why this suite exists
 * ---------------------
 * `refundTo` decides where the money goes when a bridge FAILS. It used to be a
 * tool param: model-supplied, normalized straight into the outbound quote body,
 * and ABSENT from the approval preview's `PREVIEW_KEY_ALLOWLIST`
 * (`engine/core/approval-intent-preview.ts`) — so a human approving a bridge
 * never saw it. A prompt injection reaching tool params could redirect the
 * refund of a failed bridge to an attacker, and because a bridge only refunds
 * on the unhappy path, the redirection would surface late, if ever.
 *
 * Prequote binding did NOT close it. `buildBridgeIdentity` bound `refundTo`
 * from PARAMS, so an attacker who set the SAME address on the quote AND the
 * execute produced two colliding hashes and the gate passed. Adding the key to
 * the approval preview would not close it either — it would only show the human
 * an address they have no basis to judge.
 *
 * So the capability is REMOVED, not disclosed: Vex derives `refundTo` from the
 * resolved source address (the wallet the funds are leaving), which is the one
 * destination that needs no authorization.
 *
 * Same doctrine and same mechanism as the referral-fee vector in
 * `khalani-referrer-fee-rejection.test.ts`; this suite asserts on the ACTUAL
 * request body the client would POST, exactly as that one does.
 *
 * Companion coverage: alias-boundary rejection lives in
 * `vex-agent/tools/dispatcher-bridge-alias.test.ts`; the identity no longer
 * reads the param at all (`vex-agent/tools/protocols/bridge-prequote/
 * build-identity.test.ts`); the manifest surface is pinned by
 * `vex-agent/tools/fee-params-never-from-model.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";

const mockChains = [
  { id: 1, name: "Ethereum", type: "eip155" },
  { id: 8453, name: "Base", type: "eip155" },
];

vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: async () => mockChains,
  resolveChainId: (input: string) => Number(input),
  getChainFamily: () => "eip155" as const,
}));

const {
  prepareQuoteRequest,
  findCallerSuppliedDestinationParam,
  findCallerSuppliedForbiddenParam,
  KHALANI_DERIVED_DESTINATION_PARAMS,
} = await import("@tools/khalani/request.js");

// EIP-55 checksummed — `normalizeAddressForFamily` rejects non-checksummed EVM
// addresses, so these must be the real casing.
const SELECTED_SOURCE_WALLET = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";
const RECIPIENT = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const ATTACKER = "0xeFEfeFEfeFeFEFEFEfefeFeFefEfEfEfeFEFEFEf";

const BASE_INPUT = {
  fromChain: "1",
  fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  toChain: "8453",
  toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "1000000",
  // In production this is the SESSION'S SELECTED source wallet, resolved by
  // `resolveSelectedAddress` before `prepareQuoteRequest` is ever called.
  fromAddress: SELECTED_SOURCE_WALLET,
  recipient: RECIPIENT,
};

describe("refundTo is DERIVED from the selected source wallet", () => {
  it("the outbound body refunds to the wallet the funds are leaving", async () => {
    const prepared = await prepareQuoteRequest(BASE_INPUT);

    expect(prepared.request.refundTo).toBe(SELECTED_SOURCE_WALLET);
    // Not merely equal to the recipient by accident — the recipient is a
    // different address here and the refund must not follow it.
    expect(prepared.request.refundTo).not.toBe(RECIPIENT);
  });

  it("tracks the source wallet when it changes (it is derived, not a constant)", async () => {
    const other = "0x1234567890AbcdEF1234567890aBcdef12345678";
    const prepared = await prepareQuoteRequest({ ...BASE_INPUT, fromAddress: other });

    expect(prepared.request.refundTo).toBe(other);
    expect(prepared.request.refundTo).toBe(prepared.request.fromAddress);
  });

  it("a caller cannot smuggle a refund address through the request builder input", async () => {
    // `QuoteRequestInput` no longer declares the key, so TypeScript rejects it
    // at compile time. This asserts the RUNTIME half: even when the key is
    // forced onto the input object, it cannot reach the wire.
    const smuggled = { ...BASE_INPUT, refundTo: ATTACKER };

    const prepared = await prepareQuoteRequest(smuggled);

    expect(prepared.request.refundTo).toBe(SELECTED_SOURCE_WALLET);

    // Serialize exactly as `client.getQuotes` would (it passes `request`
    // straight to `body:`) and assert on the wire text.
    const wire = JSON.stringify(prepared.request);
    expect(wire).not.toContain(ATTACKER);
    expect(wire).not.toContain(ATTACKER.toLowerCase());
  });

  it("does not break the rest of the money leg", async () => {
    const prepared = await prepareQuoteRequest(BASE_INPUT);

    expect(prepared.request.fromAddress).toBe(SELECTED_SOURCE_WALLET);
    expect(prepared.request.recipient).toBe(RECIPIENT);
    expect(prepared.request.amount).toBe("1000000");
  });
});

describe("findCallerSuppliedDestinationParam — names the offending parameter", () => {
  it("names refundTo when an address is supplied", () => {
    expect(findCallerSuppliedDestinationParam({ refundTo: ATTACKER })).toBe("refundTo");
  });

  it("flags a non-string value (a model can emit any JSON)", () => {
    expect(findCallerSuppliedDestinationParam({ refundTo: { evil: true } })).toBe("refundTo");
    expect(findCallerSuppliedDestinationParam({ refundTo: 42 })).toBe("refundTo");
  });

  it("treats absent / empty / whitespace as NOT supplied (no false rejection)", () => {
    expect(findCallerSuppliedDestinationParam({})).toBeNull();
    expect(findCallerSuppliedDestinationParam({ refundTo: "" })).toBeNull();
    expect(findCallerSuppliedDestinationParam({ refundTo: "   " })).toBeNull();
    expect(findCallerSuppliedDestinationParam({ refundTo: undefined })).toBeNull();
  });

  it("does not flag the legitimate bridge params", () => {
    expect(findCallerSuppliedDestinationParam(BASE_INPUT)).toBeNull();
  });

  it("covers exactly the one fund-destination key", () => {
    expect([...KHALANI_DERIVED_DESTINATION_PARAMS]).toEqual(["refundTo"]);
  });
});

describe("findCallerSuppliedForbiddenParam — the single check every entry point runs", () => {
  it("rejects refundTo BY NAME with a truthful reason (a silent drop would hide the attempt)", () => {
    const rejection = findCallerSuppliedForbiddenParam({ refundTo: ATTACKER });

    expect(rejection?.param).toBe("refundTo");
    expect(rejection?.reason).toMatch(/refunds a failed bridge to the wallet the funds left/);
    expect(rejection?.reason).toMatch(/never taken from tool input/);
  });

  it("still rejects the fee params, with their OWN reason", () => {
    expect(findCallerSuppliedForbiddenParam({ referrer: ATTACKER })).toEqual({
      param: "referrer",
      reason: "Vex never takes fee parameters from tool input.",
    });
    expect(findCallerSuppliedForbiddenParam({ referrerFeeBps: "9999" })?.param).toBe("referrerFeeBps");
  });

  it("reports the fee param first when a caller supplies both", () => {
    expect(findCallerSuppliedForbiddenParam({ refundTo: ATTACKER, referrer: ATTACKER })?.param)
      .toBe("referrer");
  });

  it("passes a clean param bag", () => {
    expect(findCallerSuppliedForbiddenParam(BASE_INPUT)).toBeNull();
  });
});
