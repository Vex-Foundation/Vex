/**
 * LINTS AND GATES over the Vex Studio MCP inventory (stage A4a, spec item 9).
 *
 * Everything here is a property of the surface an external coding agent sees.
 * None of it is a re-implementation of the builder: each case asks the live
 * inventory a question that has one right answer, and the answers come from the
 * decisions recorded in the plan (O6 titles, O7 annotations, O20 exposure and
 * the hot set, O23 the 2000-byte budget).
 *
 * The one that is easy to underrate is LIST EQUALITY. MCP 2026-07-28 requires a
 * `tools/list` that does not vary with connection state, and Vex additionally
 * promises it does not vary with the project, the permission or which provider
 * keys happen to be configured on this machine. A list that quietly shrank when
 * a key was missing would make "the tool is not there" and "the tool is not
 * configured" the same observation, and an agent cannot act on that.
 *
 * NOT HERE, and deliberately: the BUNDLED-MAIN check that the packaged
 * JavaScript carries no unresolved `@modelcontextprotocol/*` import. It needs
 * the server module to exist and be imported by main, which stage A4a-2 builds.
 * It is stage A4a-2's gate, in the same change that adds the import.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
  buildStudioInventory,
  studioAlwaysLoadNames,
  STUDIO_TOOL_TITLES,
  DESTRUCTIVE_ACTION_KINDS,
  studioToolAnnotations,
} from "@vex-agent/mcp/inventory/index.js";
import { ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS } from "@vex-agent/mcp/inventory/types.js";
import { EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME } from "@vex-agent/mcp/tool-describe-export.js";
import { listExportedTools } from "@vex-agent/mcp/export-scope.js";
import { EXPORTED_TOOL_SEARCH_PUBLIC_NAME } from "@vex-agent/mcp/tool-search-export.js";
import { ACTION_KINDS } from "@vex-agent/tools/taxonomy.js";
import { getToolDef } from "@vex-agent/tools/registry.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";

const inventory = buildStudioInventory();

/** Bytes, not characters. The O23 budget is a wire budget. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * BOTH READINGS OF THE HOT-SET BOUND over one description, from one place.
 *
 * The character reading is the measured contract (Claude Code cuts at 2048 code
 * points); the byte reading is the second, for any client that counts the
 * encoded string. They are computed together so the two table lints below and
 * the synthetic threshold case cannot drift into measuring different things -
 * the whole point of the synthetic case is that it fails if `bytes` ever stops
 * counting bytes.
 */
function boundReadings(description: string): {
  readonly characters: number;
  readonly bytes: number;
  readonly fitsInCharacters: boolean;
  readonly fitsInBytes: boolean;
} {
  const characters = [...description].length;
  const bytes = byteLength(description);
  return {
    characters,
    bytes,
    fitsInCharacters: characters <= ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS,
    fitsInBytes: bytes <= ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS,
  };
}

/** The first `limit` BYTES of a string, decoded back. */
function head(value: string, limit: number): string {
  return Buffer.from(value, "utf8").subarray(0, limit).toString("utf8");
}

