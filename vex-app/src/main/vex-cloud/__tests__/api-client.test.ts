/**
 * The main-process Vex Cloud HTTP client, with only `fetch` injected.
 *
 * Pinned:
 *  - the nonce response feeds the signer, so it is parsed STRICTLY: an
 *    unexpected server field, a CR or LF in the nonce, or a missing field is
 *    off contract and nothing is returned to sign;
 *  - the bearer travels only in `Authorization`, never in the URL, and no
 *    request follows a redirect;
 *  - each failure class stays distinct: 401, a definitive refusal with the
 *    backend's reason, an outage, off-contract, and the caller's cancel
 *    (never confused with the deadline).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createVexCloudApi } = await import("../api-client.js");

const NONCE = {
  nonce: "hXH9AJWIUDeN0XO0ikTN8RkHdeZvmKBH",
  expires_at: "2026-10-20T19:19:11.508Z",
  domain: "localhost",
  uri: "http://localhost:8787",
  chain_id: 4663,
  version: "1",
  statement: "Sign in to Vex Cloud with this wallet.",
  max_validity_seconds: 600,
};

interface Seen {
  url: string;
  init: RequestInit;
}

function api(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const client = createVexCloudApi({
    origin: () => "http://127.0.0.1:8787",
    fetch: (async (url: string, init: RequestInit) => {
      const entry = { url, init };
      seen.push(entry);
      return respond(entry);
    }) as typeof fetch,
    timeoutMs: 1_000,
  });
  return { client, seen };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the challenge is parsed strictly", () => {
  it("accepts the backend's exact shape", async () => {
    const { client } = api(() => json(NONCE));
    await expect(client.issueNonce(new AbortController().signal)).resolves.toEqual({ ok: true, value: NONCE });
  });

  it.each([
    ["an unexpected server field", { ...NONCE, resources: ["urn:evil"] }],
    ["a nonce carrying a line break", { ...NONCE, nonce: "abcdefgh\nURI: https://evil.example" }],
    ["a missing domain", (({ domain: _d, ...rest }) => rest)(NONCE)],
    ["a non-integer chain id", { ...NONCE, chain_id: "4663" }],
  ])("refuses %s as off contract", async (_name, body) => {
    const { client } = api(() => json(body));
    await expect(client.issueNonce(new AbortController().signal)).resolves.toEqual({
      ok: false,
      failure: { kind: "invalid_response" },
    });
  });
});

describe("the bearer", () => {
  it("is sent only in the Authorization header, and redirects are refused", async () => {
    const { client, seen } = api(() => json({}, 401));
    await client.readAccount("vxs_secret_bearer_value_0001", new AbortController().signal);

    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.url).toBe("http://127.0.0.1:8787/v1/account");
    expect(request?.url).not.toContain("vxs_");
    expect(new Headers(request?.init.headers).get("authorization")).toBe("Bearer vxs_secret_bearer_value_0001");
    expect(request?.init.redirect).toBe("error");
  });

  it("is absent on the unauthenticated calls", async () => {
    const { client, seen } = api(() => json(NONCE));
    await client.issueNonce(new AbortController().signal);
    expect(new Headers(seen[0]?.init.headers).has("authorization")).toBe(false);
  });
});

describe("failures stay distinct", () => {
  it("401 is unauthorized, with the backend's reason and address", async () => {
    const { client } = api(() =>
      json({ error: { code: 401, message: "Wallet sign-in was rejected.", metadata: { reason: "wallet_not_linked", address: `0x${"a".repeat(40)}` } } }, 401),
    );
    await expect(client.verify([], null, new AbortController().signal)).resolves.toEqual({
      ok: false,
      failure: { kind: "unauthorized", reason: "wallet_not_linked", address: `0x${"a".repeat(40)}` },
    });
  });

  it("409 is a definitive refusal naming its reason", async () => {
    const { client } = api(() => json({ error: { code: 409, message: "x", metadata: { reason: "address_already_linked" } } }, 409));
    await expect(client.verify([], null, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      failure: { kind: "rejected", status: 409, reason: "address_already_linked" },
    });
  });

  it.each([429, 500, 503])("%s is an outage", async (status) => {
    const { client } = api(() => json({ error: { code: status, message: "x" } }, status));
    await expect(client.issueNonce(new AbortController().signal)).resolves.toEqual({
      ok: false,
      failure: { kind: "unavailable", status },
    });
  });

  it("a network failure is an outage", async () => {
    const { client } = api(() => {
      throw new TypeError("fetch failed");
    });
    await expect(client.issueNonce(new AbortController().signal)).resolves.toEqual({
      ok: false,
      failure: { kind: "unavailable", status: null },
    });
  });

  it("the caller's cancel is cancelled, not an outage", async () => {
    const controller = new AbortController();
    const { client } = api(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          controller.abort();
        }),
    );
    await expect(client.issueNonce(controller.signal)).resolves.toEqual({ ok: false, failure: { kind: "cancelled" } });
  });

  it("the deadline is an outage, not a cancel", async () => {
    const { client } = api(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        }),
    );
    await expect(client.issueNonce(new AbortController().signal)).resolves.toEqual({
      ok: false,
      failure: { kind: "unavailable", status: null },
    });
  });

  it("an already-cancelled call never reaches the network", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, seen } = api(() => json(NONCE));
    await expect(client.issueNonce(controller.signal)).resolves.toEqual({ ok: false, failure: { kind: "cancelled" } });
    expect(seen).toHaveLength(0);
  });
});

describe("phase 2 calls (plan 15.2)", () => {
  it("a money POST carries the caller's Idempotency-Key and the bearer, and refuses redirects", async () => {
    const withdrawal = {
      id: "wd_1",
      status: "requested",
      amount_wei: "6000000000000000000000",
      destination: `0x${"1".repeat(40)}`,
      tx_hash: null,
      created_at: "2026-10-21T12:00:00.000Z",
      updated_at: "2026-10-21T12:00:00.000Z",
    };
    const { client, seen } = api(() => json({ withdrawal }, 202));
    const result = await client.createWithdrawal(
      "vxs_secret_bearer_value_0001",
      "vxw_0123456789abcdef",
      { amountWei: withdrawal.amount_wei, destination: withdrawal.destination },
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: true, value: { withdrawal } });
    const headers = new Headers(seen[0]?.init.headers);
    expect(headers.get("idempotency-key")).toBe("vxw_0123456789abcdef");
    expect(headers.get("authorization")).toBe("Bearer vxs_secret_bearer_value_0001");
    expect(seen[0]?.init.redirect).toBe("error");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ amount_wei: withdrawal.amount_wei, destination: withdrawal.destination });
  });

  it("refuses to send a malformed idempotency key", async () => {
    const { client, seen } = api(() => json({}));
    await expect(client.claimCashbackToBalance("vxs_secret_bearer_value_0001", "short", new AbortController().signal)).rejects.toThrow(RangeError);
    expect(seen).toHaveLength(0);
  });

  it("a 429 daily_limit_exceeded is a definitive refusal carrying remaining_wei; another 429 is an outage", async () => {
    const limited = api(() => json({ error: { code: 429, message: "x", metadata: { reason: "daily_limit_exceeded", remaining_wei: "42" } } }, 429));
    await expect(limited.client.claimCashbackToBalance("vxs_secret_bearer_value_0001", "vxc_0123456789", new AbortController().signal)).resolves.toEqual({
      ok: false,
      failure: { kind: "rejected", status: 429, reason: "daily_limit_exceeded", address: null, remainingWei: "42" },
    });
    const throttled = api(() => json({ error: { code: 429, message: "x", metadata: { reason: "rate_limited" } } }, 429));
    await expect(throttled.client.notifyDeposit("vxs_secret_bearer_value_0001", `0x${"a".repeat(64)}`, new AbortController().signal)).resolves.toEqual({
      ok: false,
      failure: { kind: "unavailable", status: 429, reason: "rate_limited" },
    });
  });

  it("a 503 keeps the backend's reason", async () => {
    const { client } = api(() => json({ error: { code: 503, message: "x", metadata: { reason: "rate_unavailable" } } }, 503));
    await expect(client.readWithdrawal("vxs_secret_bearer_value_0001", "wd_1", new AbortController().signal)).resolves.toEqual({
      ok: false,
      failure: { kind: "unavailable", status: 503, reason: "rate_unavailable" },
    });
  });

  it("round-trips the page cursor opaque and encoded", async () => {
    const { client, seen } = api(() => json({ items: [], next_cursor: null }));
    await client.listActivity("vxs_secret_bearer_value_0001", { cursor: "a+b/c=", limit: 10 }, new AbortController().signal);
    expect(seen[0]?.url).toBe("http://127.0.0.1:8787/v1/account/activity?limit=10&cursor=a%2Bb%2Fc%3D");
  });

  it("stops reading a body the moment it passes the bound", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
        if (pulled > 100) controller.close();
      },
    });
    const { client } = api(() => new Response(stream, { status: 200 }));
    await expect(client.listUsage("vxs_secret_bearer_value_0001", { cursor: null }, new AbortController().signal)).resolves.toEqual({
      ok: false,
      failure: { kind: "invalid_response" },
    });
    expect(pulled).toBeLessThan(10);
  });
});
