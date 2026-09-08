import { requireValue } from "../helpers/require-value.js";
import { describe, expect, it } from "vitest";

import {
  LIGHTER_ENDPOINT_PATHS,
  LIGHTER_ENVIRONMENTS,
  type LighterEnvironment,
} from "@tools/lighter/constants.js";
import { executeProtocolTool } from "@vex-agent/tools/protocols/runtime.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const RUN_LIVE = process.env.VEX_LIGHTER_API_KEYS_LIVE === "1";
const describeLive = RUN_LIVE ? describe : describe.skip;

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

async function runTool(
  toolId: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await executeProtocolTool({ toolId, params }, READ_CTX);
  expect(result.success, result.output).toBe(true);
  expect(result.actionKind).toBe("read");
  return JSON.parse(result.output) as Record<string, unknown>;
}

function expectApiKeysProvenance(
  data: Record<string, unknown>,
  environment: LighterEnvironment,
): void {
  expect(data.source).toBe("live_lighter_public_api");
  const provenance = data.provenance as Record<string, unknown>;
  expect(provenance).toEqual(expect.objectContaining({
    source: "live_lighter_public_api",
    provider: "lighter",
    dataPlane: "provider_public_rest",
    toolId: "lighter.apiKeys.inspect",
    environment,
    endpointPaths: [LIGHTER_ENDPOINT_PATHS.apiKeys],
    authenticated: false,
    cacheStatus: "fresh_or_short_cache",
    independentOnchainVerification: false,
  }));
}

describeLive("Lighter live public API-key metadata through protocol runtime", () => {
  for (const environment of LIGHTER_ENVIRONMENTS) {
    it(`reads ${environment} public API-key nonce metadata`, { timeout: 60_000 }, async () => {
      const data = await runTool("lighter.apiKeys.inspect", {
        environment,
        accountIndex: 1,
        apiKeyIndex: 255,
        limit: 10,
      });

      expectApiKeysProvenance(data, environment);
      expect(data.environment).toBe(environment);
      expect(data.accountIndex).toBe(1);
      expect(data.apiKeyIndex).toBe(255);
      expect(typeof data.count).toBe("number");
      expect(Number(data.count)).toBeGreaterThan(0);
      expect(Array.isArray(data.apiKeys)).toBe(true);
      const first = requireValue((data.apiKeys as Record<string, unknown>[])[0]);
      expect(first.accountIndex).toBe(1);
      expect(typeof first.apiKeyIndex).toBe("number");
      expect(typeof first.publicKey).toBe("string");
      expect(typeof first.noncePrecision).toBe("string");
    });
  }
});