describe("the exported inventory covers exactly the export scope", () => {
  it("produces one record per exported tool, plus the MCP-only contract reader", () => {
    // `vex_ToolDescribe` has no in-app `ToolDef`, so `listExportedTools()` -
    // which answers only for tools the registry knows - cannot list it. It is
    // the inventory's own row, and this is the one deliberate difference.
    expect(inventory).toHaveLength(listExportedTools().length + 1);
    const names = inventory.map((t) => t.publicName);
    expect(names).toContain(EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME);
    expect(new Set(names).size).toBe(names.length);
  });

  it("pins the exported surface size the owner decided (O20)", () => {
    // 165 is a REVIEWED number: 25 internal tools plus 140 protocol tools. It
    // is pinned literally because a change to it is always a decision about
    // what external agents may call, never an incidental refactor.
    // 155 -> 159: stage A4b exported the four generic transaction signing
    // tools (EVM and Solana prepare/confirm).
    // 159 -> 165: the dexscreener protocol replaced its 12 public-API tools
    // with the 18-tool website-API surface (S10).
    // 165 -> 167: the native <-> wrapped-native pair, exported by default like
    // every other wallet tool and recorded in `mcp-export-scope.md`.
    // 167 -> 168: `vex_ToolDescribe`, the MCP-only whole-contract reader that
    // exists because a client truncates a description and never a result.
    // 168 -> 167: `WebResearch` left the export (owner decision 2026-09-03).
    // Every client that connects has its own web search, so the exported copy
    // was a duplicate that cost a provider key and 2 KB of context.
    // 167 -> 171 on the integration of the launchpads arc: the two pools.fun
    // read tools of the read-depth lane (`pools__launch_assets_list`,
    // `pools__holder_rewards_get`) and the two Virtuals market-history reads
    // (`virtuals__agent_trades_list`, `virtuals__agent_candles_list`). All four
    // are read-only and none signs.
    // 172 -> 174 on the PR-C2 merge: the Virtuals bonding-curve trade pair
    // (`virtuals__agent_trade_quote`, `virtuals__agent_trade_execute`). The
    // quote is read-only; the execute is the FIRST signing tool this namespace
    // has ever exported, which is why the internal count is unmoved and the
    // protocol count carries both.
    // 174 -> 176 on the holder-rewards merge: the two pools.fun MUTATIONS
    // `pools__holder_rewards_claim` (the holder's own claim, which pays
    // whoever signs it and carries no Vex fee) and
    // `pools__holder_rewards_distribute` (the permissionless push, which pays
    // the token's holders rather than its caller). Both sign, so unlike the
    // two pools reads above neither is read-only; the internal count is
    // unmoved and the protocol count carries both (147 -> 149).
    // 176 -> 180 on the Virtuals AGENT-LAUNCH family
    // (`virtuals__agent_launch_preview`, `_execute`, `_status`, `_cancel`).
    // All four ARE exported to the Studio surface, unlike the two locker tools
    // in `NON_EXPORTED_PROTOCOL_TOOLS`: an external agent has no image locker,
    // but it does have its own project, and the launch family takes `imagePath`
    // there and publishes those bytes to the same content-addressed host. Only
    // one of the four is read-only (`_status`); the internal count was unmoved
    // and the protocol count carried all four (149 -> 153).
    // 180 -> 170 on the Trench Express retirement (migration 108): the ten
    // `trench__*` tools were deleted with the protocol. All ten were protocol
    // tools, so the internal count is unmoved again and the protocol count
    // carries the whole drop (153 -> 143).
    expect(inventory).toHaveLength(170);
    expect(inventory.filter((t) => t.kind === "internal")).toHaveLength(27);
    expect(inventory.filter((t) => t.kind === "protocol")).toHaveLength(143);
  });

  it("keeps WebResearch OUT of tools/list while the in-app registry keeps it", () => {
    // The two lanes diverge ON PURPOSE. An external client brings its own web
    // search, so exporting a Tavily-keyed second one buys nothing; the in-app
    // Vex agent has no such client and still needs the tool. If this ever fails
    // by finding the tool exported again, the decision - not the test - is what
    // changed.
    expect(inventory.map((t) => t.publicName)).not.toContain("WebResearch");
    expect(studioAlwaysLoadNames()).not.toContain("WebResearch");
    const inApp = getToolDef("WebResearch");
    expect(inApp, "WebResearch must stay registered for the in-app agent").toBeDefined();
    expect(inApp?.requiresEnv).toBe("TAVILY_API_KEY");
    // And the key it needs is no longer something the MCP surface declares, so
    // the managed block stops telling a coding agent to configure it.
    expect(
      inventory.flatMap((t) => (t.requiresEnv === undefined ? [] : [t.requiresEnv])),
    ).not.toContain("TAVILY_API_KEY");
  });

  it("exports ToolSearch under its own public name and no other spelling", () => {
    const names = inventory.map((t) => t.publicName);
    expect(names).toContain(EXPORTED_TOOL_SEARCH_PUBLIC_NAME);
    expect(names).not.toContain("ToolSearch");
  });
});

