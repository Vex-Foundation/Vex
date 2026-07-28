/**
 * The Pendle convert body carries an EXACT, CLOSED key set — the fee-skim guard
 * (recon §2 C3).
 *
 * D1 rated the aggregator fee-skim CRITICAL: a convert body that accepts a
 * caller-supplied `routes.feeReceiver` was reproduced live at −20.0% of the
 * trade. It is not reachable in Vex today for one reason only — `convertMulti`
 * HARD-CONSTRUCTS the body with a closed field set and offers no params
 * passthrough. That is an invariant, not a coincidence, and nothing was
 * asserting it: the moment any card adds a caller-controlled convert-body field
 * the exploit becomes reachable, silently.
 *
 * So this suite pins the key set itself. A new key — however innocent —
 * fails here and forces a deliberate decision about whether a caller can reach
 * it. Two rules it enforces in particular, from rules/90:
 *   - fee, limit and destination parameters must NEVER originate from model
 *     input;
 *   - `useLimitOrder` stays false (load-bearing: the server DEFAULTS it to true,
 *     and the calldata guard refuses any route carrying maker fills).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockFetch = vi.fn();
const mockReadJson = vi.fn();
vi.mock("@utils/http.js", () => ({
  fetchWithTimeout: (...a: unknown[]) => mockFetch(...a),
  readJson: (...a: unknown[]) => mockReadJson(...a),
}));

const { PendleClient } = await import("@tools/pendle/client.js");
const { PENDLE_LIVE_FIXTURES: F } = await import("./fixtures.js");

/**
 * The COMPLETE set of keys Vex may POST to `/v3/sdk/{chainId}/convert`.
 *
 * Adding a key here is a money-path decision: state who supplies its value and
 * prove it can never come from model input.
 */
const ALLOWED_CONVERT_BODY_KEYS = [
  "receiver",
  "slippage",
  "inputs",
  "outputs",
  "enableAggregator",
  "aggregators",
  "useLimitOrder",
] as const;

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: { get: () => null };
  __json: unknown;
}
const res = (json: unknown): FakeResponse => ({ ok: true, status: 200, headers: { get: () => null }, __json: json });

let bodies: Array<Record<string, unknown>>;

beforeEach(() => {
  bodies = [];
  vi.clearAllMocks();
  mockReadJson.mockImplementation((r: FakeResponse) => Promise.resolve(r.__json));
  mockFetch.mockImplementation((url: string, options?: { body?: string }) => {
    if (String(url).includes("supported-aggregators")) return Promise.resolve(res(["kyberswap", "okx"]));
    if (options?.body) bodies.push(JSON.parse(options.body) as Record<string, unknown>);
    return Promise.resolve(res(F.buy));
  });
});

const RECEIVER = "0x742d35cc6634c0532925a3b844bc454e4438f44e";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const PT = "0x5a19fa369f2895dcd8d2cee62e4ceae58ef92bbb";
const YT = "0x8a9e90fe18e9d243f804022224fbd8380d6b76f6";

describe("the convert body's key set is closed", () => {
  it("single-leg convert sends EXACTLY the allowed keys and nothing else", async () => {
    await new PendleClient("https://example.invalid").convert(1, {
      receiver: RECEIVER,
      input: { token: USDC, amount: "100000000" },
      outputToken: PT,
      slippage: 0.005,
    });
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0]!).sort()).toEqual([...ALLOWED_CONVERT_BODY_KEYS].sort());
  });

  it("multi-leg convert (py mint/redeem) sends the SAME closed key set", async () => {
    await new PendleClient("https://example.invalid").convertMulti(1, {
      receiver: RECEIVER,
      inputs: [{ token: USDC, amount: "100000000" }],
      outputs: [PT, YT],
      slippage: 0.005,
    });
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0]!).sort()).toEqual([...ALLOWED_CONVERT_BODY_KEYS].sort());
  });

  it("carries NO fee, referrer, or alternative-destination field of any kind", async () => {
    await new PendleClient("https://example.invalid").convert(1, {
      receiver: RECEIVER,
      input: { token: USDC, amount: "100000000" },
      outputToken: PT,
      slippage: 0.005,
    });
    const keys = Object.keys(bodies[0]!).map((k) => k.toLowerCase());
    for (const forbidden of ["fee", "feereceiver", "feerecipient", "referrer", "referral", "partner", "destination", "recipient", "to"]) {
      expect(keys, `convert body must not carry "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it("the ONLY destination is `receiver`, and it is the value the caller passed", async () => {
    await new PendleClient("https://example.invalid").convert(1, {
      receiver: RECEIVER,
      input: { token: USDC, amount: "100000000" },
      outputToken: PT,
      slippage: 0.005,
    });
    expect(bodies[0]!.receiver).toBe(RECEIVER);
  });

  it("pins useLimitOrder false and enableAggregator true", async () => {
    await new PendleClient("https://example.invalid").convert(1, {
      receiver: RECEIVER,
      input: { token: USDC, amount: "100000000" },
      outputToken: PT,
      slippage: 0.005,
    });
    expect(bodies[0]!.useLimitOrder).toBe(false);
    expect(bodies[0]!.enableAggregator).toBe(true);
  });

  it("ignores any extra property smuggled onto the params object", async () => {
    // The manifest layer already rejects an undeclared parameter BY NAME
    // (`runtime/params.ts`); this proves the client is a second closed door
    // rather than a passthrough.
    const params = {
      receiver: RECEIVER,
      input: { token: USDC, amount: "100000000" },
      outputToken: PT,
      slippage: 0.005,
      feeReceiver: "0xdead000000000000000000000000000000000000",
      referrer: "0xdead000000000000000000000000000000000000",
    };
    await new PendleClient("https://example.invalid").convert(1, params as never);
    expect(Object.keys(bodies[0]!).sort()).toEqual([...ALLOWED_CONVERT_BODY_KEYS].sort());
    expect(JSON.stringify(bodies[0]!)).not.toContain("dead0000");
  });
});
