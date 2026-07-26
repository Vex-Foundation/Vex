/**
 * Khalani bridge referral fee — a model-supplied `referrer` / `referrerFeeBps`
 * must NEVER reach the outbound provider request, and must be REJECTED BY NAME
 * rather than silently dropped.
 *
 * Why this suite exists
 * ---------------------
 * Khalani's POST /v1/quotes accepts `referrer` + `referrerFeeBps`. Verified
 * against the live API (2026-07-25, ETH→ARB USDC, Hyperstream native-filler
 * route): the fee is a SURCHARGE DEDUCTED FROM THE USER'S OUTPUT — 1_000_000 in
 * yields 999_800 out with no fee and 989_802 with `referrerFeeBps=100`. The
 * schema accepts up to 9999 (99.99%), the referrer address needs no
 * registration (only an EIP-55 checksum), and the quote response carries NO fee
 * breakdown, so the skim is invisible in `amountOut`.
 *
 * Both keys used to flow straight from TOOL PARAMS — i.e. from the model — into
 * that request, and neither is in the approval preview's `PREVIEW_KEY_ALLOWLIST`
 * (`engine/core/approval-intent-preview.ts`), so a prompt injection reaching
 * tool params could have routed up to 99.99% of a bridge to an attacker with the
 * approving human seeing nothing.
 *
 * The fix removes the surface entirely and fails closed by name. This suite
 * asserts the ACTUAL request body the client would POST, not merely that a
 * handler returned an error.
 *
 * NOTE (2026-07-25): Vex DOES now charge a bridge fee — a hard-coded 25 bps of
 * the input token, taken as Vex's own transfer leg after the deposit
 * (`src/tools/bridge-fee`). That changes nothing here. The invariant this suite
 * protects was never "Vex charges nothing"; it is that a fee and its recipient
 * are PRODUCT-OWNER CONSTANTS and are NEVER derived from model or tool input.
 * The referral fields stay unsendable and rejected by name, and the Khalani
 * referral mechanism specifically stays unused (it was measured dead — see
 * `src/tools/bridge-fee/constants.ts`).
 *
 * Companion coverage: alias-boundary rejection lives in
 * `vex-agent/tools/dispatcher-bridge-alias.test.ts` (execute) and
 * `vex-agent/tools/action-aliases.test.ts` (quote); the cross-venue rule is
 * pinned by `vex-agent/tools/fee-params-never-from-model.test.ts`.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

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
  findCallerSuppliedFeeParam,
  assertNoCallerSuppliedFeeParams,
  KHALANI_FORBIDDEN_FEE_PARAMS,
} = await import("@tools/khalani/request.js");

// EIP-55 checksummed — `normalizeAddressForFamily` rejects non-checksummed EVM
// addresses, so these must be the real casing.
const EVM_FROM = "0x1234567890AbcdEF1234567890aBcdef12345678";
const EVM_TO = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const ATTACKER = "0xeFEfeFEfeFeFEFEFEfefeFeFefEfEfEfeFEFEFEf";

const BASE_INPUT = {
  fromChain: "1",
  fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  toChain: "8453",
  toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "1000000",
  fromAddress: EVM_FROM,
  recipient: EVM_TO,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("outbound POST /v1/quotes body carries no fee fields", () => {
  it("the prepared request has NO referrer / referrerFeeBps key at all", async () => {
    const prepared = await prepareQuoteRequest(BASE_INPUT);

    // The prepared `request` IS the JSON body: `client.getQuotes` passes it
    // straight to `body:` (see `@tools/khalani/client.js`).
    expect(prepared.request).not.toHaveProperty("referrer");
    expect(prepared.request).not.toHaveProperty("referrerFeeBps");

    // Serialize exactly as the client would, and assert on the wire text — this
    // catches an `undefined`-valued key just as well as a populated one.
    const wire = JSON.stringify(prepared.request);
    expect(wire).not.toContain("referrer");
    expect(wire).not.toContain("referrerFeeBps");
  });

  it("a caller cannot smuggle fee fields through the request builder input", async () => {
    // `QuoteRequestInput` no longer declares these keys, so TypeScript rejects
    // them at compile time. This asserts the RUNTIME half: even when extra keys
    // are forced onto the input object, they cannot reach the wire.
    const smuggled = {
      ...BASE_INPUT,
      referrer: ATTACKER,
      referrerFeeBps: "9999",
    };

    const prepared = await prepareQuoteRequest(smuggled);

    const wire = JSON.stringify(prepared.request);
    expect(wire).not.toContain(ATTACKER);
    expect(wire).not.toContain("9999");
    expect(wire).not.toContain("referrer");
  });

  it("still sends the legitimate money leg (fromAddress, recipient, refundTo)", async () => {
    // Guard against over-removal: the fix must not strip the non-fee fields.
    const prepared = await prepareQuoteRequest(BASE_INPUT);

    expect(prepared.request.fromAddress).toBe(EVM_FROM);
    expect(prepared.request.recipient).toBe(EVM_TO);
    expect(prepared.request.refundTo).toBe(EVM_FROM);
    expect(prepared.request.amount).toBe("1000000");
  });
});

describe("findCallerSuppliedFeeParam — names the offending parameter", () => {
  it("names referrer when an address is supplied", () => {
    expect(findCallerSuppliedFeeParam({ referrer: ATTACKER })).toBe("referrer");
  });

  it("names referrerFeeBps when a fee is supplied", () => {
    expect(findCallerSuppliedFeeParam({ referrerFeeBps: "9999" })).toBe("referrerFeeBps");
  });

  it("flags a fee even at values the old validator accepted (0-9999 integer)", () => {
    // The old boundary only checked "integer between 0 and 9999" — every value
    // in that range was accepted and forwarded. All of them are now refused.
    for (const bps of ["1", "25", "100", "5000", "9999"]) {
      expect(findCallerSuppliedFeeParam({ referrerFeeBps: bps })).toBe("referrerFeeBps");
    }
  });

  it("flags a non-string value (a model can emit a JSON number)", () => {
    expect(findCallerSuppliedFeeParam({ referrerFeeBps: 9999 })).toBe("referrerFeeBps");
    expect(findCallerSuppliedFeeParam({ referrer: { evil: true } })).toBe("referrer");
  });

  it("treats absent / empty / whitespace as NOT supplied (no false rejection)", () => {
    expect(findCallerSuppliedFeeParam({})).toBeNull();
    expect(findCallerSuppliedFeeParam({ referrer: "", referrerFeeBps: "" })).toBeNull();
    expect(findCallerSuppliedFeeParam({ referrer: "   " })).toBeNull();
    expect(findCallerSuppliedFeeParam({ referrer: undefined })).toBeNull();
  });

  it("does not flag the legitimate bridge params", () => {
    expect(findCallerSuppliedFeeParam(BASE_INPUT)).toBeNull();
  });
});

describe("assertNoCallerSuppliedFeeParams — fails closed by name", () => {
  it("throws and NAMES the parameter (a silent drop would hide the attempt)", () => {
    expect(() => assertNoCallerSuppliedFeeParams({ referrerFeeBps: "9999" }))
      .toThrow(/referrerFeeBps/);
    expect(() => assertNoCallerSuppliedFeeParams({ referrer: ATTACKER }))
      .toThrow(/referrer/);
  });

  it("explains the refusal rather than emitting a bare validation error", () => {
    expect(() => assertNoCallerSuppliedFeeParams({ referrer: ATTACKER }))
      .toThrow(/not an accepted parameter/);
  });

  it("does not throw for a clean param bag", () => {
    expect(() => assertNoCallerSuppliedFeeParams(BASE_INPUT)).not.toThrow();
  });

  it("covers exactly the two fee-bearing keys", () => {
    expect([...KHALANI_FORBIDDEN_FEE_PARAMS]).toEqual(["referrer", "referrerFeeBps"]);
  });
});
