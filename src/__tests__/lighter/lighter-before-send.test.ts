/**
 * Failures to reach Lighter before an approved action reserved its nonce. On
 * 2026-09-24 an order approved just before the Wi-Fi went off failed after 32
 * seconds with the transport's own text; nothing had been reserved, signed or
 * sent, and the trader could not tell.
 */

import { describe, expect, it } from "vitest";

import { ErrorCodes, VexError } from "../../errors.js";
import { withLighterBeforeSendFailures } from "@vex-agent/tools/protocols/lighter/before-send.js";

function timeout(): VexError {
  const error = new VexError(ErrorCodes.LIGHTER_TIMEOUT, "Request timed out after 10000ms", "Check network connectivity or try again later");
  error.retryable = true;
  return error;
}

async function failure(run: Promise<unknown>): Promise<VexError> {
  const error = await run.then(() => null, (caught: unknown) => caught);
  if (!(error instanceof VexError)) throw new Error("expected a VexError");
  return error;
}

describe("withLighterBeforeSendFailures", () => {
  it("says plainly that nothing was sent when Lighter could not be reached before reserving", async () => {
    const error = await failure(withLighterBeforeSendFailures(async () => { throw timeout(); }));

    expect(error.code).toBe(ErrorCodes.LIGHTER_TIMEOUT);
    expect(error.message).toBe("Vex couldn't reach Lighter before sending, so nothing was signed or sent. Check your connection and try again.");
    expect(error.hint).toContain("Request timed out after 10000ms");
    expect(error.retryable).toBe(true);
  });

  it("leaves a failure after reservation started exactly as it was", async () => {
    const original = timeout();
    const error = await failure(withLighterBeforeSendFailures(async (phase) => {
      phase.reserving = true;
      throw original;
    }));

    expect(error).toBe(original);
  });

  it("leaves refusals that are not about reaching Lighter alone", async () => {
    const refusal = new VexError(ErrorCodes.INSUFFICIENT_BALANCE, "Lighter would cancel this BTC order with no fill.");
    const error = await failure(withLighterBeforeSendFailures(async () => { throw refusal; }));

    expect(error).toBe(refusal);
  });
});
