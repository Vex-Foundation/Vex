/**
 * The route and the deposit method are not parameters of `khalani__bridge_execute`.
 *
 * `routeId` pins one route out of the quote; `depositMethod` picks the on-chain
 * deposit path. Both were DECLARED params, and both were unreachable in
 * practice: the bridge QUOTE has no counterpart for either, so the prequote
 * gate blocked every call that set one as `unbindable_param`
 * (`protocols/prequote/identity/bridge.ts`) before approval, and the
 * `BridgeExecute` alias refused them at its own boundary. A parameter that
 * cannot succeed on any path is dead capability the schema still advertises -
 * and the namespaced tool and its alias were saying opposite things about it.
 *
 * So they are declared as REJECTED instead, answered by name with where the two
 * values actually come from, and the handler stopped reading them. This suite
 * pins the boundary half (the same shape as
 * `protocols/bridge-recipient-derived.test.ts`); the behaviour half - a call
 * with neither key still quotes without a route filter, takes the best route
 * and lets that route dictate its deposit method - is pinned in
 * `khalani-handlers/staged-execute-safety.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { KHALANI_TOOLS } from "@vex-agent/tools/protocols/khalani/manifest.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";

const EXECUTE: ProtocolToolManifest = (() => {
  const found = KHALANI_TOOLS.find((m) => m.toolId === "khalani.bridge");
  if (!found) throw new Error("no manifest for khalani.bridge");
  return found;
})();

/** Params the execute accepts, on a pair the manifest's own example uses. */
const BASE_PARAMS = {
  fromChain: "ethereum",
  fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  toChain: "base",
  toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amountRaw: "100000000",
};

describe("khalani__bridge_execute - the route and the deposit method come from the quote", () => {
  it("a clean call passes the untrusted boundary (no false refusal)", () => {
    expect(validateProtocolParams(EXECUTE, { ...BASE_PARAMS })).toEqual({ ok: true });
  });

  it.each(["routeId", "depositMethod"])("declares no `%s` param", (key) => {
    expect(EXECUTE.params.map((p) => p.key)).not.toContain(key);
  });

  it.each(["routeId", "depositMethod"])(
    "answers `%s` from `rejectedParams` with where the value really comes from",
    (key) => {
      const reason = EXECUTE.rejectedParams?.[key];
      expect(reason).toBeDefined();
      expect(reason).toContain("come from the quote");
      // Both keys are answered with the SAME sentence: they are one decision -
      // the quote picks the route, the route picks its deposit method - and two
      // wordings would invite the agent to retry the other key.
      expect(reason).toBe(EXECUTE.rejectedParams?.routeId);
    },
  );

  it.each(["routeId", "depositMethod"])("REFUSES a supplied `%s` BY NAME, before any handler runs", (key) => {
    const outcome = validateProtocolParams(EXECUTE, { ...BASE_PARAMS, [key]: "PERMIT2" });

    expect(outcome.ok).toBe(false);
    const reason = outcome.ok ? "" : outcome.reason;
    expect(reason).toContain(`"${key}"`);
    expect(reason).toContain("khalani__bridge_execute");
    expect(reason).toContain("come from the quote");
  });

  it("says the same thing in the description the agent reads before calling", () => {
    // The description's precondition list is what an agent plans from; leaving
    // the two keys out of it would advertise by omission the capability the
    // schema just removed.
    expect(EXECUTE.description).toContain("`routeId` and `depositMethod` are NOT parameters");
    expect(EXECUTE.description).toContain("deposit method come from the quote");
  });

  it("still declares `dryRun`, the one execute-only knob the quote does not need to bind", () => {
    expect(EXECUTE.params.map((p) => p.key)).toContain("dryRun");
  });
});
