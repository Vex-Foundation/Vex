import { describe, expect, it } from "vitest";

import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import { BRIDGE_TOKEN_METADATA_RESULT_DESCRIPTION } from "@vex-agent/tools/protocols/bridge-token-identity-contract.js";
import { getToolDef } from "@vex-agent/tools/registry.js";

describe("bridge token metadata descriptions", () => {
  it("states the shared result contract on every quote and dry-run surface", () => {
    for (const toolId of ["khalani.quote.get", "khalani.bridge", "relay.quote.get", "relay.bridge"]) {
      expect(getProtocolManifest(toolId)?.description).toContain(
        BRIDGE_TOKEN_METADATA_RESULT_DESCRIPTION,
      );
    }
    for (const name of ["BridgeQuote", "BridgeQuoteRelay"]) {
      expect(getToolDef(name)?.description).toContain(
        BRIDGE_TOKEN_METADATA_RESULT_DESCRIPTION,
      );
    }
  });
});
