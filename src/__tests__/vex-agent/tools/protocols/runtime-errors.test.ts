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
import { VexError, ErrorCodes } from "../../../../errors.js";

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

// ── Honest failure attribution ──────────────────────────────────────────────
//
// `provider_error` for ANY Error instance told the agent that OUR OWN parameter
// validation was a provider malfunction, which points it at retrying instead of
// fixing its input. Live proof (2026-07-24): `uniswap.swap.quote failed
// (provider_error): Cannot read decimals for 0x0000…0000 — not a valid ERC-20
// contract on this chain`.

describe("summarizeProtocolError — who actually rejected the call", () => {
  it("labels OUR OWN parameter validation as invalid_request, not the provider's fault", () => {
    // The exact live case: thrown by `uniswap/erc20.ts` after the address the
    // model supplied failed to answer `decimals()`.
    const err = new VexError(
      ErrorCodes.KYBER_TOKEN_NOT_FOUND,
      "Cannot read decimals for 0x0000000000000000000000000000000000000000 — not a valid ERC-20 contract on this chain",
      "Verify the token address and chain are correct.",
    );
    expect(summarizeProtocolError(err).category).toBe("invalid_request");
  });

  it("labels every other local validation code the same way", () => {
    for (const code of [
      ErrorCodes.AGENT_VALIDATION_ERROR,
      ErrorCodes.INVALID_ADDRESS,
      ErrorCodes.SOLANA_INVALID_ADDRESS,
      ErrorCodes.INVALID_AMOUNT,
      ErrorCodes.CHAIN_MISMATCH,
      ErrorCodes.INVALID_SPENDER,
    ]) {
      expect(summarizeProtocolError(new VexError(code, "bad parameter")).category)
        .toBe("invalid_request");
    }
  });

  it("keeps provider_error when a PROVIDER answered — httpStatus proves the verdict was theirs", () => {
    // Same code, but `parseJsonResponse` stamped a status: the provider parsed
    // our request and refused it, so the label must stay theirs.
    const err = new VexError(ErrorCodes.KYBER_TOKEN_NOT_FOUND, "token not found");
    err.httpStatus = 400;
    expect(summarizeProtocolError(err).category).toBe("provider_error");
  });

  it("keeps provider_error when externalName proves a provider error mapper produced it", () => {
    // KyberSwap code 4011 → KYBER_TOKEN_NOT_FOUND via `mapAggregatorError`,
    // which always stamps the raw provider code on externalName.
    const err = new VexError(ErrorCodes.KYBER_TOKEN_NOT_FOUND, "token not found");
    err.externalName = "4011";
    expect(summarizeProtocolError(err).category).toBe("provider_error");
  });

  it("keeps today's label for an unrecognized code rather than guessing", () => {
    expect(summarizeProtocolError(new VexError("SOME_UNMAPPED_CODE", "boom")).category)
      .toBe("provider_error");
    expect(summarizeProtocolError(new Error("boom")).category).toBe("provider_error");
  });

  it("still classifies transport shapes first — a local code does not mask a timeout", () => {
    // Non-VexError throws are untouched by the new branch.
    expect(summarizeProtocolError(new Error("request timed out")).category).toBe("timeout");
    expect(summarizeProtocolError(new Error("ECONNREFUSED")).category).toBe("network");
  });
});

// ── First-party instructions must stay followable ───────────────────────────
//
// Redaction protects secrets and untrusted provider text. It was also erasing
// the portal link out of `jupiter-auth.ts`'s hint, so the agent was told to
// generate a key at "[url]" — an instruction it had been made unable to follow.

describe("summarizeProtocolError — hint links (FIX4)", () => {
  it("keeps a credential-free portal link in a first-party hint", () => {
    // Verbatim from `requireJupiterApiKey` in `jupiter-auth.ts`.
    const err = new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      "JUPITER_API_KEY is required for Jupiter Prediction.",
      "Generate a key at https://portal.jup.ag and add it through Vex setup.",
    );
    const s = summarizeProtocolError(err);
    expect(s.message).toContain("https://portal.jup.ag");
    expect(s.message).not.toContain("[url]");
  });

  it("keeps a link that ends a sentence, punctuation and all", () => {
    const err = new VexError("X", "boom", "Read the docs at https://docs.example.com/setup.");
    expect(summarizeProtocolError(err).message).toContain("https://docs.example.com/setup.");
  });

  it("still collapses a hint link that CAN carry a credential (query / userinfo / fragment)", () => {
    for (const hint of [
      "see https://api.provider.com/v1?key=SECRETVALUE",
      "see https://user:p4ssw0rd@api.provider.com/v1",
      "see https://api.provider.com/v1#token=SECRETVALUE",
    ]) {
      const s = summarizeProtocolError(new VexError("X", "boom", hint));
      expect(s.message).toContain("[url]");
      expect(s.message).not.toContain("SECRETVALUE");
      expect(s.message).not.toContain("p4ssw0rd");
      expect(s.message).not.toContain("api.provider.com");
    }
  });

  it("still collapses a non-https hint link (no transport guarantee, no carve-out)", () => {
    const s = summarizeProtocolError(new VexError("X", "boom", "see http://portal.jup.ag"));
    expect(s.message).toContain("[url]");
    expect(s.message).not.toContain("portal.jup.ag");
  });

  it("does NOT extend the carve-out to the MESSAGE lane, which is provider-written", () => {
    // The message may be the provider's own words; a bare host there is still
    // an internal we do not emit.
    const s = summarizeProtocolError(new Error("upstream refused at https://portal.jup.ag"));
    expect(s.message).toContain("[url]");
    expect(s.message).not.toContain("portal.jup.ag");
  });

  it("keeps the rest of the hint pipeline intact — secrets in a hint still die", () => {
    const err = new VexError("X", "boom", "use apiKey=sk-or-v1-abc at https://portal.jup.ag");
    const s = summarizeProtocolError(err);
    expect(s.message).not.toContain("sk-or-v1-abc");
    expect(s.message).toContain("https://portal.jup.ag");
  });
});

