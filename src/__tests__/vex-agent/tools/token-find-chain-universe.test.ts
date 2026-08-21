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
    expect(description).toContain("khalani__chains_list");
    expect(description).toMatch(/dynamic/i);
  });

  it.each(SURFACES)("%s names the app-local escape hatches", (_name, description) => {
    expect(description).toContain("Robinhood");
    expect(description).toContain("4663");
    expect(description).toContain("dexscreener__pairs_search");
    expect(description).toContain("WalletTrackToken");
    expect(description).toContain("WalletBalances");
  });
});
