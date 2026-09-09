import { afterEach, describe, expect, it, vi } from "vitest";
import * as inventoryModule from "@vex-agent/mcp/inventory/index.js";
import { getAdvertisedProtocolNavigation } from "@vex-agent/tools/protocols/descriptions.js";
import { STUDIO_NAMESPACE_FEES } from "@vex-agent/studio/instructions/protocol-blocks.js";
import { renderStudioProtocolMap, STUDIO_PROTOCOL_MAP_MAX_BYTES } from "@vex-agent/studio/instructions/protocol-map.js";
import { renderStudioManagedBody, renderStudioManagedBlock, inspectStudioManagedBlock, mergeStudioManagedBlock } from "@vex-agent/studio/installer/render/index.js";
import { STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT } from "./render-fixtures.js";

afterEach(() => vi.restoreAllMocks());

describe("inline protocol map", () => {
  it("gives every live namespace its capability, coverage, fee, key status and public prefix", () => {
    const map = renderStudioProtocolMap(STUDIO_TEST_ENVIRONMENT);
    const rows = map.split("\n").filter((line) => line.startsWith("- "));
    const navigation = getAdvertisedProtocolNavigation();
    expect(rows).toHaveLength(navigation.length);
    for (const { namespace } of navigation) {
      const row = rows.find((line) => line.startsWith(`- ${namespace}:`));
      expect(row).toContain(`fee ${STUDIO_NAMESPACE_FEES[namespace]?.map}; key `);
      expect(row).toContain(`\`${namespace}__\``);
    }
    expect(map).toContain("morpho: variable-rate lending/Morpho vaults; ethereum");
    expect(map).toContain("10 bps perps; 25 bps spot");
    expect(map).toContain("proven sell proceeds");
    expect(map).toContain("JUPITER_API_KEY missing");
    expect(Buffer.byteLength(map, "utf8")).toBeLessThanOrEqual(STUDIO_PROTOCOL_MAP_MAX_BYTES);
    const body = renderStudioManagedBody(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT);
    expect(body).toContain(map);
    expect(body.indexOf(map)).toBeLessThan(body.indexOf("the map above"));
  });

  it("tracks configured keys through render, inspection and merge without leaking values", () => {
    const configured = { configuredKeys: ["JUPITER_API_KEY"], missingKeys: [] };
    const before = renderStudioManagedBlock(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT);
    const after = renderStudioManagedBlock(STUDIO_TEST_BRIEF, configured);
    expect(after).toContain("JUPITER_API_KEY configured");
    expect(after).not.toBe(before);
    expect(inspectStudioManagedBlock(before, STUDIO_TEST_BRIEF, configured))
      .toEqual({ kind: "intact", upToDate: false });
    expect(mergeStudioManagedBlock(before, STUDIO_TEST_BRIEF, { overwriteDrift: false, environment: configured }))
      .toEqual({ status: "rendered", text: after });
  });

  it("refuses map overflow by its UTF-8 byte bound, never returning a partial map", () => {
    const inventory = inventoryModule.buildStudioInventory();
    const oversized = inventory.map((tool) => tool.namespace === "solana"
      ? { ...tool, requiresEnv: "界".repeat(700) } : tool);
    vi.spyOn(inventoryModule, "buildStudioInventory").mockReturnValue(oversized);
    expect(() => renderStudioProtocolMap(STUDIO_TEST_ENVIRONMENT)).toThrow("STUDIO_PROTOCOL_MAP_MAX_BYTES");
    expect(() => renderStudioManagedBody(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT)).toThrow("STUDIO_PROTOCOL_MAP_MAX_BYTES");
  });

  it("refuses total body overflow by name rather than cutting project text", () => {
    expect(() => renderStudioManagedBody({ ...STUDIO_TEST_BRIEF, projectName: "界".repeat(10_000) }, STUDIO_TEST_ENVIRONMENT))
      .toThrow("STUDIO_MANAGED_BLOCK_MAX_BYTES");
  });
});
