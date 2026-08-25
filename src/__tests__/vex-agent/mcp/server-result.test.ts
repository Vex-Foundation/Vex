/**
 * The `StudioCallOutcome` -> `CallToolResult` projection, exhaustively.
 *
 * Every outcome kind, and for `completed` both values of `result.success`,
 * including the typed `configuration_unavailable` refusal. The table is
 * exhaustive by construction: a KINDS constant is compared against the union's
 * own members through a compile-time exhaustiveness check, so adding a kind to
 * `outcome.ts` without adding a row here fails the build rather than shipping
 * an unprojected outcome.
 *
 * What each assertion is FOR:
 *  - `isError` is the machine channel a client branches on. Wrong here means a
 *    successful call reported as a failure, or worse, a declined money-path
 *    call reported as a success.
 *  - the whole `output` reaching the wire is the repo's no-silent-cutting rule
 *    applied to the one boundary where a projection could quietly drop it.
 *  - `indeterminate` leading with DO-NOT-RETRY is the only no-retry channel
 *    MCP gives us, and a reworded first clause would silently remove it.
 */

import { describe, expect, it } from "vitest";

import type { StudioCallOutcome } from "../../../vex-agent/mcp/outcome.js";
import {
  STUDIO_INDETERMINATE_SENTENCE,
  studioOutcomeToCallToolResult,
} from "../../../vex-agent/mcp/server-result.js";
import { configurationUnavailableResult } from "../../../vex-agent/mcp/availability.js";

const APPROVAL_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** Every kind, named once. The check below proves the list is complete. */
const KINDS = [
  "completed",
  "declined",
  "expired",
  "refused",
  "dispatch_failed",
  "indeterminate",
  "not_queued",
] as const;

type ListedKind = (typeof KINDS)[number];
/** Compile-time exhaustiveness: both directions, so neither list can drift. */
const _kindsAreExhaustive: StudioCallOutcome["kind"] extends ListedKind
  ? ListedKind extends StudioCallOutcome["kind"]
    ? true
    : never
  : never = true;

function onlyText(result: ReturnType<typeof studioOutcomeToCallToolResult>): string {
  expect(result.content).toHaveLength(1);
  const block = result.content[0];
  expect(block?.type).toBe("text");
  return block?.text ?? "";
}

const CASES: readonly { readonly label: string; readonly outcome: StudioCallOutcome; readonly isError: boolean }[] = [
  {
    label: "completed + success:true",
    outcome: { kind: "completed", result: { success: true, output: "0.42 SOL" } },
    isError: false,
  },
  {
    label: "completed + success:false (handler failure)",
    outcome: {
      kind: "completed",
      result: { success: false, output: "The provider returned 503. Nothing was executed." },
    },
    isError: true,
  },
  {
    label: "completed + success:false (configuration_unavailable)",
    outcome: {
      kind: "completed",
      result: configurationUnavailableResult("SwapQuote", ["JUPITER_API_KEY"]),
    },
    isError: true,
  },
  {
    label: "declined",
    outcome: { kind: "declined", approvalId: APPROVAL_ID, reason: "Wrong wallet." },
    isError: true,
  },
  { label: "expired", outcome: { kind: "expired", approvalId: APPROVAL_ID }, isError: true },
  {
    label: "refused + confirmed",
    outcome: { kind: "refused", approvalId: APPROVAL_ID, reason: "lock", confirmed: true },
    isError: true,
  },
  {
    label: "refused + NOT confirmed",
    outcome: { kind: "refused", approvalId: APPROVAL_ID, reason: "lock", confirmed: false },
    isError: true,
  },
  {
    label: "dispatch_failed",
    outcome: {
      kind: "dispatch_failed",
      approvalId: APPROVAL_ID,
      reason: "The signer was revoked.",
    },
    isError: true,
  },
  {
    label: "indeterminate",
    outcome: { kind: "indeterminate", approvalId: APPROVAL_ID },
    isError: true,
  },
  {
    label: "not_queued",
    outcome: { kind: "not_queued", reason: "Vex is locked. Nothing was executed." },
    isError: true,
  },
];

