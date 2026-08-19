/**
 * The unsupported-filter explanation, asserted where it ACTUALLY fires.
 *
 * This suite exists because of a defect in the first cut of this namespace: the
 * handler carried a loop that rejected `status`, `graduated`, `minHolders`,
 * `minLiquidityUsd` and `chainIds` by name, with a good explanation each, and
 * the handler unit tests happily proved it worked - by calling the handler
 * directly. In PRODUCTION nothing reaches the handler with those keys.
 * `validateProtocolParams` (runtime/params.ts) rejects EVERY undeclared key
 * before a handler is entered, so the explanation the agent would have seen was
 * the generic "Unknown parameter ... Allowed parameters: ..." and the careful
 * wording was unreachable code.
 *
 * The fix moved the explanations to the manifest's `rejectedParams`, which is
 * the map that boundary reads. These cases therefore go through
 * `executeProtocolTool` - the real dispatcher, real manifests, real gate - so a
 * regression that moves the text somewhere unreachable again fails here.
 */

import { describe, it, expect } from "vitest";

import { executeProtocolTool } from "@vex-agent/tools/protocols/runtime.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import { POOLS_UNSUPPORTED_PARAMS } from "@vex-agent/tools/protocols/pools/manifests/tokens-params.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

/** Approved, wallet-neutral: every case here asserts the PARAM gate. */
const CONTEXT: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

/**
 * Each case sends ONE unsupported key with a valid value. The call must fail at
 * the boundary, so no network is reached and nothing needs stubbing.
 */
async function callWithUnsupported(key: string, value: unknown) {
  return executeProtocolTool({ toolId: "pools.tokens", params: { [key]: value } }, CONTEXT);
}

describe("the strict boundary is what actually rejects an unsupported filter", () => {
  it.each([
    ["minHolders", 10],
    ["minLiquidityUsd", 1000],
    ["chainIds", "robinhood"],
    ["status", "curve"],
    ["graduated", true],
  ])("rejects %s before the handler runs, naming the key", async (key, value) => {
    const result = await callWithUnsupported(key, value);
    expect(result.success).toBe(false);
    expect(result.output).toContain(`"${key}"`);
  });

  it("carries the pools.fun REASON, not just 'unknown parameter'", async () => {
    const result = await callWithUnsupported("status", "curve");
    // The fact that stops the agent reaching for `graduated` next.
    expect(result.output).toContain("NO bonding curve");
    expect(result.output).toContain("maxAgeHours");
  });

  it("still lists the parameters that DO work", async () => {
    const result = await callWithUnsupported("minHolders", 10);
    expect(result.output).toContain("Allowed parameters:");
    expect(result.output).toContain("maxAgeHours");
  });

  it("points a liquidity question at the venue that can answer it", async () => {
    const result = await callWithUnsupported("minLiquidityUsd", 1000);
    expect(result.output).toContain("dexscreener");
  });
});

describe("a model-supplied key cannot reach through the rejection table's prototype", () => {
  /**
   * The boundary looks the unknown key up in `manifest.rejectedParams`, and the
   * key comes from the model. A bare index resolves `constructor` up the
   * prototype chain, so the rejection message became
   * "Unknown parameter "constructor". function Object() { [native code] } ..." -
   * reproduced through this same path before the `Object.hasOwn` guard landed.
   * Object internals are not something a tool error is allowed to narrate.
   */
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
    "answers %s as an ordinary unknown parameter, with no prototype text",
    async (key) => {
      const result = await callWithUnsupported(key, "x");

      expect(result.success).toBe(false);
      expect(result.output).toContain(`Unknown parameter "${key}"`);
      expect(result.output).not.toContain("native code");
      expect(result.output).not.toContain("function Object");
      expect(result.output).not.toContain("[object ");
      // The useful half still arrives.
      expect(result.output).toContain("Allowed parameters:");
    },
  );

  it("still explains a REAL rejected key, so the guard did not disable the feature", async () => {
    const result = await callWithUnsupported("status", "curve");
    expect(result.output).toContain("NO bonding curve");
  });
});

describe("the explanations live somewhere the boundary can read them", () => {
  it("pools.tokens and pools.search both declare rejectedParams", () => {
    for (const toolId of ["pools.tokens", "pools.search"]) {
      const manifest = getProtocolManifest(toolId);
      expect(manifest?.rejectedParams, `${toolId} must declare rejectedParams`).toBeDefined();
    }
  });

  // The declared-param overlap and the string-value/own-key shape are asserted
  // FLEET-WIDE in `../manifest-lint.test.ts`, over every manifest that declares
  // a `rejectedParams` table, rather than only over this one.

  it("every rejection reason is a sentence, not a label", () => {
    for (const [key, reason] of Object.entries(POOLS_UNSUPPORTED_PARAMS)) {
      expect(reason.length, `${key} needs a real explanation`).toBeGreaterThan(30);
    }
  });
});
