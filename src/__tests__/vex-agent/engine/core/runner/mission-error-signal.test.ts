/**
 * `readMissionErrorSignal` — own-property + shape-validation coverage.
 *
 * Two properties this reader must guarantee (BLOCKER 1, fix-wave):
 *   - own-properties ONLY — a value inherited from the prototype chain
 *     (e.g. `Error.prototype.name`) must never be misread as an
 *     attacker/provider-attached signal.
 *   - `causeCode` is shape-validated (errno-shaped:
 *     `/^[A-Z][A-Z0-9_]{2,59}$/`) because it is persisted into mission
 *     evidence / bug-report context — arbitrary prose must never reach a
 *     persisted record under this field.
 */

import { describe, it, expect } from "vitest";
import { readMissionErrorSignal } from "../../../../../vex-agent/engine/core/runner/mission-error-signal.js";

describe("readMissionErrorSignal", () => {
  it("reads own-property status/code/causeCode/retryable/name", () => {
    const e = new Error("boom");
    Object.assign(e, {
      status: 503,
      code: "PROVIDER_5XX",
      causeCode: "ECONNRESET",
      retryable: true,
      name: "CustomError",
    });

    const signal = readMissionErrorSignal(e);

    expect(signal).toEqual({
      status: 503,
      code: "PROVIDER_5XX",
      causeCode: "ECONNRESET",
      retryable: true,
      name: "CustomError",
      // Widened for the error channel: the provider taxonomy now travels
      // beside the transport shape. All null here — this fixture attaches
      // none of the three.
      errorType: null,
      errorClass: null,
      retryAfterSeconds: null,
    });
  });

  it("returns null for a causeCode/status inherited from the prototype (own-only)", () => {
    // Build an error whose "causeCode" and "status" exist only on a
    // prototype in its chain — never assigned as an own-property on the
    // instance itself. Ordinary indexing (`err.causeCode`) would still
    // resolve these; the own-property guard must not.
    class PoisonedBase extends Error {}
    (PoisonedBase.prototype as unknown as Record<string, unknown>).causeCode = "ECONNRESET";
    (PoisonedBase.prototype as unknown as Record<string, unknown>).status = 503;

    const e = new PoisonedBase("boom");

    // Sanity check: ordinary indexing WOULD see these (proves the fixture is
    // actually exercising the own-vs-inherited distinction).
    expect((e as unknown as Record<string, unknown>).causeCode).toBe("ECONNRESET");
    expect((e as unknown as Record<string, unknown>).status).toBe(503);

    const signal = readMissionErrorSignal(e);

    expect(signal.causeCode).toBeNull();
    expect(signal.status).toBeNull();
  });

  it("returns null for a causeCode that is prose / oversized / lowercase / contains spaces", () => {
    const cases = [
      "connection reset by peer", // prose + spaces + lowercase
      "econnreset", // lowercase
      "ECONN RESET", // contains a space
      "E", // too short (< 3 chars total)
      "1CONNRESET", // does not start with [A-Z]
      "E" + "C".repeat(60), // oversized (> 60 chars)
    ];

    for (const causeCode of cases) {
      const e = new Error("boom");
      Object.assign(e, { causeCode });
      expect(readMissionErrorSignal(e).causeCode).toBeNull();
    }
  });

  it("returns a valid errno-shaped causeCode (e.g. ECONNRESET)", () => {
    const e = new Error("boom");
    Object.assign(e, { causeCode: "ECONNRESET" });
    expect(readMissionErrorSignal(e).causeCode).toBe("ECONNRESET");
  });

  it("non-Error input returns the all-null signal", () => {
    expect(readMissionErrorSignal("not an error")).toEqual({
      status: null,
      code: null,
      causeCode: null,
      retryable: null,
      name: null,
      errorType: null,
      errorClass: null,
      retryAfterSeconds: null,
    });
  });
});
