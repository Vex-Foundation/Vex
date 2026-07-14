import { afterEach, describe, expect, it } from "vitest";

import { clearHlPolicyProvider, registerHlPolicyProvider } from "../../../../lib/hyperliquid-policy.js";
import { getProtocolManifest, isProtocolToolAvailable } from "@vex-agent/tools/protocols/catalog.js";

afterEach(() => {
  clearHlPolicyProvider();
});

describe("Hyperliquid policy availability in the catalog", () => {
  it("hides mutations while leaving reads available when no provider exists", () => {
    const open = getProtocolManifest("hyperliquid.perp.open");
    const markets = getProtocolManifest("hyperliquid.perp.markets");
    expect(open && isProtocolToolAvailable(open)).toBe(false);
    expect(markets && isProtocolToolAvailable(markets)).toBe(true);
  });

  it("atomic open is available the moment a policy provider exists (owner decision: no release gate)", () => {
    registerHlPolicyProvider(() => ({ policy: {}, version: "v1", provenance: "preferences" }));
    const open = getProtocolManifest("hyperliquid.perp.open");
    expect(open && isProtocolToolAvailable(open)).toBe(true);
  });
});
