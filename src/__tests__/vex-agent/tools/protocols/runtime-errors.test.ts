/**
 * B-003 error summarisation + P0-1 VexError-hint surfacing.
 *
 * `summarizeProtocolError` is the single redaction owner for thrown protocol
 * errors. P0-1 folds a VexError's authored, agent-actionable `hint` (and a
 * `retryable` flag) into the agent-facing summary — but the hint MUST flow
 * through the SAME redact + internals-strip + 200-char cap as the message,
 * concatenated BEFORE the cap, never appended raw after it.
 */

import { describe, it, expect } from "vitest";

import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { VexError } from "../../../../errors.js";

describe("summarizeProtocolError — VexError hint surfacing (P0-1)", () => {
  it("folds a VexError hint into the message so the agent sees the next action", () => {
    const err = new VexError(
      "KYBER_NO_ROUTE",
      "No route for this pair",
      "Pass the exact contract address the quote returned, then retry.",
    );
    const s = summarizeProtocolError(err);
    expect(s.message).toContain("No route for this pair");
    expect(s.message).toContain("Pass the exact contract address");
  });

  it("redacts internals embedded in the hint (URL/secret) BEFORE the cap", () => {
    const err = new VexError(
      "X",
      "boom",
      "see https://api.provider.com/v1?key=SECRETVALUE for details",
    );
    const s = summarizeProtocolError(err);
    expect(s.message).toContain("boom");
    // The exact placeholder ([url]/[body]/[auth]) depends on the redact+pattern
    // interaction; what matters is that the host, secret, and scheme never survive
    // and that SOME internals placeholder proves the hint was stripped, not raw.
    expect(s.message).not.toContain("api.provider.com");
    expect(s.message).not.toContain("SECRETVALUE");
    expect(s.message).not.toContain("https://");
    expect(s.message).toMatch(/\[(url|body|auth)\]/);
  });

  it("caps the COMBINED message+hint (never raw-appends past the 200-char cap)", () => {
    const err = new VexError("X", "m".repeat(180), "h".repeat(180));
    const s = summarizeProtocolError(err);
    // 200 chars + the single ellipsis marker.
    expect(s.message.length).toBeLessThanOrEqual(201);
    expect(s.message.endsWith("…")).toBe(true);
  });

  it("surfaces retryable=true for a retryable VexError", () => {
    const err = new VexError("X", "transient upstream blip", "retry shortly");
    err.retryable = true;
    const s = summarizeProtocolError(err);
    expect(s.retryable).toBe(true);
  });

  it("omits retryable for a non-retryable VexError", () => {
    const s = summarizeProtocolError(new VexError("X", "permanent failure"));
    expect(s.retryable).toBeUndefined();
  });

  it("leaves a non-VexError byte-unchanged (no hint, no retryable)", () => {
    const s = summarizeProtocolError(new Error("plain network down"));
    expect(s.message).toBe("plain network down");
    expect(s.retryable).toBeUndefined();
    expect(s.category).toBe("network");
  });

  it("a VexError without a hint behaves exactly like the bare message", () => {
    const s = summarizeProtocolError(new VexError("X", "just a message"));
    expect(s.message).toBe("just a message");
    expect(s.retryable).toBeUndefined();
  });

  it("classifies the category on the message alone, not the hint", () => {
    // Message is a permanent provider error; hint mentions 'timeout' — category
    // must NOT flip to 'timeout' because of the hint text.
    const err = new VexError("X", "invalid argument", "increase the timeout if this recurs");
    const s = summarizeProtocolError(err);
    expect(s.category).not.toBe("timeout");
  });
});

// ── FIX4-SPINE C37 (Codex final-review round 3, finding 1) ──────────────────
//
// `summarizeProtocolError(err).message` is the ONE sufficient entry point —
// these pin the hardened scrub CORE directly (venue-side adversarial tests
// for the same shapes live in W2a's staged-execute-safety suite, in parallel).

