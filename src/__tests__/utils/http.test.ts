/**
 * Boundary tests for parseJsonResponse (codex-002):
 *  - no schema → unchecked cast (backward compat);
 *  - schema + valid body → validated value;
 *  - schema + invalid body → HTTP_RESPONSE_INVALID (distinct from network fail);
 *  - non-ok with a {error} body → HTTP_REQUEST_FAILED carrying that message;
 *  - non-ok with a hostile/odd error body → safe fallback to status text;
 *  - unparseable success body → HTTP_REQUEST_FAILED.
 *
 * Plus the error-body widening: reading `error` ALONE discarded the provider's
 * own words whenever it named the field something else, which is how
 * `solana.predict.buy` came to show the agent "HTTP 400: Bad Request" while
 * Jupiter Prediction had answered "Minimum order is $5" (funded gate,
 * 2026-07-24).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJsonResponse } from "../../utils/http.js";
import { VexError, ErrorCodes } from "../../errors.js";

/** Minimal Response stand-in — parseJsonResponse only reads ok/status/statusText/json(). */
function fakeResponse(opts: {
  ok: boolean;
  status?: number;
  statusText?: string;
  json: () => Promise<unknown>;
}): Response {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    statusText: opts.statusText ?? "",
    json: opts.json,
  } as unknown as Response;
}

const schema = z.object({ id: z.string(), n: z.number() });

describe("parseJsonResponse (codex-002 boundary)", () => {
  it("returns an unchecked cast when no schema is supplied", async () => {
    const res = fakeResponse({ ok: true, json: async () => ({ anything: 1 }) });
    const out = await parseJsonResponse<{ anything: number }>(res);
    expect(out.anything).toBe(1);
  });

  it("returns the validated value when the schema matches", async () => {
    const res = fakeResponse({ ok: true, json: async () => ({ id: "x", n: 2 }) });
    const out = await parseJsonResponse(res, schema);
    expect(out).toEqual({ id: "x", n: 2 });
  });

  it("throws HTTP_RESPONSE_INVALID when the body fails the schema", async () => {
    const res = fakeResponse({ ok: true, json: async () => ({ id: "x", n: "nope" }) });
    await expect(parseJsonResponse(res, schema)).rejects.toMatchObject({
      code: ErrorCodes.HTTP_RESPONSE_INVALID,
    });
  });

  it("surfaces an {error} message from a non-ok body", async () => {
    const res = fakeResponse({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "upstream said no" }),
    });
    await expect(parseJsonResponse(res)).rejects.toMatchObject({
      code: ErrorCodes.HTTP_REQUEST_FAILED,
      message: "upstream said no",
    });
  });

  it("falls back to status text when the error body is not a {error:string} record", async () => {
    const res = fakeResponse({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      // hostile shape: error is an object, not a string — must NOT be used raw
      json: async () => ({ error: { nested: true } }),
    });
    await expect(parseJsonResponse(res)).rejects.toMatchObject({
      code: ErrorCodes.HTTP_REQUEST_FAILED,
      message: "HTTP 503: Service Unavailable",
    });
  });

  it("preserves httpStatus even when the provider supplied its own message", async () => {
    const res = fakeResponse({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({ message: "Region blocked" }),
    });
    await expect(parseJsonResponse(res)).rejects.toMatchObject({
      message: "Region blocked",
      httpStatus: 403,
    });
  });

  it("throws HTTP_REQUEST_FAILED when the success body is not JSON", async () => {
    const res = fakeResponse({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    await expect(parseJsonResponse(res, schema)).rejects.toBeInstanceOf(VexError);
  });
});

describe("parseJsonResponse — provider error-body field widening", () => {
  it("surfaces the provider's own {message} reason instead of the status line", async () => {
    // The EXACT body Jupiter Prediction returned for a $0.50 order during the
    // 2026-07-24 funded gate. Before the widening the agent saw only
    // "HTTP 400: Bad Request" and never learned the minimum.
    const res = fakeResponse({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({
        type: "invalid_request_error",
        message: "Minimum order is $5",
        code: "create_order_failed",
        request_id: "req_01HZY",
      }),
    });
    await expect(parseJsonResponse(res)).rejects.toMatchObject({
      code: ErrorCodes.HTTP_REQUEST_FAILED,
      message: "Minimum order is $5",
      httpStatus: 400,
    });
  });

  it("carries the provider's machine code on externalName, the repo's existing carrier", async () => {
    const res = fakeResponse({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ message: "Minimum order is $5", code: "create_order_failed" }),
    });
    await expect(parseJsonResponse(res)).rejects.toMatchObject({
      externalName: "create_order_failed",
    });
  });

  it("normalizes a NUMERIC machine code to the string externalName carries", async () => {
    const res = fakeResponse({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ message: "malformed params", code: 4001 }),
    });
    await expect(parseJsonResponse(res)).rejects.toMatchObject({ externalName: "4001" });
  });

  it("surfaces a detail-style reason field", async () => {
    const res = fakeResponse({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      json: async () => ({ detail: "amount must be greater than zero" }),
    });
    await expect(parseJsonResponse(res)).rejects.toMatchObject({
      message: "amount must be greater than zero",
    });
  });

  it("keeps `error` first — a body carrying BOTH is unchanged by the widening", async () => {
    const res = fakeResponse({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "upstream said no", message: "something else" }),
    });
    await expect(parseJsonResponse(res)).rejects.toMatchObject({ message: "upstream said no" });
  });

  it("never stringifies a structured value — an object reason still degrades to the status line", async () => {
    // Provider STRUCTURE is not a sentence: serializing it into the agent's
    // output is exactly the payload leak the scrub boundary exists to stop.
    const res = fakeResponse({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({ message: { nested: "deep" }, detail: ["a", "b"] }),
    });
    await expect(parseJsonResponse(res)).rejects.toMatchObject({
      message: "HTTP 500: Internal Server Error",
      externalName: undefined,
    });
  });

  it("ignores a blank reason field rather than emitting an empty message", async () => {
    const res = fakeResponse({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => ({ message: "   " }),
    });
    await expect(parseJsonResponse(res)).rejects.toMatchObject({
      message: "HTTP 502: Bad Gateway",
    });
  });
});
