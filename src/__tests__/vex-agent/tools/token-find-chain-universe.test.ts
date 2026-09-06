import { describe, expect, it } from "vitest";

import { getToolDef } from "@vex-agent/tools/registry.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";

describe("TokenFind chain universe", () => {
  const alias = getToolDef("TokenFind");

  it("keeps one stable EVM name and declares capability routing", () => {
    expect(alias).toBeDefined();
    expect(alias?.description).toContain("Khalani-registered EVM chains");
    expect(alias?.description).toContain("Robinhood Chain (4663)");
    expect(alias?.description).toContain("routes by chain capability");
    expect(alias?.description).toContain("Solana stays separate");
  });

  it("requires explicit mutation scope and contract metadata", () => {
    expect(alias?.description).toContain("exactly one target chain");
    expect(alias?.description).toContain("mutationReady");
    expect(alias?.description).toContain("reads symbol and decimals from the contract");
    expect(alias?.description).toContain("Name or symbol candidates with explicit chainIds are contract-validated");
    expect(alias?.description).toContain("unscoped results remain provider-only research, never mutationReady");
    expect(alias?.description).toContain("never supplies contract-verified symbol or decimals");
    expect(alias?.description).toContain("Bridge approvals independently re-read and show contract metadata");
    expect(alias?.description).toContain("Swap cards carry a quote-time contract-read output symbol");
    expect(alias?.description).toContain("card is not proof");
  });

  it("reports ambiguity, provider bounds, and actionable failures", () => {
    expect(alias?.description).toContain("Ambiguous matches are never auto-selected");
    expect(alias?.description).toContain("provider_capped");
    expect(alias?.description).toContain("metadata_unreadable");
    expect(alias?.description).toContain("unsupported_chain");
    expect(alias?.description).toContain("provider_unavailable");
    expect(alias?.description).toContain("target_chain_required");
    expect(alias?.description).toContain("empty");
  });

  it("states the routed result shape instead of making the model infer keys", () => {
    expect(alias?.description).toContain("RETURNS query, requestedChains, resolution");
    expect(alias?.description).toContain("coverage");
    expect(alias?.description).toContain("metadataCounts");
    expect(alias?.description).toContain("mutationReady");
    expect(alias?.description).toContain("candidates");
    expect(alias?.description).toContain("metadata, provenance, providerMetadata, and pairEvidence");
  });

  it("does not teach a not-yet-discovered protocol callable name", () => {
    expect(alias?.description).not.toContain("khalani__tokens_search");
    expect(alias?.description).not.toContain("dexscreener__pairs_search");
    expect(alias?.description).not.toContain("solana__tokens_search");
    expect(alias?.description).toContain("ToolSearch");
  });

  it("leaves the discovered Khalani tool honestly Khalani-scoped", () => {
    const manifest = getProtocolManifest("khalani.tokens.search");
    expect(manifest?.description).toContain("Use this when researching provider-listed candidates");
    expect(manifest?.description).toMatch(/Khalani-registered chains/i);
    expect(manifest?.description).toContain("Robinhood Chain (4663)");
    expect(manifest?.description).toContain("do not route it manually from here");
    expect(manifest?.description).not.toContain("dexscreener__pairs_search");
  });
});
