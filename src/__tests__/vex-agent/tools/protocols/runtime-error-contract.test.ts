/**
 * W1 error contract (SPEC §1.5).
 *
 * Three guarantees the agent's next action depends on:
 *  1. `httpStatus` decides the category BEFORE any keyword scan — a 403 whose
 *     body was rewritten by `parseJsonResponse` into the provider's own prose
 *     (or a Cloudflare HTML page) used to classify `provider_error`, and the
 *     agent retried a call that can never succeed.
 *  2. The summary carries the machine-stable `code`, the `httpStatus` and a
 *     first-party `remediation`, and the render site emits all three.
 *  3. The sanitizer is unchanged — every step still runs, in the same order.
 */

import { describe, it, expect } from "vitest";

import { classifyError, summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { renderProtocolFailureOutput } from "@vex-agent/tools/protocols/runtime/errors.js";
import { VexError } from "../../../../errors.js";

function providerError(status: number, message: string): VexError {
  const err = new VexError("HTTP_REQUEST_FAILED", message);
  err.httpStatus = status;
  return err;
}

describe("classifyError — httpStatus beats the keyword scan", () => {
  it("classifies a 403 whose body reads like a provider malfunction as auth", () => {
    // The live shape: `parseJsonResponse` REPLACES "HTTP 403: Forbidden" with
    // the body's own message, so no "403"/"forbidden" digit survives the text.
    const err = providerError(403, "upstream service temporarily unavailable");
    expect(classifyError(err.message, err)).toBe("auth");
  });

  it("classifies a 401 as auth even when the text mentions a network socket", () => {
    const err = providerError(401, "socket closed by upstream");
    expect(classifyError(err.message, err)).toBe("auth");
  });

  it("classifies a 429 as rate_limit even when the text says nothing about limits", () => {
    const err = providerError(429, "please slow down");
    expect(classifyError(err.message, err)).toBe("rate_limit");
  });

  it("classifies a 400 as invalid_request rather than provider_error", () => {
    const err = providerError(400, "tokenIn is not a known address");
    expect(classifyError(err.message, err)).toBe("invalid_request");
  });

  it("classifies a 5xx as provider_error", () => {
    expect(classifyError("bad gateway", providerError(502, "bad gateway"))).toBe("provider_error");
  });

  it("keeps the insufficient-funds verdict ahead of the status branch", () => {
    // The money remedy must not be lost because a node wrapped the refusal in
    // an HTTP envelope; nothing in the status table produces this label.
    const err = providerError(400, "insufficient funds for gas * price + value");
    expect(classifyError(err.message, err)).toBe("insufficient_funds");
  });

  it("leaves a status-free error on its existing keyword path", () => {
    expect(classifyError("request timed out", new Error("request timed out"))).toBe("timeout");
  });
});

describe("summarizeProtocolError — the structured contract", () => {
  it("carries code, category, httpStatus and remediation for an auth failure", () => {
    const err = providerError(403, "forbidden by edge");
    const summary = summarizeProtocolError(err);
    expect(summary.code).toBe("HTTP_REQUEST_FAILED");
    expect(summary.category).toBe("auth");
    expect(summary.httpStatus).toBe(403);
    expect(summary.remediation).toContain("do not retry");
  });

  it("falls back to the category name as the code for a plain Error", () => {
    const summary = summarizeProtocolError(new Error("request timed out"));
    expect(summary.code).toBe("timeout");
    expect(summary.httpStatus).toBeUndefined();
  });

  it("keeps the insufficient-funds remedy in the message, past the cap", () => {
    const err = new Error(`${"x".repeat(400)} exceeds the balance of the account`);
    const summary = summarizeProtocolError(err);
    expect(summary.category).toBe("insufficient_funds");
    expect(summary.message.endsWith("top up the wallet or lower the amount")).toBe(true);
    expect(summary.remediation).toContain("top up the wallet");
  });

  it("keeps the remediation OFF the message for every non-money category", () => {
    // `message` stays "the sanitized provider cause" for the callers that
    // persist it; the render site is where the remedy is joined on.
    const summary = summarizeProtocolError(providerError(429, "slow down"));
    expect(summary.remediation).toBeDefined();
    expect(summary.message).toBe("slow down");
  });

  it("never emits the remediation twice on the money lane", () => {
    const summary = summarizeProtocolError(new Error("insufficient funds for gas"));
    const rendered = renderProtocolFailureOutput("x.y", summary);
    const remediation = summary.remediation ?? "";
    expect(rendered.split(remediation).length - 1).toBe(1);
  });
});

describe("renderProtocolFailureOutput — the agent-facing shape", () => {
  it("emits toolId, code, category, HTTP status and the remediation", () => {
    const rendered = renderProtocolFailureOutput(
      "kyberswap.swap.quote",
      summarizeProtocolError(providerError(403, "forbidden by edge")),
    );
    expect(rendered).toContain("kyberswap.swap.quote failed [HTTP_REQUEST_FAILED/auth, HTTP 403]:");
    expect(rendered).toContain("forbidden by edge");
    expect(rendered).toContain("do not retry");
  });

  it("omits the HTTP segment when no status was carried", () => {
    const rendered = renderProtocolFailureOutput(
      "dexscreener.search",
      summarizeProtocolError(new Error("request timed out")),
    );
    expect(rendered).toContain("dexscreener.search failed [timeout/timeout]:");
    expect(rendered).not.toContain("HTTP ");
  });

  it("keeps the (retryable) suffix", () => {
    const err = providerError(503, "upstream busy");
    err.retryable = true;
    const rendered = renderProtocolFailureOutput("pendle.pt.buy", summarizeProtocolError(err));
    expect(rendered.endsWith("(retryable)")).toBe(true);
  });
});

describe("the sanitizer's seven steps are unchanged", () => {
  it("still removes secrets, HTML documents, bodies, URLs and auth headers", () => {
    const err = providerError(
      403,
      "<html><body>blocked</body></html> {\"detail\":\"nope\"} https://edge.example/x?key=SECRETVALUE "
        + "Authorization: Bearer CANARY_TOKEN_7f3b",
    );
    const summary = summarizeProtocolError(err);
    expect(summary.message).not.toContain("SECRETVALUE");
    expect(summary.message).not.toContain("CANARY_TOKEN_7f3b");
    expect(summary.message).not.toContain("edge.example");
    expect(summary.message).not.toContain("<html");
    expect(summary.message).toContain("(html)");
    expect(summary.message).toContain("[body]");
    expect(summary.message).toContain("[url]");
    expect(summary.message).toContain("[auth]");
    // The status is a bounded integer, never scrubbed.
    expect(summary.httpStatus).toBe(403);
  });

  it("caps the combined message+hint at 320 characters", () => {
    const err = new VexError("X", "m".repeat(300), "h".repeat(300));
    const summary = summarizeProtocolError(err);
    expect(summary.message.length).toBeLessThanOrEqual(321);
    expect(summary.message.endsWith("…")).toBe(true);
  });
});
