/**
 * Relay request-id correlation contract (Wave-2 W2, R11) — matrix.
 *
 * The handler runs this BEFORE intent creation + signing: the top-level v2
 * requestId must exist and every step/check id that appears must agree with it.
 * A missing top-level id or ANY divergent id is a typed failure the handler
 * aborts pre-sign on. This is a consistency check (ids agree) — divergence on
 * ANY host is flagged (fail-closed), independent of which endpoint is polled.
 */

import { describe, it, expect } from "vitest";

import { assertRelayQuoteCorrelation } from "@tools/relay/correlation.js";
import type { RelayQuoteResponse } from "@tools/relay/types.js";

const BASE = "https://api.relay.link";
const TOP = "0xTOP";

function quote(partial: {
  requestId?: string;
  steps?: Array<{ id: string; requestId?: string; endpoints?: Array<string | undefined> }>;
}): RelayQuoteResponse {
  const steps = (partial.steps ?? [{ id: "deposit" }]).map((s) => ({
    id: s.id,
    kind: "transaction",
    ...(s.requestId !== undefined ? { requestId: s.requestId } : {}),
    items: (s.endpoints ?? [undefined]).map((endpoint) => ({
      data: { to: "0x2222222222222222222222222222222222222222", chainId: 8453 },
      ...(endpoint !== undefined ? { check: { endpoint, method: "GET" } } : {}),
    })),
  }));
  return { steps, ...(partial.requestId !== undefined ? { requestId: partial.requestId } : {}) } as unknown as RelayQuoteResponse;
}

