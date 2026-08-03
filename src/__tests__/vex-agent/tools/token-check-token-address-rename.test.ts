/**
 * `token_check`: `address` → `tokenAddress`, ATOMIC across seven surfaces.
 *
 * A rename that lands on some surfaces and not others is worse than no rename
 * at all: the model reads one spelling in the alias schema, another in the
 * discovery payload, and a third in the Safety Contract, and the only way it
 * finds out which one the runtime wants is a failed call before a swap. So this
 * suite is a MATRIX, not a set of spot checks — every surface that names the
 * param is asserted here, and the retired spelling is asserted DEAD on each.
 *
 * The seven surfaces:
 *   1. the kyberswap protocol manifest (params + exampleParams)
 *   2. the kyberswap handler (what it reads, and what it echoes back)
 *   3. the alias JSON schema the model is shown (properties + required)
 *   4. the alias handler's Zod contract
 *   5. the Safety Contract prompt's worked call
 *   6. the alias↔protocol parity mapping (alias keys ≡ protocol keys)
 *   7. STRICT rejection of the retired key — including when BOTH spellings are
 *      supplied, which a non-strict `z.object()` used to accept while silently
 *      dropping one of them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeProtocolTool } = vi.hoisted(() => ({
  executeProtocolTool: vi.fn(async (_request: unknown, _context: unknown) => ({
    success: true, output: "ok",
  })),
}));

vi.mock("@vex-agent/tools/protocols/runtime.js", () => ({ executeProtocolTool }));

import { TOKENS_TOOLS } from "@vex-agent/tools/protocols/kyberswap/manifests/tokens.js";
import { ACTION_ALIAS_TOOLS } from "@vex-agent/tools/registry/action-aliases.js";
import { handleTokenCheck } from "@vex-agent/tools/internal/action-aliases.js";
import { buildSafetyContractPrompt } from "@vex-agent/engine/prompts/safety-contract.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";

const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const MANIFEST = TOKENS_TOOLS.find((t) => t.toolId === "kyberswap.tokens.check")!;
const ALIAS = ACTION_ALIAS_TOOLS.find((t) => t.name === "token_check")!;

function aliasSchema(): { properties: Record<string, unknown>; required: readonly string[] } {
  return ALIAS.parameters as never;
}

function context(): InternalToolContext {
  return {
    sessionId: "token-check-rename",
    loadedDocuments: new Map<string, string>(),
    sessionPermission: "restricted",
    approved: false,
    missionRunId: null,
  } as never;
}

beforeEach(() => executeProtocolTool.mockClear());

describe("surface 1 — the kyberswap protocol manifest", () => {
  it("declares tokenAddress, required, and never address", () => {
    const keys = MANIFEST.params.map((p) => p.key);
    expect(keys).toContain("tokenAddress");
    expect(keys).not.toContain("address");
    expect(MANIFEST.params.find((p) => p.key === "tokenAddress")?.required).toBe(true);
  });

  it("shows the new key in exampleParams — a stale example is a stale contract", () => {
    expect(MANIFEST.exampleParams).toHaveProperty("tokenAddress");
    expect(MANIFEST.exampleParams).not.toHaveProperty("address");
  });
});

describe("surface 2 — the kyberswap handler", () => {
  it("reads tokenAddress and echoes it back under the same name", async () => {
    const { CHAIN_TOKEN_HANDLERS } = await import(
      "@vex-agent/tools/protocols/kyberswap/handlers/swap/chain-token-handlers.js"
    );
    const source = CHAIN_TOKEN_HANDLERS["kyberswap.tokens.check"]!.toString();
    expect(source).toContain("tokenAddress");
    expect(source).not.toMatch(/"address"|'address'/);
  });
});

describe("surface 3 — the alias JSON schema the model reads", () => {
  it("exposes tokenAddress as required and has retired address", () => {
    const schema = aliasSchema();
    expect(Object.keys(schema.properties)).toEqual(["chain", "tokenAddress"]);
    expect(schema.required).toEqual(["chain", "tokenAddress"]);
  });

  it("says in prose that the old key is rejected, so the model does not have to discover it", () => {
    expect(ALIAS.description).toContain("tokenAddress");
    expect(ALIAS.description).toContain("`address` is retired");
  });
});

describe("surfaces 4 + 6 — the alias handler and the alias↔protocol parity mapping", () => {
  it("dispatches the model's tokenAddress under the protocol's own key, unchanged", async () => {
    const result = await handleTokenCheck({ chain: "base", tokenAddress: TOKEN }, context());
    expect(result.success).toBe(true);

    const [request] = executeProtocolTool.mock.calls[0] as [
      { toolId: string; params: Record<string, unknown> },
      unknown,
    ];
    expect(request.toolId).toBe("kyberswap.tokens.check");
    expect(request.params).toEqual({ chain: "base", tokenAddress: TOKEN });

    // PARITY: the alias lane's key set is exactly the protocol lane's key set.
    // The alias is a pass-through, so any divergence is a translation bug that
    // only shows up as a runtime "unknown parameter".
    expect(Object.keys(request.params).sort()).toEqual(
      MANIFEST.params.map((p) => p.key).sort(),
    );
    expect(aliasSchema().required).toEqual(
      MANIFEST.params.filter((p) => p.required).map((p) => p.key),
    );
  });
});

describe("surface 5 — the Safety Contract prompt", () => {
  it("teaches the call with tokenAddress and no longer with address", () => {
    const prompt = buildSafetyContractPrompt();
    expect(prompt).toContain('token_check(chain="...", tokenAddress="...")');
    expect(prompt).not.toContain('token_check(chain="...", address="...")');
  });
});

describe("surface 7 — the retired key is rejected BY NAME, never silently dropped", () => {
  it("refuses a call that still spells it address, and says what to send instead", async () => {
    const result = await handleTokenCheck({ chain: "base", address: TOKEN }, context());
    expect(result.success).toBe(false);
    expect(result.output).toContain('"address" was retired and renamed to "tokenAddress"');
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("refuses when BOTH spellings are supplied — the non-strict-parse hole", async () => {
    // This is the case a plain `z.object()` accepted: `address` was an
    // unrecognized key, so parsing "succeeded" and the call went out having
    // silently chosen one of two token addresses the caller named. On a
    // honeypot check, picking the wrong one is the whole failure.
    const OTHER = "0x4200000000000000000000000000000000000006";
    const result = await handleTokenCheck(
      { chain: "base", address: OTHER, tokenAddress: TOKEN },
      context(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('you supplied BOTH "address" and "tokenAddress"');
    expect(result.output).toContain("will not guess");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("rejects any other unknown key too — strict parsing, not a one-off patch", async () => {
    const result = await handleTokenCheck(
      { chain: "base", tokenAddress: TOKEN, symbol: "USDC" },
      context(),
    );
    expect(result.success).toBe(false);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});
