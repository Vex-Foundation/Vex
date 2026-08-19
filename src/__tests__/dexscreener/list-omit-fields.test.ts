/**
 * `omitFields` — subtractive projection, allowed only where it means something.
 *
 * `fields` only ADDS. The persona gate ranked that [high]: the provider's
 * `description` is the dominant cost of every feed payload AND the whole hostile
 * surface, and there was no way to ask for the feed without it. `omitFields`
 * closes that, and closes nothing else.
 *
 * THE ALLOWLIST IS PER FAMILY, AND THE EMPTY ONE IS THE INTERESTING CASE
 *
 * - feed: `description` — mandatory in the row today, so omitting it is real.
 * - narrative: `description` — opt-in via `fields`, so this only bites together
 *   with `fields: full`, which is exactly when a caller wants every number and
 *   none of the prose.
 * - pair: NOTHING, deliberately. Every issuer-text field beyond the symbols
 *   (`baseName`, `quoteName`, `socialPlatforms`, `imageUrl`) is ALREADY opt-in,
 *   so subtracting an addition is just not requesting it; and
 *   `baseSymbol`/`quoteSymbol` are row identity. A parameter that can only ever
 *   be a no-op or a mistake is refused, by name, with that reason.
 *
 * Nothing here may reach identity, the provenance envelope, the external-content
 * labelling, or any financially-consumed field.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import { DEXSCREENER_TOOLS } from "@vex-agent/tools/protocols/dexscreener/manifest.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import { metasTrending, profilesLatest } from "./_feed-captures.js";
import { searchUsdc } from "./_pair-captures.js";

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

interface Payload extends Record<string, unknown> {
  fieldsOmitted?: string[];
  externalContentFields: string[];
  externalContentWarning: string;
  rows?: Array<Record<string, unknown>>;
  narratives?: Array<Record<string, unknown>>;
  pairs?: Array<Record<string, unknown>>;
}

async function run(
  toolId: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; output: string }> {
  const handler = DEXSCREENER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  const result = await handler(params, READ_CTX);
  return { ok: result.success, output: result.output };
}

async function call(toolId: string, params: Record<string, unknown>): Promise<Payload> {
  const result = await run(toolId, params);
  expect(result.ok, result.output).toBe(true);
  return JSON.parse(result.output) as Payload;
}

describe("omitFields — the feed family", () => {
  beforeEach(() => {
    vi.spyOn(getDexScreenerClient(), "getProfiles").mockResolvedValue(profilesLatest());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes the mandatory description from every row and echoes what it removed", async () => {
    const withText = await call("dexscreener.profiles", {});
    const without = await call("dexscreener.profiles", { omitFields: "description" });

    expect((withText.rows ?? []).some((row) => "description" in row)).toBe(true);
    expect((without.rows ?? []).every((row) => !("description" in row))).toBe(true);
    expect(without.fieldsOmitted).toEqual(["description"]);
    expect(without.rows).toHaveLength((withText.rows ?? []).length);
  });

  it("identity survives — a row without its description is still resolvable", async () => {
    const without = await call("dexscreener.profiles", { omitFields: "description" });
    for (const row of without.rows ?? []) {
      expect(typeof row.chainId).toBe("string");
      expect(typeof row.tokenAddress).toBe("string");
    }
  });

  it("externalContentFields reflects the POST-omission shape", async () => {
    const withText = await call("dexscreener.profiles", {});
    const without = await call("dexscreener.profiles", { omitFields: "description" });
    expect(withText.externalContentFields.some((path) => path.endsWith(".description"))).toBe(true);
    // Naming a path that is no longer in the payload would be a provenance lie.
    expect(without.externalContentFields.some((path) => path.endsWith(".description"))).toBe(false);
    // The warning itself never leaves.
    expect(without.externalContentWarning.length).toBeGreaterThan(0);
  });

  it("saves real bytes — which is the reason it exists", async () => {
    const withText = await run("dexscreener.profiles", {});
    const without = await run("dexscreener.profiles", { omitFields: "description" });
    expect(Buffer.byteLength(without.output, "utf8")).toBeLessThan(
      Buffer.byteLength(withText.output, "utf8"),
    );
  });

  it("rejects a name outside the allowlist BY NAME, and states the allowlist", async () => {
    const result = await run("dexscreener.profiles", { omitFields: "tokenAddress" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("tokenAddress");
    expect(result.output).toContain("description");
  });

  it("leaves the payload untouched when it is absent", async () => {
    const bare = await call("dexscreener.profiles", {});
    expect("fieldsOmitted" in bare).toBe(false);
  });
});

describe("omitFields — the narrative family", () => {
  beforeEach(() => {
    vi.spyOn(getDexScreenerClient(), "getMetasTrending").mockResolvedValue(metasTrending());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("subtracts the prose from `fields: full` while keeping every number", async () => {
    const full = await call("dexscreener.trending", { fields: "full" });
    const lean = await call("dexscreener.trending", { fields: "full", omitFields: "description" });

    expect((full.narratives ?? []).some((row) => "description" in row)).toBe(true);
    expect((lean.narratives ?? []).every((row) => !("description" in row))).toBe(true);
    for (const row of lean.narratives ?? []) {
      expect(row).toHaveProperty("marketCapUsd");
      expect(row).toHaveProperty("marketCapChangePctH24");
      expect(row).toHaveProperty("slug");
    }
    expect(lean.fieldsOmitted).toEqual(["description"]);
  });

  it("rejects any other name by name", async () => {
    const result = await run("dexscreener.trending", { omitFields: "marketCapUsd" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("marketCapUsd");
  });
});

describe("omitFields — the pair family refuses every name, on purpose", () => {
  beforeEach(() => {
    vi.spyOn(getDexScreenerClient(), "search").mockResolvedValue(searchUsdc());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses an opt-in text field, pointing at `fields` instead", async () => {
    const result = await run("dexscreener.search", { query: "USDC", omitFields: "baseName" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("baseName");
    // The rationale, not just a refusal: these are additive already.
    expect(result.output).toMatch(/already opt-in|already OPT-IN/);
    expect(result.output).toContain("fields");
  });

  it("refuses row identity, and says it is identity", async () => {
    const result = await run("dexscreener.search", { query: "USDC", omitFields: "baseSymbol" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("baseSymbol");
    expect(result.output).toMatch(/identity/i);
  });

  it("refuses a financially-consumed field", async () => {
    const result = await run("dexscreener.search", { query: "USDC", omitFields: "priceUsd" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("priceUsd");
  });

  it("names EVERY offending value, not just the first", async () => {
    const result = await run("dexscreener.search", {
      query: "USDC",
      omitFields: "baseName,quoteName",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("baseName");
    expect(result.output).toContain("quoteName");
  });
});

describe("omitFields — declaration", () => {
  it("is advertised only where subtractive projection removes real prose", () => {
    const declaring = DEXSCREENER_TOOLS.filter((tool) =>
      tool.params.some((param) => param.key === "omitFields"),
    );
    expect(declaring.length).toBeGreaterThan(0);
    for (const tool of declaring) {
      const param = tool.params.find((p) => p.key === "omitFields");
      expect(param?.type).toBe("string");
      // A projection selector, like `fields` — not a data list.
      expect(param?.acceptsStringArray).toBeUndefined();
    }
  });

  it("does not advertise the pair family's deliberately empty allowlist", () => {
    for (const toolId of [
      "dexscreener.search",
      "dexscreener.pairs",
      "dexscreener.tokens",
      "dexscreener.tokenPairs",
      "dexscreener.meta",
    ]) {
      const tool = DEXSCREENER_TOOLS.find((candidate) => candidate.toolId === toolId);
      expect(tool?.params.map((param) => param.key)).not.toContain("omitFields");
    }
  });
});
