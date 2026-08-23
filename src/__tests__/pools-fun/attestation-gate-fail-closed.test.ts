/**
 * THE GATE THAT AUTHORIZES A SIGNATURE, proven fail-closed.
 *
 * `poolsFunAttestationEnabled` is the only flag in `config/store.ts` that
 * decides whether the launching wallet signs anything for this lane. The config
 * file is untrusted input - hand-edited, migrated from an older shape, or
 * written by a future UI - and `loadConfig` spreads the parsed file straight
 * over the defaults, so WITHOUT a strict parse a stored string `"true"` would
 * arrive at every call site as a truthy value and enable signing.
 *
 * What this pins, for every non-boolean shape:
 *
 *   - ZERO SIGNATURES: `signMessage` is never called;
 *   - ZERO PERSISTENCE: no attestation column is written;
 *   - ZERO HTTP: no request is made;
 *   - ZERO LOG NOISE: a lane that is off is indistinguishable from one that
 *     does not exist.
 *
 * `"true"` is the case that matters. A `"false"` string failing closed is
 * merely correct; a `"true"` string failing closed is the whole point.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `vex-attest-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const testConfigFile = join(testDir, "config.json");

vi.mock("@config/paths.js", () => ({
  CONFIG_DIR: testDir,
  CONFIG_FILE: testConfigFile,
  KEYSTORE_FILE: join(testDir, "keystore.json"),
}));

const { loadConfig, getDefaultConfig, parsePoolsFunAttestationEnabled } = await import(
  "@config/store.js"
);

/** Every non-boolean shape a config file can realistically carry. */
const NON_BOOLEAN_TRUTHY: ReadonlyArray<[string, unknown]> = [
  ["the string \"true\"", "true"],
  ["the string \"TRUE\"", "TRUE"],
  ["the string \"1\"", "1"],
  ["the string \"yes\"", "yes"],
  ["the number 1", 1],
  ["a non-empty object", { enabled: true }],
  ["a non-empty array", ["true"]],
];

function writeStoredFlag(value: unknown): void {
  if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
  writeFileSync(
    testConfigFile,
    JSON.stringify({ ...getDefaultConfig(), poolsFunAttestationEnabled: value }),
  );
}

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});
afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  vi.restoreAllMocks();
});

describe("parsePoolsFunAttestationEnabled - strict boolean, nothing else", () => {
  it("accepts only the boolean `true`", () => {
    expect(parsePoolsFunAttestationEnabled(true)).toBe(true);
  });

  it.each(NON_BOOLEAN_TRUTHY)("refuses %s", (_label, value) => {
    expect(parsePoolsFunAttestationEnabled(value)).toBe(false);
  });

  it.each([[false], [null], [undefined], [0], [""]])("refuses the falsy shape %s", (value) => {
    expect(parsePoolsFunAttestationEnabled(value)).toBe(false);
  });
});

describe("loadConfig - the stored value cannot enable the lane by being truthy", () => {
  it("ships OFF by default", () => {
    expect(getDefaultConfig().poolsFunAttestationEnabled).toBe(false);
  });

  it("ships the attest URL DARK by default", () => {
    expect(getDefaultConfig().services.poolsFunAttestApiUrl).toBe("");
  });

  it.each(NON_BOOLEAN_TRUTHY)("leaves the lane off when the file stores %s", (_label, value) => {
    writeStoredFlag(value);
    expect(loadConfig().poolsFunAttestationEnabled).toBe(false);
  });

  it("enables the lane only for a real boolean `true`", () => {
    writeStoredFlag(true);
    expect(loadConfig().poolsFunAttestationEnabled).toBe(true);
  });
});

describe("the disabled leg does nothing at all - no signature, no write, no HTTP, no logs", () => {
  it.each(NON_BOOLEAN_TRUTHY)(
    "a stored %s produces zero signatures, zero claims and zero requests",
    async (_label, value) => {
      writeStoredFlag(value);

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const launchedTokens = await import("@vex-agent/db/repos/launched-tokens.js");
      const stamp = vi
        .spyOn(launchedTokens, "stampPoolsAttestSignature")
        .mockImplementation(async () => true);
      const claim = vi
        .spyOn(launchedTokens, "claimPoolsAttributionCandidates")
        .mockImplementation(async () => []);

      const logger = (await import("@utils/logger.js")).default;
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
      const info = vi.spyOn(logger, "info").mockImplementation(() => logger);

      const { signAndStorePoolsAttestation, postPoolsLaunchAttribution } = await import(
        "@vex-agent/tools/protocols/pools/handlers/launch/execute/attribute.js"
      );

      // The leg's own narrow signer contract, satisfied with no cast at all.
      // The test's whole point is proving this is NOT reached.
      const signMessage = vi.fn(async (): Promise<string> => {
        throw new Error("a disabled lane must never sign");
      });
      const walletClient = { signMessage };

      const signature = await signAndStorePoolsAttestation(
        walletClient,
        "0x01e685d39e6bf52ad0c421a4be1e092ce684e6bb",
      );

      // Even handed a signature from somewhere else, the POST leg stays shut:
      // the gate is re-checked here rather than trusted from the caller.
      await postPoolsLaunchAttribution(
        "0x01e685d39e6bf52ad0c421a4be1e092ce684e6bb",
        `0x${"ab".repeat(65)}`,
        `0x${"cd".repeat(32)}`,
      );

      expect(signature).toBeNull();
      expect(signMessage).not.toHaveBeenCalled();
      expect(stamp).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    },
  );
});

describe("the SWEEP is gated by the same strict boolean - a configured URL alone never turns delivery on", () => {
  function writeFlagAndUrl(value: unknown): void {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
    const base = getDefaultConfig();
    writeFileSync(
      testConfigFile,
      JSON.stringify({
        ...base,
        poolsFunAttestationEnabled: value,
        services: { ...base.services, poolsFunAttestApiUrl: "https://attest.pools.test" },
      }),
    );
  }

  it.each(NON_BOOLEAN_TRUTHY)(
    "claims ZERO rows with a live URL while the file stores %s",
    async (_label, value) => {
      writeFlagAndUrl(value);

      const launchedTokens = await import("@vex-agent/db/repos/launched-tokens.js");
      const claim = vi
        .spyOn(launchedTokens, "claimPoolsAttributionCandidates")
        .mockImplementation(async () => []);

      const { attributePoolsLaunches } = await import("@vex-agent/sync/pools-attribution.js");
      const { buildProductionPoolsAttributionDeps } = await import(
        "@vex-agent/sync/pools-attribution-production-deps.js"
      );

      const result = await attributePoolsLaunches(buildProductionPoolsAttributionDeps());
      expect(result.skipped).toBe(true);
      expect(result.checked).toBe(0);
      expect(claim).not.toHaveBeenCalled();
    },
  );

  it("claims once the flag is a real boolean `true` and the URL resolves", async () => {
    writeFlagAndUrl(true);

    const launchedTokens = await import("@vex-agent/db/repos/launched-tokens.js");
    const claim = vi
      .spyOn(launchedTokens, "claimPoolsAttributionCandidates")
      .mockImplementation(async () => []);
    vi.spyOn(launchedTokens, "countPoolsUnsignedAttributionGap").mockImplementation(async () => 0);

    const { attributePoolsLaunches } = await import("@vex-agent/sync/pools-attribution.js");
    const { buildProductionPoolsAttributionDeps } = await import(
      "@vex-agent/sync/pools-attribution-production-deps.js"
    );

    const result = await attributePoolsLaunches(buildProductionPoolsAttributionDeps());
    expect(result.skipped).toBe(false);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});
