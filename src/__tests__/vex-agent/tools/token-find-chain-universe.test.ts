/**
 * `TokenFind` chain universe — pinned on BOTH description surfaces.
 *
 * The agent reads `TokenFind` from two places that drifted apart: the protocol
 * manifest (`khalani.tokens.search`, reached through discover_tools) and the
 * hard-coded alias description in `registry/khalani.ts`. A live session burned
 * turns asking `TokenFind` for a Robinhood Chain token, which it cannot know
 * about, because neither surface said where its knowledge ends.
 *
 * The universe is DYNAMIC, so this suite pins the POINTER (list the chains with
 * `khalani.chains.list`) and the named escape hatches — never a static chain
 * list, which would rot the moment Khalani registers another chain.
 */

import { describe, expect, it } from "vitest";

import { getToolDef } from "@vex-agent/tools/registry.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";

const SURFACES: readonly (readonly [string, string])[] = [
  ["TokenFind alias", getToolDef("TokenFind")?.description ?? ""],
  [
    "khalani.tokens.search manifest",
    getProtocolManifest("khalani.tokens.search")?.description ?? "",
  ],
];

describe("TokenFind chain universe", () => {
  it.each(SURFACES)("%s scopes itself to Khalani-registered chains", (_name, description) => {
    expect(description).not.toBe("");
    expect(description).toMatch(/Khalani-registered chains/i);
  });

  it.each(SURFACES)("%s points at the live list instead of naming a static set", (_name, description) => {
    expect(description).toMatch(/dynamic/i);
    expect(description).toMatch(/chains/i);
  });

  it.each(SURFACES)("%s names the app-local escape hatches", (_name, description) => {
    expect(description).toContain("Robinhood");
    expect(description).toContain("4663");
    expect(description).toContain("WalletTrackToken");
    expect(description).toContain("WalletBalances");
  });

  /**
   * HOW EACH SURFACE MAY SPELL ITS POINTERS (owner decision D-DS9-R, 2026-08-26).
   *
   * The two surfaces are read at different moments and the rule follows that,
   * which is why this stopped being one shared assertion:
   *
   *  - The ALIAS is ALWAYS VISIBLE. Its reader is a fresh session whose
   *    discovered set is empty, so a `publicName` in it is an instruction to
   *    make a call `dispatcher/protocol-route.ts` will refuse. It caused
   *    exactly that in production. It now points by CAPABILITY plus ToolSearch,
   *    and `registry/fresh-model-surface-names.test.ts` enforces the ban over
   *    every always-visible description at once.
   *  - The MANIFEST is read only from a ToolSearch result, by a model that is
   *    already in a discovery round and can select the neighbour it is pointed
   *    at, so its publicNames are kept and pinned here.
   */
  it("the ALWAYS-VISIBLE alias points by capability and ToolSearch, never by callable name", () => {
    const alias = getToolDef("TokenFind")?.description ?? "";
    expect(alias).not.toBe("");
    expect(alias).not.toContain("khalani__chains_list");
    expect(alias).not.toContain("dexscreener__pairs_search");
    expect(alias).toContain("khalani namespace's supported-chains tool");
    expect(alias).toContain("dexscreener namespace's pair search");
    // Both pointers have to say HOW to reach the tool, or the capability
    // phrasing is just a name the model cannot act on either.
    expect(alias.match(/ToolSearch/g) ?? []).toHaveLength(2);
  });

  it("the discovery-only manifest keeps its callable pointers", () => {
    const manifest = getProtocolManifest("khalani.tokens.search")?.description ?? "";
    expect(manifest).toContain("khalani__chains_list");
    expect(manifest).toContain("dexscreener__pairs_search");
  });
});
