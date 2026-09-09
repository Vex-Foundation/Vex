/**
 * The reader's RPC transport: ONE retry owner, and a deadline that CANCELS.
 *
 * What this suite guards, and why each assertion exists:
 *  - the reader used to wrap every call in its own retry while `Connection`'s
 *    transport already retries HTTP 429 (`@solana/web3.js@1.98.4`
 *    `lib/index.esm.js:5024-5046`), and the deadline only ABANDONED the first
 *    request, so a slow provider could see two requests in flight for one read.
 *    The absence assertion below ("exactly one request was issued") is the
 *    regression for that;
 *  - the deadline now reaches the HTTP request through `ConnectionConfig.fetch`
 *    (`lib/index.d.ts:3180`, `FetchFn` at :3158), so the signal the transport
 *    received must actually be ABORTED when the deadline fires. A deadline that
 *    rejects while the socket stays open is the defect this catches;
 *  - JSON-RPC failures preserve the node code and original cause behind a
 *    sanitized error, distinct from a transport status or deadline. The reader
 *    uses getBalanceAndContext to avoid getBalance discarding those facts.
 *
 * The transport is driven with a scripted `fetch`, so no network is involved
 * and nothing global is patched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../../config/store.js", () => ({
  loadConfig: () => ({ solana: { rpcUrl: "https://rpc.invalid.test", commitment: "confirmed" } }),
}));

const { createDeadlineBoundSolanaRpc } = await import(
  "@tools/solana-ecosystem/balances/read-wallet-balances.js"
);

const { classifySolanaRpcFailure } = await import("@tools/solana-ecosystem/balances/rpc-failure.js");

const OWNER = new PublicKey("BfvP43eVzM7xAu6Pm7yYbqp8RVkbP8R8dCfTvgPp64Pg");
const SPL_TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** The reader's deadline. Kept in one place so the fake clock advances past it. */
const RPC_DEADLINE_MS = 10_000;

const requestIdSchema = z.object({ id: z.union([z.string(), z.number()]) });

/**
 * The JSON-RPC client matches responses to requests by `id`, so a scripted
 * answer has to echo the id the client actually generated. Reading it back out
 * of the request body is what makes these responses indistinguishable from a
 * real node's, which is the whole point of driving the real `Connection`.
 */