describe("the canonical order is owned by the inventory and is byte-wise", () => {
  it("puts every internal tool before every protocol tool", () => {
    const firstProtocol = inventory.findIndex((t) => t.kind === "protocol");
    const lastInternal = inventory.map((t) => t.kind).lastIndexOf("internal");
    expect(lastInternal).toBeLessThan(firstProtocol);
  });

  it("sorts internal tools byte-wise by name", () => {
    const internal = inventory.filter((t) => t.kind === "internal").map((t) => t.publicName);
    expect(internal).toEqual([...internal].sort());
  });

  it("sorts protocol tools byte-wise by namespace then name", () => {
    const keys = inventory
      .filter((t) => t.kind === "protocol")
      .map((t) => `${t.namespace ?? ""}\u0000${t.publicName}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("uses codepoint order, not locale order", () => {
    // `Array.prototype.sort` with no comparator is codepoint order, which is
    // what the assertions above compare against. The regression this guards is
    // somebody replacing the comparator with `localeCompare`, which in an ICU
    // build orders `vex_ToolSearch` before the capitalized names and would make
    // `tools/list` depend on the machine's locale data.
    const internal = inventory.filter((t) => t.kind === "internal").map((t) => t.publicName);
    expect(internal[internal.length - 1]).toBe(EXPORTED_TOOL_SEARCH_PUBLIC_NAME);
    expect([...internal].sort((a, b) => a.localeCompare(b))).not.toEqual(internal);
  });
});

describe("every exported name is ASCII", () => {
  it("accepts no name outside printable ASCII", () => {
    // A non-ASCII name would sort differently under a locale comparator, could
    // normalize to a different byte sequence in transit, and cannot be typed by
    // a user reading a transcript. The grammar gates already enforce this for
    // protocol public names; this asserts it for the WHOLE exported surface.
    const offenders = inventory
      .filter((t) => !/^[\x20-\x7E]+$/.test(t.publicName))
      .map((t) => t.publicName);
    expect(offenders).toEqual([]);
  });

  it("accepts no name that MCP clients cannot carry as a function name", () => {
    const offenders = inventory
      .filter((t) => !/^[a-zA-Z0-9_-]{1,64}$/.test(t.publicName))
      .map((t) => t.publicName);
    expect(offenders).toEqual([]);
  });
});

describe("titles are authored, complete and distinct (O6)", () => {
  it("gives every exported tool a non-empty authored title", () => {
    const missing = inventory.filter((t) => t.title.trim().length === 0);
    expect(missing).toEqual([]);
  });

  it("carries no title for a tool that is not exported", () => {
    const exported = new Set(inventory.map((t) => t.publicName));
    const orphans = Object.keys(STUDIO_TOOL_TITLES).filter((n) => !exported.has(n));
    // An orphan means a tool left the export scope and its reviewed copy stayed
    // behind, which is exactly the drift the artifact exists to make visible.
    expect(orphans).toEqual([]);
  });

  it("gives no two tools the same title", () => {
    const titles = inventory.map((t) => t.title);
    const duplicates = titles.filter((t, i) => titles.indexOf(t) !== i);
    expect([...new Set(duplicates)]).toEqual([]);
  });

  it("keeps every title short enough for a picker row", () => {
    const tooLong = inventory.filter((t) => t.title.length > 64).map((t) => t.publicName);
    expect(tooLong).toEqual([]);
  });
});

describe("annotations are pinned to O7, literally", () => {
  it("sets readOnlyHint exactly when the action kind is `read`", () => {
    for (const tool of inventory) {
      // `vex_ToolDescribe` has no `ToolDef`: it is the MCP-only contract
      // reader, classified `read` at its one assembly point in the inventory.
      const actionKind =
        tool.publicName === EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME
          ? "read"
          : tool.kind === "internal"
          ? getToolDef(
              tool.publicName === EXPORTED_TOOL_SEARCH_PUBLIC_NAME
                ? "ToolSearch"
                : tool.publicName,
            )?.actionKind
          : getProtocolManifest(tool.toolId ?? "")?.actionKind;
      expect(actionKind).toBeDefined();
      expect(tool.annotations.readOnlyHint).toBe(actionKind === "read");
      expect(tool.annotations.destructiveHint).toBe(
        actionKind !== undefined && DESTRUCTIVE_ACTION_KINDS.has(actionKind),
      );
    }
  });

  it("emits BOTH hints on every exported tool, and no others", () => {
    for (const tool of inventory) {
      expect(Object.keys(tool.annotations).sort()).toEqual([
        "destructiveHint",
        "readOnlyHint",
      ]);
    }
  });

  it("omits idempotentHint and openWorldHint rather than defaulting them", () => {
    // MCP reads an absent hint as unknown and a present one as a claim. Vex has
    // no per-tool evidence for either, so a default would be an unverified
    // safety claim on 155 tools.
    for (const tool of inventory) {
      expect(tool.annotations).not.toHaveProperty("idempotentHint");
      expect(tool.annotations).not.toHaveProperty("openWorldHint");
    }
  });

  it("classifies every action kind deliberately, including a new one", () => {
    // The exhaustiveness gate: adding an `ActionKind` without deciding its
    // annotations fails here rather than defaulting to "harmless".
    for (const kind of ACTION_KINDS) {
      const annotations = studioToolAnnotations(kind);
      expect(annotations.readOnlyHint).toBe(kind === "read");
      expect(annotations.destructiveHint).toBe(DESTRUCTIVE_ACTION_KINDS.has(kind));
      // No kind may claim both.
      expect(annotations.readOnlyHint && annotations.destructiveHint).toBe(false);
    }
  });

  it("never derives destructiveHint from `mutating`", () => {
    // The concrete divergence in the live catalog: `pools__launch_preview` is
    // `mutating: true` (it records a priced launch) and `local_write` (it signs
    // nothing and broadcasts nothing). A `mutating`-derived hint would fire a
    // client's irreversible-action prompt on it, and on the two launch-request
    // forms that only ask the user a question.
    const diverging = ["pools__launch_preview", "pools__launch_request_form"];
    for (const name of diverging) {
      const manifest = getProtocolManifest(
        inventory.find((t) => t.publicName === name)?.toolId ?? "",
      );
      expect(manifest?.mutating).toBe(true);
      expect(manifest?.actionKind).toBe("local_write");
      const tool = inventory.find((t) => t.publicName === name);
      expect(tool?.annotations.destructiveHint).toBe(false);
      expect(tool?.annotations.readOnlyHint).toBe(false);
    }
  });

  it("does not mark an approval-prepare tool destructive", () => {
    // `WalletSendPrepare` writes a durable intent and signs nothing; its
    // `WalletSendConfirm` sibling is the one that broadcasts. Only the sibling
    // is destructive.
    const prepare = inventory.find((t) => t.publicName === "WalletSendPrepare");
    const confirm = inventory.find((t) => t.publicName === "WalletSendConfirm");
    expect(getToolDef("WalletSendPrepare")?.actionKind).toBe("approval_prepare");
    expect(prepare?.annotations.destructiveHint).toBe(false);
    expect(prepare?.annotations.readOnlyHint).toBe(false);
    expect(confirm?.annotations.destructiveHint).toBe(true);
  });
});

describe("the hot set is exactly the internal tools plus vex_ToolSearch (O20)", () => {
  it("marks alwaysLoad on every internal tool and no protocol tool", () => {
    const loaded = new Set(studioAlwaysLoadNames());
    for (const tool of inventory) {
      expect(loaded.has(tool.publicName)).toBe(tool.kind === "internal");
    }
    expect(loaded.has(EXPORTED_TOOL_SEARCH_PUBLIC_NAME)).toBe(true);
    expect(loaded.has(EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME)).toBe(true);
  });

  it("marks the MCP-only contract reader always-loaded", () => {
    // It is useless deferred: a client reaches for it precisely when a
    // description it already holds arrived cut.
    expect(studioAlwaysLoadNames()).toContain(EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME);
  });

  it("keeps the hot set small enough to be a hot set", () => {
    // The whole point of O20 is that a client loading tool descriptions eagerly
    // does not pull 155 of them into a context window before the agent asked
    // for anything. A hot set that grew past the internal registry would defeat
    // that silently.
    expect(studioAlwaysLoadNames().length).toBeLessThan(inventory.length / 2);
  });
});

/**
 * O23: the first 2000 bytes carry the risk class and the preconditions.
 *
 * Implemented as a STRUCTURAL lint over the inventory rather than a length cap
 * on the text. Nothing is cut at the source: descriptions run to 6.5 KB and the
 * whole string is exported. What the budget buys is a guarantee about the HEAD -
 * a client or a model that reads only the first 2000 bytes still learns whether
 * the call spends money and how it has to be called.
 */
describe("the description budget (O23)", () => {
  /**
   * Consequence markers: phrases that tell the caller, in the head of the
   * description, that this call SENDS A TRANSACTION or spends funds.
   *
   * The list is deliberately concrete rather than a synonym net. Each entry is
   * a phrase the catalog actually uses to state the on-chain effect: it either
   * names the spend outright, or names the transaction the call broadcasts, or
   * names the approval gate the spend goes through. A description that says
   * only what a tool is FOR, with none of these in its first 2000 bytes, is the
   * defect this lint exists to catch.
   */
  const CONSEQUENCE =
    /SPENDS|signs and broadcasts|broadcasts|broadcasting|FOR REAL|IRREVERSIBLE|transaction hash|Approval-gated|ONE transaction/i;
  /**
   * Precondition and usage markers: the description tells the caller WHEN to
   * reach for the tool or WHAT it has to send, rather than only what it is.
   */
  const PRECONDITION = /\bUse\b|\bCall\b|\bPass\b|\bStart here\b|\brequired\b|\bbefore\b|\bmust\b|\bneeds?\b/i;

  it("exports the WHOLE description, never a cut one", () => {
    for (const tool of inventory) {
      expect(tool.description.trim().length).toBeGreaterThan(0);
      // A source-side cut would show up as a trailing ellipsis, which is the
      // one shape forbidden outright.
      expect(tool.description.endsWith("...")).toBe(false);
      expect(tool.description.endsWith("…")).toBe(false);
    }
  });

  it("states the irreversible consequence inside the first 2000 bytes", () => {
    const silent = inventory
      .filter((t) => t.annotations.destructiveHint)
      .filter((t) => !CONSEQUENCE.test(head(t.description, 2000)))
      .map((t) => t.publicName);
    expect(silent).toEqual([]);
  });

  it("states a precondition or a usage rule inside the first 2000 bytes", () => {
    const silent = inventory
      .filter((t) => !PRECONDITION.test(head(t.description, 2000)))
      .map((t) => t.publicName);
    expect(silent).toEqual([]);
  });

  it("records the measured head budget so a regression is visible", () => {
    // Not a cap on the text: a report. If most descriptions ever grew past the
    // budget the guarantee above would be carrying the whole surface, and that
    // is worth noticing in review rather than discovering in a client.
    const over = inventory.filter((t) => byteLength(t.description) > 2000);
    expect(over.length).toBeLessThan(inventory.length / 2);
  });

  /**
   * THE WHOLE-TEXT BOUND on the hot set, enumerated tool by tool.
   *
   * MEASURED (clarity review 2026-09-03, prompt 4): Claude Code cuts an MCP
   * tool description at exactly 2048 characters and appends a marker, and six
   * always-loaded descriptions were arriving at the model mid-word with their
   * RETURNS sections gone. The head lints above prove the SAFETY facts lead;
   * this one proves nothing is lost at all, which is the property the owner
   * decree on silent cutting actually asks for: the budget belongs to the
   * consumer, so Vex authors to it instead of shipping text to be cut.
   *
   * A table, one row per hot-set tool, because the useful failure names the
   * tool and its length rather than reporting that "something" is too long.
   */
  it.each(
    buildStudioInventory()
      .filter((tool) => tool.alwaysLoad)
      .map((tool) => [tool.publicName, [...tool.description].length, tool.description] as const),
  )(
    "%s fits the always-loaded description bound whole (%i characters)",
    (_name, _characters, description) => {
      expect(boundReadings(description).fitsInCharacters).toBe(true);
    },
  );

  /**
   * THE SAME BOUND, COUNTED IN BYTES.
   *
   * The measured cut is by CHARACTERS - four independent counts on four tools
   * landed on 2048 characters of the original string, which is why the bound
   * above is the contract. This is the second reading of it, and it is not
   * ceremony: the hot set is NO LONGER pure ASCII. `SwapExecute` and `SwapQuote`
   * each carry a U+2192 arrow, so they sit at 2045 characters but 2047 UTF-8
   * bytes - ONE byte under the same number. A description is authored in
   * characters and travels as bytes, so an edit that swaps two ASCII characters
   * for one arrow keeps the character count falling and pushes the byte count
   * over, and any client that counts the encoded string rather than the code
   * points would cut a tool contract mid-word with nothing here noticing.
   *
   * Asserting both readings costs one comparison and closes that gap whichever
   * way a client counts.
   */
  it.each(
    buildStudioInventory()
      .filter((tool) => tool.alwaysLoad)
      .map((tool) => [tool.publicName, byteLength(tool.description), tool.description] as const),
  )("%s fits the same bound in UTF-8 bytes (%i bytes)", (_name, _bytes, description) => {
    expect(boundReadings(description).fitsInBytes).toBe(true);
  });

  it("the BYTE reading is the one that catches a non-ASCII description at the threshold", () => {
    // The live hot set cannot prove this on its own: its longest description is
    // 2047 bytes over 2046 characters, so replacing the byte count above with a
    // second character count would keep the suite green and the gap would be
    // back. This is the case that only the byte reading can fail - a synthetic
    // description one code point UNDER the bound whose UTF-8 encoding is two
    // bytes OVER it, which is what an edit that trades two ASCII characters for
    // one arrow produces.
    const synthetic = `${"a".repeat(ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS - 1)}\u2192`;
    const readings = boundReadings(synthetic);

    expect(readings.characters).toBe(ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS);
    expect(readings.bytes).toBe(ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS + 2);
    // The character lint accepts it, so it is not the one holding the line.
    expect(readings.fitsInCharacters).toBe(true);
    // The byte lint refuses it. If `boundReadings.bytes` ever counted code
    // points, this is the assertion that goes red.
    expect(readings.fitsInBytes).toBe(false);
  });

  it("keeps the byte reading honest: the hot set is not pure ASCII", () => {
    // If every description were ASCII the byte lint above would be a copy of
    // the character one. It is not - measured 2026-09-04, `SwapExecute` and
    // `SwapQuote` carry a U+2192 arrow. The assertion is on the COUNT rather
    // than on those two names, so an arrow moving to another tool is not a
    // failure; only a hot set that went back to pure ASCII is, and the honest
    // answer to that failure is to delete this case, not to add a character.
    const differing = buildStudioInventory()
      .filter((tool) => tool.alwaysLoad)
      .filter((tool) => {
        const readings = boundReadings(tool.description);
        return readings.bytes !== readings.characters;
      });
    expect(differing.length).toBeGreaterThan(0);
  });

  it("bounds every always-loaded description and no protocol one", () => {
    // The bound is the HOT SET's, deliberately: a protocol description is
    // loaded through a client's own tool-search step, which does not re-cut it.
    const overLoaded = inventory
      .filter((t) => t.alwaysLoad)
      .filter((t) => [...t.description].length > ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS)
      .map((t) => t.publicName);
    expect(overLoaded).toEqual([]);
    expect(ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS).toBe(2048);
  });
});

describe("the list is identical across projects and environments", () => {
  const ENV_KEYS = [...new Set(
    inventory.map((t) => t.requiresEnv).filter((e): e is string => e !== undefined),
  )];
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  it("declares at least one env-gated tool, so this suite is not vacuous", () => {
    expect(ENV_KEYS.length).toBeGreaterThan(0);
  });

  it("returns the same list with every gated variable unset", () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    expect(buildStudioInventory().map((t) => t.publicName)).toEqual(
      inventory.map((t) => t.publicName),
    );
  });

  it("returns the same list with every gated variable set", () => {
    for (const key of ENV_KEYS) setEnv(key, "set-for-this-test");
    expect(buildStudioInventory().map((t) => t.publicName)).toEqual(
      inventory.map((t) => t.publicName),
    );
  });

  it("carries requiresEnv as metadata, not as a filter", () => {
    // The tool stays listed; the variable travels as metadata so a client can
    // explain the refusal it will get, and the call-time answer names the same
    // variable (`mcp/availability.ts`).
    const gated = inventory.filter((t) => t.requiresEnv !== undefined);
    expect(gated.length).toBeGreaterThan(0);
    for (const tool of gated) expect(typeof tool.requiresEnv).toBe("string");
  });

  it("takes no project, permission or client input at all", () => {
    // The structural version of the same promise: the builder's signature has
    // no parameter to vary, so there is nothing a connection could pass it.
    expect(buildStudioInventory).toHaveLength(0);
  });

  it("returns an equal list on every call", () => {
    const again = buildStudioInventory();
    expect(again.map((t) => t.publicName)).toEqual(inventory.map((t) => t.publicName));
    expect(again.map((t) => t.title)).toEqual(inventory.map((t) => t.title));
  });

  /**
   * The SDK's `fromJsonSchema` dispatches on `$schema`: absent or 2020-12
   * selects the default Ajv2020 engine, 2019-09 and draft-07/06 select older
   * ones, and ANYTHING ELSE throws a plain `Error` at validator construction -
   * which would happen inside the server factory, on a connection, for one
   * tool, and would take the whole connection down. Vex schemas declare no
   * dialect, and this pins that so a hand-written schema cannot introduce one.
   */
  it("no exported input schema declares a JSON Schema dialect", () => {
    const offenders: string[] = [];
    for (const tool of buildStudioInventory()) {
      const declared = Reflect.get(tool.inputSchema, "$schema");
      if (declared === undefined) continue;
      if (
        declared === "https://json-schema.org/draft/2020-12/schema"
        || declared === "http://json-schema.org/draft/2020-12/schema"
      ) {
        continue;
      }
      offenders.push(`${tool.publicName}: ${String(declared)}`);
    }
    expect(offenders).toEqual([]);
  });
});
