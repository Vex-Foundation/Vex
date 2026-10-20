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
