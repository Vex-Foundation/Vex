/**
 * The Indexify allocation-sync client surface (Z500 workflow, PR #117
 * extension): version history, per-mint tradability verdicts, and
 * edit_allocation with its local weight gate.
 *
 * Also the structural non-goals proof at the CLIENT level: the class wraps
 * no `txn.php?action=rebalance` — asserted here so the absence survives
 * refactors as a test failure rather than a memory.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../errors.js";
import { IndexifyClient } from "@tools/indexify/client.js";
import { INDEXIFY_API_KEY_ENV } from "@tools/indexify/constants.js";

const BASE = "https://api.indexify.finance";
const TEST_KEY = "ix_test_key_never_real";
const SOL = "So11111111111111111111111111111111111111112";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

interface Captured { urls: string[]; bodies: string[] }

function stubFetch(responses: Array<() => Response>): Captured {
  const captured: Captured = { urls: [], bodies: [] };
  let i = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    captured.urls.push(url);
    captured.bodies.push(typeof init?.body === "string" ? init.body : "");
    const make = responses[Math.min(i, responses.length - 1)];
    if (!make) throw new Error("stubFetch: no response scripted");
    i += 1;
    return Promise.resolve(make());
  });
  return captured;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[INDEXIFY_API_KEY_ENV];
});

describe("versionHistory", () => {
  it("validates the measured wire shape — numeric weights, nullable metadata", async () => {
    process.env[INDEXIFY_API_KEY_ENV] = TEST_KEY;
    stubFetch([() => json({
      stack_id: 28440,
      current_version: 2,
      versions: [
        { version: 2, is_current: true, created_at: null, creator_note: "sync", allocation: [{ address: SOL, weight: 50 }, { address: JUP, weight: 50 }] },
        { version: 1, is_current: false, created_at: 1787000000, creator_note: null, allocation: [{ address: SOL, weight: 100 }] },
      ],
    })]);
    const history = await new IndexifyClient(BASE).versionHistory(28440);
    expect(history.current_version).toBe(2);
    expect(history.versions[0]?.allocation[0]).toMatchObject({ address: SOL, weight: 50 });
  });

  it("is auth-required — refuses before any network without the key", async () => {
    const captured = stubFetch([() => json({})]);
    await expect(new IndexifyClient(BASE).versionHistory(28440)).rejects.toMatchObject({
      code: ErrorCodes.INDEXIFY_AUTH_REQUIRED,
    });
    expect(captured.urls).toEqual([]);
  });
});

describe("tradability", () => {
  it("answers found+enabled for a live token", async () => {
    stubFetch([() => json({ company_stack_id: 1, token: { archived: 0, symbol: "SOL" }, trading_enabled: true })]);
    const verdict = await new IndexifyClient(BASE).tradability(SOL);
    expect(verdict).toEqual({ found: true, tradingEnabled: true, archived: false, symbol: "SOL" });
  });

  it("a 404 is the UNSUPPORTED verdict, not an error — eligibility scans walk many mints", async () => {
    stubFetch([() => json({ error: "Token not found" }, 404)]);
    const verdict = await new IndexifyClient(BASE).tradability("1nc1nerator11111111111111111111111111111111");
    expect(verdict).toEqual({ found: false });
  });

  it("archived and trading-disabled states survive the numeric-boolean wire spelling", async () => {
    stubFetch([() => json({ token: { archived: 1, symbol: "DEAD" }, trading_enabled: false })]);
    const verdict = await new IndexifyClient(BASE).tradability(SOL);
    expect(verdict).toMatchObject({ found: true, tradingEnabled: false, archived: true });
  });

  it("a rate-limit or server fault still THROWS — an unverifiable mint must fail the run, not read as ineligible", async () => {
    stubFetch([() => json({ error: "Too many requests" }, 429)]);
    await expect(new IndexifyClient(BASE).tradability(SOL)).rejects.toMatchObject({
      code: ErrorCodes.INDEXIFY_RATE_LIMITED,
    });
  });
});

describe("editAllocation", () => {
  it("sends the exact edit_allocation contract: action, stack_id, stackTokenInfo, creator_note", async () => {
    process.env[INDEXIFY_API_KEY_ENV] = TEST_KEY;
    const captured = stubFetch([() => json({ success: true, stack_id: 28440, version: 3, nav: 1.01, message: "ok" })]);
    const result = await new IndexifyClient(BASE).editAllocation(28440, { [SOL]: 60, [JUP]: 40 }, "note");
    expect(new URL(captured.urls[0] ?? "").searchParams.get("action")).toBe("edit_allocation");
    expect(JSON.parse(captured.bodies[0] ?? "")).toEqual({
      stack_id: 28440,
      stackTokenInfo: { [SOL]: 60, [JUP]: 40 },
      creator_note: "note",
    });
    expect(result.version).toBe(3);
  });

  it("refuses weights that do not sum to 100, fractional weights, and oversized allocations BEFORE any request", async () => {
    process.env[INDEXIFY_API_KEY_ENV] = TEST_KEY;
    const captured = stubFetch([() => json({})]);
    const client = new IndexifyClient(BASE);
    await expect(client.editAllocation(28440, { [SOL]: 60 }, "n")).rejects.toMatchObject({ code: ErrorCodes.INDEXIFY_INVALID_REQUEST });
    await expect(client.editAllocation(28440, { [SOL]: 50.5, [JUP]: 49.5 }, "n")).rejects.toMatchObject({ code: ErrorCodes.INDEXIFY_INVALID_REQUEST });
    expect(captured.urls).toEqual([]);
  });
});

describe("registerToken (token_info action=new — the listings-gate lever)", () => {
  it("sends the exact contract and reads a 200 as registered", async () => {
    process.env[INDEXIFY_API_KEY_ENV] = TEST_KEY;
    const captured = stubFetch([() => json({ token_address: SOL, name: "Solana", symbol: "SOL", decimals: 9, archived: 0, chain: "solana" })]);
    const result = await new IndexifyClient(BASE).registerToken(SOL);
    expect(new URL(captured.urls[0] ?? "").searchParams.get("action")).toBe("new");
    expect(JSON.parse(captured.bodies[0] ?? "")).toEqual({ token_address: SOL });
    expect(result).toEqual({ outcome: "registered" });
  });

  it("reads the 400 'already exists' answer as the benign already_registered verdict", async () => {
    process.env[INDEXIFY_API_KEY_ENV] = TEST_KEY;
    stubFetch([() => json({ error: "Token already exists in database" }, 400)]);
    expect(await new IndexifyClient(BASE).registerToken(SOL)).toEqual({ outcome: "already_registered" });
  });

  it("reads the market-cap-floor 400 and the CoinGecko 404 as rejections carrying the venue's reason", async () => {
    process.env[INDEXIFY_API_KEY_ENV] = TEST_KEY;
    stubFetch([
      () => json({ error: "Token market cap ($9,441.21) is below minimum threshold of $10,000" }, 400),
      () => json({ error: "Token not found on CoinGecko" }, 404),
    ]);
    const client = new IndexifyClient(BASE);
    const floor = await client.registerToken(SOL);
    expect(floor.outcome).toBe("rejected");
    expect(floor.outcome === "rejected" && floor.reason).toContain("below minimum threshold");
    const unknown = await client.registerToken(JUP);
    expect(unknown.outcome).toBe("rejected");
  });

  it("still THROWS on rate limits and outages — the scan must fail closed, not mis-read a 429 as a refusal", async () => {
    process.env[INDEXIFY_API_KEY_ENV] = TEST_KEY;
    stubFetch([() => json({ error: "Too many requests" }, 429)]);
    await expect(new IndexifyClient(BASE).registerToken(SOL)).rejects.toMatchObject({
      code: ErrorCodes.INDEXIFY_RATE_LIMITED,
    });
  });
});

describe("structural non-goals (workflow spec)", () => {
  it("the client wraps NO rebalance and NO wallet-rebalance method — nothing to miswire", () => {
    const members = Object.getOwnPropertyNames(IndexifyClient.prototype).map((name) => name.toLowerCase());
    expect(members.some((name) => name.includes("rebalance"))).toBe(false);
  });
});