describe("assertRelayQuoteCorrelation — passes when all ids agree", () => {
  it("top-level + step + check-endpoint ids all equal → ok(requestId)", () => {
    const result = assertRelayQuoteCorrelation(
      quote({ requestId: TOP, steps: [{ id: "deposit", requestId: TOP, endpoints: [`${BASE}/intents/status/v3?requestId=${TOP}`] }] }),
      BASE,
    );
    expect(result).toEqual({ ok: true, requestId: TOP });
  });

  it("relative check endpoint resolves against the base and agrees → ok", () => {
    const result = assertRelayQuoteCorrelation(
      quote({ requestId: TOP, steps: [{ id: "deposit", endpoints: [`/intents/status/v3?requestId=${TOP}`] }] }),
      BASE,
    );
    expect(result).toMatchObject({ ok: true, requestId: TOP });
  });

  it("step omits requestId + check endpoint agrees → ok", () => {
    const result = assertRelayQuoteCorrelation(
      quote({ requestId: TOP, steps: [{ id: "deposit", endpoints: [`${BASE}/intents/status/v3?requestId=${TOP}`] }] }),
      BASE,
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("a WRONG-host check endpoint carrying the SAME id still agrees (consistency holds)", () => {
    const result = assertRelayQuoteCorrelation(
      quote({ requestId: TOP, steps: [{ id: "deposit", endpoints: [`https://evil.example.com/x?requestId=${TOP}`] }] }),
      BASE,
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("un-parseable / id-less check endpoints do not COUNT as mismatches (only a missing corroboration)", () => {
    // A check endpoint carrying the id still corroborates; the un-parseable +
    // id-less endpoints alongside it are simply not evidence of divergence.
    const result = assertRelayQuoteCorrelation(
      quote({ requestId: TOP, steps: [{ id: "deposit", endpoints: ["::::not a url::::", `${BASE}/intents/status/v3`, `${BASE}/intents/status/v3?requestId=${TOP}`] }] }),
      BASE,
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("a step.requestId (no check endpoint) corroborates the top-level id → ok", () => {
    const result = assertRelayQuoteCorrelation(
      quote({ requestId: TOP, steps: [{ id: "deposit", requestId: TOP }] }),
      BASE,
    );
    expect(result).toEqual({ ok: true, requestId: TOP });
  });
});

describe("assertRelayQuoteCorrelation — live v2 shape (no top-level id)", () => {
  it("LIVE-VERIFIED shape: no top-level id, step.requestId + check endpoint agree → ok(canonical)", () => {
    // Coordinator live probe 2026-07-23: real /quote/v2 responses carry NO
    // top-level requestId; the id lives on the step + check.endpoint.
    const result = assertRelayQuoteCorrelation(
      quote({
        steps: [{
          id: "deposit",
          requestId: TOP,
          endpoints: [`/intents/status/v3?requestId=${TOP}`],
        }],
      }),
      BASE,
    );
    expect(result).toEqual({ ok: true, requestId: TOP });
  });

  it("no top-level id, step and check endpoint DIVERGE → mismatch abort", () => {
    expect(
      assertRelayQuoteCorrelation(
        quote({
          steps: [{
            id: "deposit",
            requestId: TOP,
            endpoints: ["/intents/status/v3?requestId=0xOTHER"],
          }],
        }),
        BASE,
      ),
    ).toMatchObject({ ok: false, reason: "check_endpoint_request_id_mismatch" });
  });
});

describe("assertRelayQuoteCorrelation — fails closed", () => {
  it("no top-level requestId → missing_request_id (stepId null)", () => {
    expect(assertRelayQuoteCorrelation(quote({ steps: [{ id: "deposit" }] }), BASE)).toEqual({
      ok: false,
      reason: "missing_request_id",
      stepId: null,
      detail: expect.any(String),
    });
  });

  it("whitespace-only top-level requestId → missing_request_id", () => {
    expect(assertRelayQuoteCorrelation(quote({ requestId: "   ", steps: [{ id: "deposit" }] }), BASE)).toMatchObject({
      ok: false,
      reason: "missing_request_id",
    });
  });

  it("step requestId diverges from the top-level → step_request_id_mismatch", () => {
    expect(
      assertRelayQuoteCorrelation(quote({ requestId: TOP, steps: [{ id: "deposit", requestId: "0xOTHER" }] }), BASE),
    ).toMatchObject({ ok: false, reason: "step_request_id_mismatch", stepId: "deposit" });
  });

  it("check-endpoint requestId diverges from the top-level → check_endpoint_request_id_mismatch", () => {
    expect(
      assertRelayQuoteCorrelation(
        quote({ requestId: TOP, steps: [{ id: "deposit", endpoints: [`${BASE}/intents/status/v3?requestId=0xOTHER`] }] }),
        BASE,
      ),
    ).toMatchObject({ ok: false, reason: "check_endpoint_request_id_mismatch", stepId: "deposit" });
  });

  it("a divergent id on ANY host is flagged (fail-closed, host-independent)", () => {
    expect(
      assertRelayQuoteCorrelation(
        quote({ requestId: TOP, steps: [{ id: "deposit", endpoints: [`https://evil.example.com/x?requestId=0xOTHER`] }] }),
        BASE,
      ),
    ).toMatchObject({ ok: false, reason: "check_endpoint_request_id_mismatch" });
  });

  it("top-level id corroborated by NOTHING (no step id, no check id) → request_id_uncorroborated (R11 absence-aborts)", () => {
    // The former lenient contract accepted this; the intent id is asserted
    // top-level but the quote's own tracking surface never confirms it.
    expect(
      assertRelayQuoteCorrelation(
        quote({ requestId: TOP, steps: [{ id: "deposit", endpoints: ["::::not a url::::", `${BASE}/intents/status/v3`] }] }),
        BASE,
      ),
    ).toMatchObject({ ok: false, reason: "request_id_uncorroborated", stepId: null });
  });

  it("a bare quote (top-level id only, no step/check ids anywhere) → request_id_uncorroborated", () => {
    expect(assertRelayQuoteCorrelation(quote({ requestId: TOP, steps: [{ id: "deposit" }] }), BASE)).toMatchObject({
      ok: false,
      reason: "request_id_uncorroborated",
    });
  });

  it("reports the FIRST offending step across multiple steps", () => {
    const result = assertRelayQuoteCorrelation(
      quote({
        requestId: TOP,
        steps: [
          { id: "approve", requestId: TOP },
          { id: "deposit", requestId: "0xOTHER" },
        ],
      }),
      BASE,
    );
    expect(result).toMatchObject({ ok: false, reason: "step_request_id_mismatch", stepId: "deposit" });
  });
});
