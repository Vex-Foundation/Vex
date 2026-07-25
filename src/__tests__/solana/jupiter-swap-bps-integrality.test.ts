/**
 * Jupiter Swap API V2 request validation — a fractional or negative basis-point
 * value must never reach the wire.
 *
 * This is the INNER, defense-in-depth layer under the protocol-manifest gate
 * (`runtime/bps-param.ts`, covered by
 * `src/__tests__/vex-agent/tools/protocols/bps-param-integrality.test.ts`).
 * It exists because the manifest gate only protects params that flow through
 * `execute_tool`; anything calling the Jupiter client directly must fail closed
 * on its own.
 *
 * MEASURED DEFECT: Jupiter accepts a non-integer `slippageBps` and answers with
 * `otherAmountThreshold = 0` — a swap that will take ANY output. `0.5`, `50.5`,
 * and `50.9` all reproduced it. `assertNumberInRange` range-checked without an
 * integrality test, so `0.5` passed a `(0, 10_000)` bound and went out as
 * `slippageBps=0.5`.
 *
 * We assert on the ACTUAL OUTBOUND REQUEST — the URL the client hands to
 * `fetchJson` — rather than on a mock of the validator, so the test would still
 * catch a regression that bypassed validation entirely.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

import { VexError, ErrorCodes } from "../../errors.js";

const fetchJsonMock = vi.fn();

vi.mock("@utils/http.js", () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}));

const previousApiKey = process.env.JUPITER_API_KEY;
process.env.JUPITER_API_KEY = "test-key";

const { jupiterSwapBuild } = await import(
  "../../tools/solana-ecosystem/jupiter/jupiter-swaps/client.js"
);

afterAll(() => {
  if (previousApiKey === undefined) delete process.env.JUPITER_API_KEY;
  else process.env.JUPITER_API_KEY = previousApiKey;
});

/** Valid, mint-shaped base58 addresses — the address validator runs first. */
const INPUT_MINT = "So11111111111111111111111111111111111111112";
const OUTPUT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TAKER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function buildParams(slippageBps: number | undefined) {
  return {
    inputMint: INPUT_MINT,
    outputMint: OUTPUT_MINT,
    amount: "1000000000",
    taker: TAKER,
    ...(slippageBps === undefined ? {} : { slippageBps }),
  };
}

/** The URL actually handed to the HTTP layer — i.e. what would hit Jupiter. */
function outboundUrl(): string {
  expect(fetchJsonMock).toHaveBeenCalledTimes(1);
  const [url] = fetchJsonMock.mock.calls[0] as [string];
  return url;
}

/**
 * The rejection a build attempt produced. `VexError` splits its text: the
 * terse `Invalid <name>: <value>` goes in `.message`, and the actionable
 * correction the agent reads goes in `.hint` — so assertions on the guidance
 * must target `.hint`, not `toThrow(...)`.
 */
async function rejectionOf(params: Parameters<typeof jupiterSwapBuild>[0]): Promise<VexError> {
  try {
    await jupiterSwapBuild(params);
  } catch (err) {
    expect(err).toBeInstanceOf(VexError);
    return err as VexError;
  }
  throw new Error("expected jupiterSwapBuild to reject, but it resolved");
}

beforeEach(() => {
  fetchJsonMock.mockReset();
  fetchJsonMock.mockResolvedValue({});
});

describe("fractional slippageBps never reaches Jupiter", () => {
  for (const value of [0.5, 50.5, 50.9]) {
    it(`rejects ${value} and issues NO request`, async () => {
      await expect(jupiterSwapBuild(buildParams(value))).rejects.toThrow(
        /slippageBps/i,
      );
      // The load-bearing assertion: no outbound request was made at all, so the
      // value cannot have reached a provider request body.
      expect(fetchJsonMock).not.toHaveBeenCalled();
    });
  }

  it("the rejection names the parameter and the whole-number requirement", async () => {
    const err = await rejectionOf(buildParams(0.5));
    expect(err.code).toBe(ErrorCodes.INVALID_AMOUNT);
    expect(err.message).toContain("slippageBps");
    expect(err.hint).toMatch(/slippageBps must be a whole number/i);
  });

  it("the rejection names the correct form for the percentage likely meant", async () => {
    const err = await rejectionOf(buildParams(0.5));
    expect(err.hint).toContain("If you meant 0.5%, pass 50.");
  });
});

describe("negative slippageBps never reaches Jupiter", () => {
  it("rejects -1 and issues NO request", async () => {
    await expect(jupiterSwapBuild(buildParams(-1))).rejects.toThrow(/slippageBps/i);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });
});

describe("valid slippageBps is forwarded verbatim", () => {
  for (const value of [0, 1, 50, 250, 10_000]) {
    it(`sends slippageBps=${value} on the wire, unmodified`, async () => {
      await jupiterSwapBuild(buildParams(value));
      // Assert on the real query string, not on the validator's arguments.
      const params = new URL(outboundUrl()).searchParams;
      expect(params.get("slippageBps")).toBe(String(value));
    });
  }

  it("omitting slippageBps leaves it off the query string entirely", async () => {
    await jupiterSwapBuild(buildParams(undefined));
    expect(new URL(outboundUrl()).searchParams.has("slippageBps")).toBe(false);
  });

  it("a rejected value leaves no trace of itself in any request", async () => {
    await expect(jupiterSwapBuild(buildParams(50.5))).rejects.toThrow();
    const everySentUrl = fetchJsonMock.mock.calls.map((c) => String(c[0])).join(" ");
    expect(everySentUrl).not.toContain("50.5");
  });
});

describe("the same integrality rule covers Jupiter's other integral knobs", () => {
  // `assertNumberInRange` fed six call sites; every one of them is an integer
  // by Jupiter's contract, and every one silently accepted a fraction.
  it("rejects a fractional maxAccounts", async () => {
    const err = await rejectionOf({ ...buildParams(50), maxAccounts: 12.7 });
    expect(err.hint).toMatch(/maxAccounts must be a whole number/i);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  it("rejects a fractional blockhashSlotsToExpiry", async () => {
    const err = await rejectionOf({ ...buildParams(50), blockhashSlotsToExpiry: 10.5 });
    expect(err.hint).toMatch(/blockhashSlotsToExpiry must be a whole number/i);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  it("still accepts the integral forms of those knobs", async () => {
    await jupiterSwapBuild({
      ...buildParams(50),
      maxAccounts: 64,
      blockhashSlotsToExpiry: 300,
    });
    const params = new URL(outboundUrl()).searchParams;
    expect(params.get("maxAccounts")).toBe("64");
    expect(params.get("blockhashSlotsToExpiry")).toBe("300");
  });

  it("still enforces the pre-existing range bounds", async () => {
    const err = await rejectionOf({ ...buildParams(50), maxAccounts: 65 });
    expect(err.hint).toMatch(/maxAccounts must be between 1 and 64/i);
  });
});
