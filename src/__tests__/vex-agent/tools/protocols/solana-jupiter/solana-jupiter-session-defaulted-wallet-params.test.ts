/**
 * The session-defaulted account params are no longer declared REQUIRED
 * (SPEC §2.8 items 14/15, W2g follow-up).
 *
 * Six read tools declared `walletAddress` required while their handler
 * resolves it from the session through `handlers/core/wallet-scope.ts`
 * `walletAddress(p, ctx)` — which never needs the param, and under session
 * scope REJECTS any address other than the selected wallet. So the manifest
 * forced the agent to supply a value it could not choose: omit it and the
 * param gate refused the call before the handler ran; supply anything else
 * and the wallet gate refused it after. The only accepted value was one the
 * session already knew.
 *
 * `solana.predict.suggestedEvents` is deliberately NOT in this list: its
 * handler reads `str(p, "walletAddress")` directly with no session fallback
 * and genuinely targets any wallet, so `required: true` is correct there.
 */

import { describe, expect, it } from "vitest";

import { SOLANA_JUPITER_TOOLS } from "@vex-agent/tools/protocols/solana-jupiter/manifest.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";

/** Verified one-by-one against the handler that resolves each tool's owner. */
const SESSION_DEFAULTED = [
  "solana.predict.positions",
  "solana.predict.history",
  "solana.predict.orders",
  "solana.predict.profile",
  "solana.predict.pnlHistory",
  "solana.lend.positions",
] as const;

function manifestFor(toolId: string) {
  const manifest = SOLANA_JUPITER_TOOLS.find((tool) => tool.toolId === toolId);
  if (!manifest) throw new Error(`no manifest for ${toolId}`);
  return manifest;
}

describe("solana session-defaulted walletAddress params", () => {
  it.each(SESSION_DEFAULTED)("%s declares walletAddress optional and states the default", (toolId) => {
    const param = manifestFor(toolId).params.find((p) => p.key === "walletAddress");
    if (param === undefined) throw new Error(`${toolId} declares no walletAddress param`);
    expect(param.required).toBeFalsy();
    expect(param.description).toMatch(/Defaults to the session's selected Solana wallet/);
  });

  /** The tool's OTHER genuinely-required params, so the only thing omitted is walletAddress. */
  const OTHER_REQUIRED: Readonly<Record<string, Record<string, unknown>>> = {
    "solana.predict.pnlHistory": { interval: "1w" },
  };

  it.each(SESSION_DEFAULTED)("%s is no longer refused for omitting walletAddress", (toolId) => {
    const manifest = manifestFor(toolId);
    // Guard the guard: if a future edit re-required walletAddress, the params
    // below would not be the only thing keeping this green.
    expect(manifest.params.find((p) => p.key === "walletAddress")?.required).toBeFalsy();

    const result = validateProtocolParams(manifest, { ...OTHER_REQUIRED[toolId] });
    expect(result.ok).toBe(true);
  });

  it.each(SESSION_DEFAULTED)("%s does not teach the agent to supply one in exampleParams", (toolId) => {
    expect(manifestFor(toolId).exampleParams).not.toHaveProperty("walletAddress");
  });

  it("solana.predict.suggestedEvents KEEPS walletAddress required — it has no session default", () => {
    const manifest = manifestFor("solana.predict.suggestedEvents");
    expect(manifest.params.find((p) => p.key === "walletAddress")?.required).toBe(true);
    expect(validateProtocolParams(manifest, {}).ok).toBe(false);
  });
});