describe("summarizeProtocolError — scrub-core hardening (FIX4-SPINE C37)", () => {
  it("Authorization: Bearer <token> never leaks the token (Codex's exact repro)", () => {
    // Codex reproduced this literally: the header-name pattern's `\S+` ate
    // only the word "Bearer", leaving the raw token sitting right after it —
    // "Authorization: Bearer ROUND3_CANARY_7f3b" → "[auth] ROUND3_CANARY_7f3b".
    const err = new Error("Authorization: Bearer ROUND3_CANARY_7f3b");
    const s = summarizeProtocolError(err);
    expect(s.message).not.toContain("ROUND3_CANARY_7f3b");
    expect(s.message).not.toContain("Bearer");
  });

  it("a bare Bearer token (no Authorization: prefix) never leaks", () => {
    const err = new Error("failed to auth with Bearer opaque_9f2xyz please retry");
    const s = summarizeProtocolError(err);
    expect(s.message).not.toContain("opaque_9f2xyz");
    expect(s.message).not.toContain("Bearer");
  });

  it("an embedded HTML document (gateway/proxy error page) is removed whole", () => {
    const err = new Error(
      "<!DOCTYPE html><html><head><title>502</title></head>"
        + "<body>nginx down user=admin</body></html>",
    );
    const s = summarizeProtocolError(err);
    expect(s.message).not.toContain("<html");
    expect(s.message).not.toContain("<body");
    expect(s.message).not.toContain("nginx down user=admin");
    // The HTML placeholder must survive later steps unmangled — it must NOT
    // use bracket characters that a later balanced-body scan would re-consume.
    expect(s.message).toContain("(html)");
  });

  it("a nested/balanced JSON body is removed as ONE whole span, not just its innermost level", () => {
    // The old single-level regex left the OUTER structure — `{"error":` and
    // the final `}` — visible; only the innermost `{"token":"..."}` matched,
    // producing `{"error":{"code":401,"details":[body]}}` (real payload keys
    // still exposed). The whole nested span must now collapse to ONE placeholder.
    const err = new Error('request failed {"error":{"code":401,"details":{"token":"abc123nested"}}}');
    const s = summarizeProtocolError(err);
    expect(s.message).not.toContain("abc123nested");
    expect(s.message).not.toContain('"error"');
    expect(s.message).not.toContain('"details"');
    expect(s.message).toBe("request failed [body]");
  });

  it("a credential-bearing URL (userinfo + query token) never leaks", () => {
    const err = new Error("https://user:p4ssw0rd@api.example.com/v1?key=SECRET123");
    const s = summarizeProtocolError(err);
    expect(s.message).not.toContain("p4ssw0rd");
    expect(s.message).not.toContain("SECRET123");
    expect(s.message).not.toContain("api.example.com");
    expect(s.message).not.toContain("https://");
  });

  it("a bare token= assignment (no URL/header context) never leaks", () => {
    const err = new Error("auth failed token=abc123XYZ retry");
    const s = summarizeProtocolError(err);
    expect(s.message).not.toContain("abc123XYZ");
  });

  it("a realistic combined error (URL+creds, Bearer, apiKey=, nested body) leaks nothing", () => {
    const err = new Error(
      "Provider 500 — POST https://user:p4ssw0rd@api.provider.io/v1/chat?key=topsecret123456789012 "
        + "Authorization: Bearer ROUND3_CANARY_7f3b apiKey=sk-or-v1-abc "
        + 'body={"messages":[{"role":"user"}]}',
    );
    const s = summarizeProtocolError(err);
    for (const fragment of [
      "p4ssw0rd", "topsecret123456789012", "api.provider.io", "https://",
      "ROUND3_CANARY_7f3b", "Bearer", "sk-or-v1-abc", '"messages"',
    ]) {
      expect(s.message).not.toContain(fragment);
    }
  });
});

// ── FIX5-SPINE (Codex final-review round 4, finding 1) ──────────────────────
//
// Three direct canary regressions found in FIX4's scrub core: the balanced-
// body scanner counted delimiters INSIDE JSON strings, the header pattern
// only consumed one token (leaking multi-part Basic/Cookie values), and a
// truncated bare HTML document (no closing tag) was emitted verbatim.

describe("summarizeProtocolError — scrub-core canaries (FIX5-SPINE)", () => {
  it("a bracket INSIDE a JSON string value no longer truncates the balanced-body scan (Codex's exact repro)", () => {
    // Codex's canary: `{"message":"secret ] after"}` — the `]` inside the
    // string value is NOT a real closing delimiter. The old scanner treated
    // it as one, ending the span early and leaking `after"}` as raw text.
    const err = new Error('leaked: {"message":"secret ] after"}');
    const s = summarizeProtocolError(err);
    expect(s.message).toBe("leaked: [body]");
    expect(s.message).not.toContain("secret");
    expect(s.message).not.toContain("after");
  });

  it("an escaped quote inside a JSON string does not end the string early", () => {
    const err = new Error('{"note":"a \\" b","token":"deepsecretXYZ"}');
    const s = summarizeProtocolError(err);
    expect(s.message).toBe("[body]");
    expect(s.message).not.toContain("deepsecretXYZ");
  });

  it("a multi-part Basic auth value (scheme word + base64, space-separated) never leaks the credential", () => {
    const err = new Error("Authorization: Basic dXNlcjpwYXNzMTIzNA==");
    const s = summarizeProtocolError(err);
    expect(s.message).not.toContain("dXNlcjpwYXNzMTIzNA==");
    expect(s.message).not.toContain("Basic");
  });

  it("a multi-part Cookie value (semicolon-separated pairs) never leaks the tail pair", () => {
    const err = new Error("Cookie: session=abc123; secondary=xyz789secret");
    const s = summarizeProtocolError(err);
    expect(s.message).not.toContain("abc123");
    expect(s.message).not.toContain("xyz789secret");
    expect(s.message).not.toContain("secondary");
  });

  it("a truncated bare <html> document (no closing tag anywhere) is fully dropped, not emitted verbatim", () => {
    const err = new Error(
      "<html><body>Internal server misconfiguration exposing REDACT_ME_PLEASE",
    );
    const s = summarizeProtocolError(err);
    expect(s.message).not.toContain("<html");
    expect(s.message).not.toContain("<body");
    expect(s.message).not.toContain("REDACT_ME_PLEASE");
    expect(s.message).toContain("(html)");
  });

  it("a truncated bare <body> fragment with no <html> wrapper and no close is also dropped", () => {
    const err = new Error("<body>partial dump leaking SENSITIVE_TAIL_VALUE");
    const s = summarizeProtocolError(err);
    expect(s.message).not.toContain("<body");
    expect(s.message).not.toContain("SENSITIVE_TAIL_VALUE");
    expect(s.message).toContain("(html)");
  });

  it("a well-formed <html>...</html> still collapses to one placeholder (no regression)", () => {
    const err = new Error(
      "<!DOCTYPE html><html><head><title>502</title></head>"
        + "<body>nginx down user=admin</body></html>",
    );
    const s = summarizeProtocolError(err);
    expect(s.message).toBe("(html)");
  });

  it("trailing text after a WELL-FORMED HTML close is preserved (no regression)", () => {
    const err = new Error("<html><body>gateway error</body></html> retry after 30s");
    const s = summarizeProtocolError(err);
    expect(s.message).toBe("(html) retry after 30s");
  });
});