function echoId(init: RequestInit | undefined): string | number {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("expected a JSON-RPC request body");
  return requestIdSchema.parse(JSON.parse(body)).id;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createDeadlineBoundSolanaRpc", () => {
  it.each([403, 503])("retains HTTP %i and host after getBalance wraps the error", async (status) => {
    const rpc = createDeadlineBoundSolanaRpc({
      rpcUrl: "https://rpc.example.test/private-key?api-key=fixture-secret",
      fetch: async () => new Response("private provider body fixture-secret", { status }),
    });
    expect(rpc.endpointHost).toBe("rpc.example.test");
    const error: unknown = await rpc.getBalance(OWNER).catch((caught: unknown) => caught);
    expect(classifySolanaRpcFailure(error)).toEqual({ reason: `http_${status}`, endpointHost: "rpc.example.test" });
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("fixture-secret");
    expect(String(error)).not.toContain("private provider body");
  });

  it.each([
    ["ENOTFOUND", "dns"], ["EAI_AGAIN", "dns"], ["CERT_HAS_EXPIRED", "tls"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"], ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "tls"], ["EPROTO", "tls"], ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
    ["ECONNRESET", "connection_failed"],
  ])("preserves nested %s before the SDK discards the cause", async (code, reason) => {
    const rpc = createDeadlineBoundSolanaRpc({
      fetch: async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("private upstream data"), { code }) }); },
    });
    const error: unknown = await rpc.getBalance(OWNER).catch((caught: unknown) => caught);
    expect(classifySolanaRpcFailure(error)).toEqual({ reason, endpointHost: "rpc.invalid.test" });
    expect(String(error)).not.toContain("private upstream data");
  });

  it("classifies a malformed JSON document as invalid_response with host", async () => {
    const rpc = createDeadlineBoundSolanaRpc({ fetch: async () => new Response("not JSON", { status: 200 }) });
    const error: unknown = await rpc.getBalance(OWNER).catch((caught: unknown) => caught);
    expect(classifySolanaRpcFailure(error)).toEqual({ reason: "invalid_response", endpointHost: "rpc.invalid.test" });
  });

  it("aborts the in-flight fetch when the deadline fires, and issues no second request", async () => {
    const signals: AbortSignal[] = [];
    let requests = 0;

    const rpc = createDeadlineBoundSolanaRpc({
      fetch: (_input, init) => {
        requests += 1;
        const signal = init?.signal;
        if (!signal) throw new Error("the transport received no AbortSignal");
        signals.push(signal);
        // A request that never answers: only the deadline can end this call.
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });

    const call = rpc.getBalance(OWNER);
    const settled = call.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );

    await vi.advanceTimersByTimeAsync(RPC_DEADLINE_MS + 1);
    const outcome = await settled;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("the deadline did not reject");
    expect(outcome.err).toBeInstanceOf(Error);
    expect((outcome.err as Error).name).toBe("SolanaRpcDeadlineExceeded");

    // THE CANCELLATION ASSERTION: the signal the transport actually received
    // is aborted, so the HTTP request was cancelled, not abandoned.
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    // THE ABSENCE ASSERTION: no outer retry, so exactly one request existed.
    expect(requests).toBe(1);
  });

  it("issues exactly one request for a call the provider answers", async () => {
    let requests = 0;
    const rpc = createDeadlineBoundSolanaRpc({
      fetch: (_input, init) => {
        requests += 1;
        return Promise.resolve(
          jsonResponse({
            jsonrpc: "2.0",
            id: echoId(init),
            result: { context: { apiVersion: "4.2.0", slot: 441912462 }, value: 96740111 },
          }),
        );
      },
    });

    await expect(rpc.getBalance(OWNER)).resolves.toBe(96740111);
    expect(requests).toBe(1);
  });

  it("preserves the node JSON-RPC code and cause behind a safe token-account error", async () => {
    let requests = 0;
    const rpc = createDeadlineBoundSolanaRpc({
      fetch: (_input, init) => {
        requests += 1;
        return Promise.resolve(
          jsonResponse({
            jsonrpc: "2.0",
            id: echoId(init),
            error: { code: -32602, message: "Invalid param: WrongSize" },
          }),
        );
      },
    });

    const err = await rpc
      .getParsedTokenAccountsByOwner(OWNER, { programId: SPL_TOKEN_PROGRAM })
      .catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(Error);
    expect(classifySolanaRpcFailure(err)).toEqual({ reason: "rpc_-32602", endpointHost: "rpc.invalid.test" });
    expect((err as Error).cause).toMatchObject({ name: "SolanaJSONRPCError", code: -32602, message: expect.stringContaining("Invalid param: WrongSize") });
    expect(String(err)).not.toContain("Invalid param: WrongSize");
    // Not reclassified as a deadline, and issued once: no outer retry exists.
    expect(requests).toBe(1);
  });

  it("does not reclassify getBalance's own wrapped JSON-RPC error as a deadline", async () => {
    // The same RPC now uses getBalanceAndContext so its code and cause survive.
    // Only a real deadline produces SolanaRpcDeadlineExceeded.
    let requests = 0;
    const rpc = createDeadlineBoundSolanaRpc({
      fetch: (_input, init) => {
        requests += 1;
        return Promise.resolve(
          jsonResponse({
            jsonrpc: "2.0",
            id: echoId(init),
            error: { code: -32602, message: "Invalid param: WrongSize" },
          }),
        );
      },
    });

    const err = await rpc.getBalance(OWNER).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe("SolanaRpcDeadlineExceeded");
    expect(classifySolanaRpcFailure(err)).toEqual({ reason: "rpc_-32602", endpointHost: "rpc.invalid.test" });
    expect((err as Error).cause).toMatchObject({ code: -32602, message: expect.stringContaining("Invalid param: WrongSize") });
    expect(String(err)).not.toContain("Invalid param: WrongSize");
    expect(requests).toBe(1);
  });

  /**
   * THE 429, driven through the REAL `Connection` transport.
   *
   * MEASURED default (`@solana/web3.js@1.98.4` `lib/index.cjs.js:5053-5075`):
   * five attempts, sleeping 500+1000+2000+4000 = 7.5 s of this reader's 10 s
   * budget, with a `console.error` per retry. The call would then usually
   * surface as a TIMEOUT - our network reported slow when the provider had
   * answered, promptly, that we were over quota.
   *
   * Every assertion below is one half of that:
   *  - EXACTLY ONE fetch: `disableRetryOnRateLimit` is passed, so the library's
   *    retry loop breaks on the first 429 and no second request exists;
   *  - NO retry sleep: the clock is never advanced, so a suite that hung here
   *    would prove the sleeps still ran;
   *  - NO `console.error`: the library writes one per retry, and there are none;
   *  - `SolanaRpcRateLimited`, not `SolanaRpcDeadlineExceeded`.
   */
  it("reports a 429 as rate_limited, with one request, no retry sleep and no console noise", async () => {
    let requests = 0;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const rpc = createDeadlineBoundSolanaRpc({
        fetch: () => {
          requests += 1;
          return Promise.resolve(
            new Response("rate limit exceeded", {
              status: 429,
              statusText: "Too Many Requests",
            }),
          );
        },
      });

      const err = await rpc.getBalance(OWNER).catch((caught: unknown) => caught);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("SolanaRpcRateLimited");
      expect(requests).toBe(1);
      expect(consoleError).not.toHaveBeenCalled();
      // The provider's body never rides along in the reader's own error.
      expect((err as Error).message).not.toContain("rate limit exceeded");
    } finally {
      consoleError.mockRestore();
    }
  });

  /**
   * THE RACE. A 429 that lands as the deadline fires must still be reported as
   * a rate limit: the endpoint ANSWERED, and classifying it as a timeout would
   * send a reader looking for a slow network. Classification order in
   * `callRpc` is what decides this, and this test is that order's proof.
   */
  it("lets rate_limited win the deadline race", async () => {
    const rpc = createDeadlineBoundSolanaRpc({
      fetch: (_input, init) =>
        new Promise<Response>((resolve, reject) => {
          // The 429 is delivered by the abort itself: the response arrives at
          // the same instant the deadline cancels the request.
          init?.signal?.addEventListener(
            "abort",
            () => {
              resolve(new Response("slow down", { status: 429, statusText: "Too Many Requests" }));
            },
            { once: true },
          );
          // Nothing else can settle this call.
          void reject;
        }),
    });

    const settled = rpc
      .getBalance(OWNER)
      .then(() => null, (caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(RPC_DEADLINE_MS + 1);
    const err = await settled;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("SolanaRpcRateLimited");
  });

  /**
   * THE CROSS CASE the two arcs create together: a caller Stop and a 429 on the
   * SAME request. Both classifications are live on this path now, so the
   * precedence is pinned rather than left to whichever check happens to run
   * first (`callRpc`'s comment states it):
   *
   *  - a 429 that ARRIVED for this call wins, because the endpoint answered and
   *    declined to serve - a fact about the provider's quota;
   *  - an abort with NO response stays cancellation, which is the case the
   *    caller-stop test below proves.
   */
  it("classifies a 429 that arrived before the caller's abort as rate_limited, not cancellation", async () => {
    const controller = new AbortController();
    const rpc = createDeadlineBoundSolanaRpc({
      signal: controller.signal,
      fetch: (_input, init) =>
        new Promise<Response>((resolve) => {
          // The provider's 429 is what settles this request, and it lands as
          // the caller's Stop trips the same controller.
          init?.signal?.addEventListener(
            "abort",
            () => resolve(new Response("slow down", { status: 429, statusText: "Too Many Requests" })),
            { once: true },
          );
        }),
    });

    const settled = rpc.getBalance(OWNER).then(
      () => null,
      (caught: unknown) => caught,
    );
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new DOMException("the operator stopped the turn", "AbortError"));
    const err = await settled;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("SolanaRpcRateLimited");
    expect((err as Error).name).not.toBe("SolanaRpcDeadlineExceeded");
  });

  it("aborts the in-flight fetch when the CALLER stops mid-request, and reports the caller's reason", async () => {
    // The operator-Stop counterpart of the deadline test above, at the same
    // TRANSPORT level: a real fetch-shaped request is in flight and is then
    // aborted from outside. A pre-aborted signal cannot prove this - it never
    // reaches the socket - and an injected `rpc` seam cannot prove it either,
    // because it bypasses the transport entirely.
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    let requests = 0;

    const rpc = createDeadlineBoundSolanaRpc({
      signal: controller.signal,
      fetch: (_input, init) => {
        requests += 1;
        const signal = init?.signal;
        if (!signal) throw new Error("the transport received no AbortSignal");
        signals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });

    const settled = rpc.getBalance(OWNER).then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err }),
    );

    // The request is genuinely in flight before the Stop arrives.
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toBe(1);
    expect(signals[0]?.aborted).toBe(false);

    const reason = new DOMException("the operator stopped the turn", "AbortError");
    controller.abort(reason);
    const outcome = await settled;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("the caller's abort did not reject the call");
    // CLASSIFICATION: the caller's own reason, never the reader's deadline.
    expect(outcome.err).toBe(reason);
    expect((outcome.err as Error).name).not.toBe("SolanaRpcDeadlineExceeded");
    // The socket was CANCELLED, not abandoned to run to completion.
    expect(signals[0]?.aborted).toBe(true);
    expect(requests).toBe(1);
  });

  it("refuses an overlapping call rather than sharing another call's deadline", async () => {
    const rpc = createDeadlineBoundSolanaRpc({
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    });

    const first = rpc.getBalance(OWNER).catch(() => undefined);
    await expect(rpc.getBalance(OWNER)).rejects.toThrow(/sequential/);

    await vi.advanceTimersByTimeAsync(RPC_DEADLINE_MS + 1);
    await first;
  });
});
