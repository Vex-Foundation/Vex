/**
 * The LOCKSTEP GUARD between the engine's injected-name codec and the app
 * boundary that reverses it.
 *
 * The model calls a discovered protocol manifest under an OpenAI-legal name
 * (`kyberswap.swap.quote` -> `kyberswap__swap__quote`). Everything that SHOWS a
 * tool to a human must show the dotted id back. If the codec and this boundary
 * ever disagree — a new manifest whose id breaks the bijection, an incidental
 * `toLowerCase()` on a camelCase id — the whole catalog sweep below fails,
 * rather than the user quietly seeing `dexscreener__tokenpairs` in their chat.
 */

import { describe, expect, it } from "vitest";
import { PROTOCOL_TOOLS } from "@vex-agent/tools/protocols/catalog.js";
import { TOOLS } from "@vex-agent/tools/registry/lookup.js";
import { toInjectedToolName } from "@vex-agent/tools/registry/injected-protocol-tools.js";
import { canonicalToolName } from "../tool-name-canonical.js";

describe("canonicalToolName - the whole catalog, in lockstep", () => {
  it("reverses `toInjectedToolName` for every protocol manifest", () => {
    expect(PROTOCOL_TOOLS.length).toBeGreaterThan(0);
    for (const manifest of PROTOCOL_TOOLS) {
      expect(canonicalToolName(toInjectedToolName(manifest.toolId))).toBe(
        manifest.toolId,
      );
    }
  });

  it("leaves every INTERNAL tool name exactly as it is", () => {
    expect(TOOLS.length).toBeGreaterThan(0);
    for (const tool of TOOLS) {
      expect(canonicalToolName(tool.name)).toBe(tool.name);
    }
  });
});

describe("canonicalToolName - an unresolvable name keeps its raw form", () => {
  it.each([
    "kyberswapp__swap__quote",
    "nope__not__a__tool",
    "khalani__unknown",
    "dexscreener__unknown",
    "",
    "agent_scan",
    "execute_tool",
  ])("returns %s verbatim", (name) => {
    expect(canonicalToolName(name)).toBe(name);
  });
});

/**
 * 14 real toolIds are camelCase. Lower-casing a name before resolving it would
 * silently lose every one of them, so they are pinned by hand as well as by the
 * catalog sweep above.
 */
describe("canonicalToolName - case is preserved", () => {
  it.each([
    ["dexscreener__tokenPairs", "dexscreener.tokenPairs"],
    ["dexscreener__communityTakeovers", "dexscreener.communityTakeovers"],
    ["solana__lend__borrowOperate", "solana.lend.borrowOperate"],
    ["pendle__lp__toPt", "pendle.lp.toPt"],
  ])("maps %s to %s", (wire, dotted) => {
    expect(canonicalToolName(wire)).toBe(dotted);
  });
});