// ── A Vex safety refusal is not a provider malfunction ──────────────────────
//
// The category tells the agent WHO refused, and that decides its next move.
// Every VexError outside the local-validation set fell through to
// `provider_error`, so Vex's own money-path guards — the calldata price floor,
// the unsafe-build abort, the provider-gas-limit ceiling — were reported as
// KyberSwap/Uniswap malfunctioning. That reads as "the venue is having a
// moment, retry" when the truth is "Vex looked at what it was about to sign
// and refused"; retrying reproduces it every time, and the agent never learns
// its trade was stopped on purpose.
//
// Attribution only. Whether a retry is sane is `retryable`'s job and stays
// independent of this label.

describe("summarizeProtocolError — Vex-authored safety refusals", () => {
  const POLICY_REFUSAL_CODES = [
    ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED,
    ErrorCodes.KYBER_UNSAFE_BUILD,
    ErrorCodes.PROVIDER_GAS_LIMIT_EXCESSIVE,
    ErrorCodes.NATIVE_VALUE_UNAUTHORIZED,
    ErrorCodes.PENDLE_UNSAFE_TX,
    ErrorCodes.SOLANA_TX_SOLE_SIGNER_VIOLATION,
    ErrorCodes.SOLANA_TX_BLOCKHASH_MISMATCH,
  ] as const;

  it("labels every allowlisted guard code policy_refusal", () => {
    for (const code of POLICY_REFUSAL_CODES) {
      expect(summarizeProtocolError(new VexError(code, "refused before signing")).category)
        .toBe("policy_refusal");
    }
  });

  it("names the real live case — a price floor violated in built calldata", () => {
    // Thrown by the KyberSwap calldata guard when the built swap's embedded
    // `minReturnAmount` sits below the floor Vex approved at quote time.
    const err = new VexError(
      ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED,
      "Built calldata minReturnAmount 990000 is below the approved floor 995000",
      "Re-quote and retry with the same slippageBps.",
    );
    expect(summarizeProtocolError(err).category).toBe("policy_refusal");
  });

  it("yields to a provider's verdict when httpStatus proves one answered", () => {
    for (const code of POLICY_REFUSAL_CODES) {
      const err = new VexError(code, "refused");
      err.httpStatus = 400;
      expect(summarizeProtocolError(err).category).toBe("provider_error");
    }
  });

  it("yields to a provider's verdict when externalName proves a mapper produced it", () => {
    for (const code of POLICY_REFUSAL_CODES) {
      const err = new VexError(code, "refused");
      err.externalName = "4001";
      expect(summarizeProtocolError(err).category).toBe("provider_error");
    }
  });

  it("keeps attribution independent of retryability", () => {
    const err = new VexError(ErrorCodes.KYBER_PRICE_FLOOR_VIOLATED, "refused before signing");
    err.retryable = true;
    const summary = summarizeProtocolError(err);
    expect(summary.category).toBe("policy_refusal");
    expect(summary.retryable).toBe(true);
  });

  it("outranks the prose heuristics — our own code beats a keyword in the text", () => {
    // The guard's message can legitimately contain words the text scan hunts
    // for; a code WE attached is direct evidence, the scan is a guess about
    // prose a provider may have written.
    const err = new VexError(
      ErrorCodes.KYBER_UNSAFE_BUILD,
      "Router target is not the approved network address",
    );
    expect(summarizeProtocolError(err).category).toBe("policy_refusal");
  });

  it("leaves every other category exactly where it was", () => {
    expect(summarizeProtocolError(new Error("request timed out")).category).toBe("timeout");
    expect(summarizeProtocolError(new Error("ECONNREFUSED")).category).toBe("network");
    expect(summarizeProtocolError(new Error("rate limit exceeded")).category).toBe("rate_limit");
    expect(summarizeProtocolError(new Error("429 too many requests")).category).toBe("rate_limit");
    expect(summarizeProtocolError(new Error("unauthorized")).category).toBe("auth");
    expect(summarizeProtocolError(new Error("403 forbidden")).category).toBe("auth");
    expect(summarizeProtocolError(new Error("boom")).category).toBe("provider_error");
    expect(summarizeProtocolError("not an error").category).toBe("unknown");
    expect(summarizeProtocolError(new VexError(ErrorCodes.INVALID_ADDRESS, "bad")).category)
      .toBe("invalid_request");
  });

  it("does not sweep in a code a PROVIDER's mapper authors", () => {
    // KYBER_FEE_EXCEEDS_AMOUNT is produced by `mapAggregatorError` from
    // KyberSwap's own response — their verdict, not ours.
    expect(summarizeProtocolError(new VexError(ErrorCodes.KYBER_FEE_EXCEEDS_AMOUNT, "fee too big")).category)
      .toBe("provider_error");
    // Pendle's 400 body classification re-words THEIR refusal.
    expect(summarizeProtocolError(new VexError(ErrorCodes.PENDLE_VALUATION_TOO_LOW, "too low")).category)
      .toBe("provider_error");
  });
});