describe("studioOutcomeToCallToolResult", () => {
  it("covers every outcome kind at least once", () => {
    const covered = new Set(CASES.map((entry) => entry.outcome.kind));
    expect([...covered].sort()).toEqual([...KINDS].sort());
    expect(_kindsAreExhaustive).toBe(true);
  });

  it.each(CASES)("$label sets isError correctly and emits one text block", (entry) => {
    const result = studioOutcomeToCallToolResult(entry.outcome);
    const text = onlyText(result);
    expect(text.length).toBeGreaterThan(0);
    if (entry.isError) {
      expect(result.isError).toBe(true);
    } else {
      // A successful result OMITS the field rather than sending `false`.
      expect("isError" in result).toBe(false);
    }
  });

  it("carries the WHOLE completed output, byte for byte, however long", () => {
    // 512 KiB of output. The projection has no length branch at all; this pins
    // that, because a slice added here would be invisible in a short fixture.
    const output = `${"x".repeat(512 * 1024)}END`;
    const result = studioOutcomeToCallToolResult({
      kind: "completed",
      result: { success: true, output },
    });
    expect(onlyText(result)).toBe(output);
  });

  it("never emits structured output (O5 stays deferred)", () => {
    const result = studioOutcomeToCallToolResult({
      kind: "completed",
      result: {
        success: true,
        output: "done",
        data: { secretish: "internal shape nobody reviewed as a wire format" },
      },
    });
    expect("structuredContent" in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain("internal shape");
  });

  it("leads the indeterminate answer with DO NOT RETRY", () => {
    const text = onlyText(
      studioOutcomeToCallToolResult({ kind: "indeterminate", approvalId: APPROVAL_ID }),
    );
    expect(text.startsWith("DO NOT RETRY")).toBe(true);
    expect(text).toBe(STUDIO_INDETERMINATE_SENTENCE);
    // The approval id is Vex's own correlation, not something the agent acts
    // on, and the sentence must not read as a retry handle.
    expect(text).not.toContain(APPROVAL_ID);
  });

  it("says the refusal is UNRESOLVED when Vex could not record it", () => {
    const confirmed = onlyText(
      studioOutcomeToCallToolResult({
        kind: "refused",
        approvalId: APPROVAL_ID,
        reason: "lock",
        confirmed: true,
      }),
    );
    const unconfirmed = onlyText(
      studioOutcomeToCallToolResult({
        kind: "refused",
        approvalId: APPROVAL_ID,
        reason: "lock",
        confirmed: false,
      }),
    );
    expect(confirmed).not.toBe(unconfirmed);
    expect(unconfirmed).toContain("could NOT confirm");
    expect(unconfirmed).toContain("Do not retry");
  });

  it("passes a not_queued reason through whole, without restating it", () => {
    const reason =
      "Vex is already holding 32 actions waiting for approval, so this one was "
      + "not queued. Nothing was executed.";
    expect(onlyText(studioOutcomeToCallToolResult({ kind: "not_queued", reason }))).toBe(
      reason,
    );
  });

  it("tells declined, expired and dispatch_failed apart in the text itself", () => {
    const declined = onlyText(
      studioOutcomeToCallToolResult({
        kind: "declined",
        approvalId: APPROVAL_ID,
        reason: "Wrong wallet.",
      }),
    );
    const expired = onlyText(
      studioOutcomeToCallToolResult({ kind: "expired", approvalId: APPROVAL_ID }),
    );
    const failed = onlyText(
      studioOutcomeToCallToolResult({
        kind: "dispatch_failed",
        approvalId: APPROVAL_ID,
        reason: "The signer was revoked.",
      }),
    );
    expect(declined).toContain("DECLINED");
    expect(expired).toContain("EXPIRED");
    expect(failed).toContain("NOT retried");
    expect(new Set([declined, expired, failed]).size).toBe(3);
    // Every non-completed answer states the money fact.
    for (const text of [declined, expired, failed]) {
      expect(text).toContain("no funds moved");
    }
  });
});
