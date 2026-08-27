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
    const make = responses[Math.min(i, responses.length - 1)]!;
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
    expect(history.versions[0]!.allocation[0]).toMatchObject({ address: SOL, weight: 50 });
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
    expect(new URL(captured.urls[0]!).searchParams.get("action")).toBe("edit_allocation");
    expect(JSON.parse(captured.bodies[0]!)).toEqual({
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

describe("structural non-goals (workflow spec)", () => {
  it("the client wraps NO rebalance and NO wallet-rebalance method — nothing to miswire", () => {
    const members = Object.getOwnPropertyNames(IndexifyClient.prototype).map((name) => name.toLowerCase());
    expect(members.some((name) => name.includes("rebalance"))).toBe(false);
  });
});
