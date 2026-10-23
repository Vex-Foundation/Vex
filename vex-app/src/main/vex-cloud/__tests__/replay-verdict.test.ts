/**
 * The REPLAY TABLE (`replayVerdict` in `funding/backend-call.ts`), one row
 * per backend answer: what a refusal of a REPLAY proves about the ORIGINAL
 * request sent with the same idempotency key. `not_created` only for a
 * reason the backend raises after its key lookup found no row, with the
 * status it raises it with; everything raised before the lookup, or that
 * proves nothing, is `inconclusive`. Evidence per row is in the table's doc.
 */

import { describe, expect, it } from "vitest";
import type { VexCloudCallFailure } from "../api-client.js";
import { replayVerdict } from "../funding/backend-call.js";

const rejected = (status: number, reason: string | null): VexCloudCallFailure => ({ kind: "rejected", status, reason, address: null });

describe("withdrawal replay verdict", () => {
  it.each<[string, VexCloudCallFailure]>([
    ["403 account_paused (after the lookup)", rejected(403, "account_paused")],
    ["403 destination_not_linked (after the lookup)", rejected(403, "destination_not_linked")],
    ["503 rate_unavailable (after the lookup)", { kind: "unavailable", status: 503, reason: "rate_unavailable" }],
    ["400 below_minimum (after the lookup)", rejected(400, "below_minimum")],
    ["429 daily_limit_exceeded (after the lookup)", rejected(429, "daily_limit_exceeded")],
    ["409 insufficient_withdrawable (after the lookup)", rejected(409, "insufficient_withdrawable")],
  ])("%s proves the original was not created", (_name, failure) => {
    expect(replayVerdict("withdrawal", failure)).toBe("not_created");
  });

  it.each<[string, VexCloudCallFailure]>([
    ["401 session_invalid (auth, before the lookup)", { kind: "unauthorized", reason: "session_invalid", address: null }],
    ["503 withdrawals_unavailable (route, before the lookup)", { kind: "unavailable", status: 503, reason: "withdrawals_unavailable" }],
    ["400 invalid_idempotency_key (route)", rejected(400, "invalid_idempotency_key")],
    ["400 invalid_field (route)", rejected(400, "invalid_field")],
    ["400 forbidden_field (route)", rejected(400, "forbidden_field")],
    ["400 invalid_body (parse)", rejected(400, "invalid_body")],
    ["404 without a reason (no route)", rejected(404, null)],
    ["413 without a reason (body limit)", rejected(413, null)],
    ["409 idempotency_key_reused (a row EXISTS for the key)", rejected(409, "idempotency_key_reused")],
    ["429 rate_limited (throttle)", { kind: "unavailable", status: 429, reason: "rate_limited" }],
    ["500 without a reason", { kind: "unavailable", status: 500 }],
    ["503 without a reason", { kind: "unavailable", status: 503 }],
    ["a network error or timeout", { kind: "unavailable", status: null }],
    ["an unreadable body", { kind: "invalid_response" }],
    ["a cancel in flight", { kind: "cancelled" }],
    ["an unknown reason", rejected(400, "some_new_reason")],
    ["a known post-lookup reason with the WRONG status", rejected(500, "insufficient_withdrawable")],
    ["a prototype key as the reason", rejected(400, "constructor")],
  ])("%s proves nothing about the original", (_name, failure) => {
    expect(replayVerdict("withdrawal", failure)).toBe("inconclusive");
  });
});

describe("cashback claim replay verdict", () => {
  it.each<[string, VexCloudCallFailure]>([
    ["401 session_invalid", { kind: "unauthorized", reason: "session_invalid", address: null }],
    ["400 invalid_idempotency_key", rejected(400, "invalid_idempotency_key")],
    ["400 invalid_field", rejected(400, "invalid_field")],
    ["400 unsupported_destination", rejected(400, "unsupported_destination")],
    ["404 without a reason", rejected(404, null)],
    ["500 without a reason", { kind: "unavailable", status: 500 }],
    ["a network error or timeout", { kind: "unavailable", status: null }],
    ["an unreadable body", { kind: "invalid_response" }],
    ["a withdrawal-only post-lookup reason", rejected(409, "insufficient_withdrawable")],
  ])("%s proves nothing about the original claim (the ledger refuses nothing after its lookup)", (_name, failure) => {
    expect(replayVerdict("cashback_claim", failure)).toBe("inconclusive");
  });
});
