/**
 * THE ICON STAMP, and the nsfw gate that lives inside it.
 *
 * `hydrate.ts` reads `cmsProfile.iconId` off the raw batch row and writes it
 * into the persisted board. Two properties are worth a test rather than a
 * comment:
 *
 *  - THE NSFW GATE IS STRUCTURAL. A profile the provider flagged never yields a
 *    handle, so a flagged id is not in the durable document at all. That is why
 *    there is nothing to test further down the path: the main-process icon
 *    service and the IPC channel cannot be asked for a flagged id, because no
 *    reader anywhere holds one. Move this decision to the renderer or the
 *    fetcher and that guarantee is gone - which is exactly what the first test
 *    below would catch.
 *  - THE HANDLE IS VALIDATED AT THE STAMP. The provider's field is untrusted
 *    text like any other issuer-adjacent value, so a handle that does not match
 *    the board contract's character class is dropped here rather than written
 *    into a durable row for a later boundary to refuse.
 *
 * MEASURED SHAPE. The row literals below mirror the live v8 batch rows archived
 * during the board v2 probes: `cmsProfile` is a sibling block on the pair row,
 * carrying `iconId` and an optional `nsfw` flag.
 */

import { describe, expect, it } from "vitest";
import { boardIconIdFromRow } from "@vex-agent/tools/internal/board/hydrate.js";
import { boardDescriptionFromRow } from "@vex-agent/tools/internal/board/hydrate-row.js";

/** A raw batch row shaped the way the live channel sends one. */
function rowWithProfile(profile: unknown): unknown {
  return {
    chainId: "base",
    pairAddress: "0xaaa111",
    baseToken: { symbol: "PEPE", name: "Pepe" },
    cmsProfile: profile,
  };
}

describe("the board icon stamp", () => {
  it("takes the base token's icon handle from a profiled row", () => {
    expect(boardIconIdFromRow(rowWithProfile({ iconId: "abcd1234" }))).toBe(
      "abcd1234",
    );
  });

  it("REFUSES the handle when the provider flagged the profile nsfw", () => {
    // The whole gate. Flagged issuer artwork is never fetched and never
    // rendered, and the way that is guaranteed is that the handle does not
    // survive compose time. A board written from this row carries null, so no
    // later consumer can ask for these bytes.
    expect(
      boardIconIdFromRow(rowWithProfile({ iconId: "abcd1234", nsfw: true })),
    ).toBeNull();
  });

  it("keeps the handle when the flag is present and false, or absent", () => {
    // `nsfw: false` is the provider saying it looked and found nothing, which
    // is not a reason to hide a logo. Only an explicit `true` gates.
    expect(
      boardIconIdFromRow(rowWithProfile({ iconId: "abcd1234", nsfw: false })),
    ).toBe("abcd1234");
    expect(
      boardIconIdFromRow(rowWithProfile({ iconId: "abcd1234", nsfw: null })),
    ).toBe("abcd1234");
  });

  it("does not let a truthy non-boolean flag stand in for the gate either way", () => {
    // Strict `=== true`, so a provider sending a string never accidentally
    // gates - and, more importantly, the gate cannot be dodged by sending
    // something truthy-but-not-true.
    expect(
      boardIconIdFromRow(rowWithProfile({ iconId: "abcd1234", nsfw: "true" })),
    ).toBe("abcd1234");
  });

  it("answers null for a row with no profile at all, which is the common case", () => {
    // Measured: roughly half of solana pairs carry no `cmsProfile`. Null here
    // is an ordinary fact about the token, not a failure to read one.
    expect(boardIconIdFromRow({ chainId: "solana", pairAddress: "abc" })).toBeNull();
    expect(boardIconIdFromRow(rowWithProfile(null))).toBeNull();
    expect(boardIconIdFromRow(rowWithProfile(undefined))).toBeNull();
  });

  it("answers null rather than throwing for anything that is not a row", () => {
    // An unreadable icon reference must never be able to refuse a board of
    // real market figures.
    for (const notARow of [null, undefined, 42, "row", [], true]) {
      expect(boardIconIdFromRow(notARow)).toBeNull();
    }
  });

  it("drops a handle that is not a string", () => {
    expect(boardIconIdFromRow(rowWithProfile({ iconId: 1234 }))).toBeNull();
    expect(boardIconIdFromRow(rowWithProfile({ iconId: null }))).toBeNull();
    expect(boardIconIdFromRow(rowWithProfile({ iconId: { id: "abcd" } }))).toBeNull();
  });

  it.each([
    ["a path separator", "abc/def"],
    ["a parent-directory hop", "../secrets"],
    ["a dot", "icon.png"],
    ["an absolute URL", "https://evil.example/icon"],
    ["a query string", "abcd?width=99999"],
    ["whitespace", "ab cd"],
    ["one character under the minimum", "abc"],
    ["one character over the maximum", "a".repeat(129)],
    ["the empty string", ""],
  ])("drops a handle carrying %s", (_label, iconId) => {
    // Validated HERE, at the stamp, so a hostile handle never becomes a
    // durable row that some later boundary has to refuse.
    expect(boardIconIdFromRow(rowWithProfile({ iconId }))).toBeNull();
  });

  it("accepts the character class the board contract publishes, at both bounds", () => {
    expect(boardIconIdFromRow(rowWithProfile({ iconId: "abcd" }))).toBe("abcd");
    const longest = "a".repeat(128);
    expect(boardIconIdFromRow(rowWithProfile({ iconId: longest }))).toBe(longest);
    expect(boardIconIdFromRow(rowWithProfile({ iconId: "A-b_9Z" }))).toBe("A-b_9Z");
  });
});


/**
 * The description stamp, the icon stamp's sibling on the same provider block.
 *
 * The literal below is the REAL blurb the live provider served for VEX on
 * robinhood, quoted from `board-v4-probes/description-vex.json` (546 code
 * points, `cmsProfile.description`, nsfw false). It is here so the table is
 * driven by a shape the provider actually sends rather than by an invented one.
 */
const LIVE_VEX_DESCRIPTION =
  "VEX is a self custodial AI agent runtime for onchain finance. AI proposes "
  + "strategies, but VEX controls what actually executes through wallet "
  + "permissions, mission rules, position limits, protocol checks, and local "
  + "signing. Every action and outcome is recorded through AgentScan, creating "
  + "a complete and verifiable trading history that anyone can inspect. Users "
  + "can build agents, deploy strategies, and prove real performance without "
  + "giving up control of their assets. Accessible. Verifiable. Tradable. The "
  + "AI agent you can trust with your capital.";

describe("the board description stamp", () => {
  it("carries the provider's real blurb, whole", () => {
    expect(
      boardDescriptionFromRow(
        rowWithProfile({ iconId: "abcd1234", description: LIVE_VEX_DESCRIPTION, nsfw: false }),
      ),
    ).toBe(LIVE_VEX_DESCRIPTION);
  });

  it("REFUSES the blurb when the provider flagged the profile nsfw", () => {
    // Same gate as the artwork, and for the same reason: a flagged profile is
    // a profile this board carries NOTHING from, picture or prose.
    expect(
      boardDescriptionFromRow(
        rowWithProfile({ description: LIVE_VEX_DESCRIPTION, nsfw: true }),
      ),
    ).toBeNull();
  });

  it("keeps the blurb when the flag is false, absent, or a truthy non-boolean", () => {
    // Strict `=== true`, exactly as the icon gate is, so the gate can neither
    // fire by accident nor be dodged with something truthy-but-not-true.
    for (const nsfw of [false, null, undefined, "true"]) {
      expect(
        boardDescriptionFromRow(rowWithProfile({ description: "pistacio", nsfw })),
      ).toBe("pistacio");
    }
  });

  it.each([
    ["no profile block at all", { chainId: "solana", pairAddress: "abc" }],
    ["a null profile", rowWithProfile(null)],
    ["a profile with no description key", rowWithProfile({ iconId: "abcd1234" })],
    ["a non-string description", rowWithProfile({ description: 42 })],
    ["a null description", rowWithProfile({ description: null })],
    ["a row that is not an object", "not a row"],
  ])("answers null for %s, and never throws", (_label, row) => {
    // Measured live: WETH on ethereum carries `cmsProfile` with `iconId` and
    // `nsfw` and NO description key at all, so this is the common case rather
    // than an error case.
    expect(boardDescriptionFromRow(row)).toBeNull();
  });

  it("DROPS a blurb carrying a forbidden code point rather than cleaning it", () => {
    // Built with `fromCodePoint`: a bidi override pasted as a literal is
    // invisible to a reviewer. A cleaned blurb would be a sentence the project
    // did not write, so the honest answer is no blurb.
    const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
    const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
    for (const forbidden of [RIGHT_TO_LEFT_OVERRIDE, ZERO_WIDTH_SPACE, "\u0000"]) {
      expect(
        boardDescriptionFromRow(rowWithProfile({ description: `VEX${forbidden}runtime` })),
      ).toBeNull();
    }
  });

  it("allows the line breaks a CMS blurb really carries", () => {
    const twoParagraphs = "VEX is a self custodial agent runtime.\n\nIt signs locally.";
    expect(
      boardDescriptionFromRow(rowWithProfile({ description: twoParagraphs })),
    ).toBe(twoParagraphs);
  });

  it("accepts 1000 code points and DROPS 1001, rather than cutting one", () => {
    // The bound is sized from the live distribution (VEX served 546) AND from
    // the document budget: this is the one board string the model cannot
    // shorten, so a bigger ceiling would let provider copy refuse the agent's
    // work. An over-long blurb costs the reader a blurb, never the board.
    const atBound = "a".repeat(1000);
    expect(boardDescriptionFromRow(rowWithProfile({ description: atBound }))).toBe(atBound);
    expect(
      boardDescriptionFromRow(rowWithProfile({ description: "a".repeat(1001) })),
    ).toBeNull();
  });

  it("counts code points, so an emoji-dense blurb is measured as the reader sees it", () => {
    const emoji = "\u{1F680}".repeat(1000);
    expect(boardDescriptionFromRow(rowWithProfile({ description: emoji }))).toBe(emoji);
  });

  it("refuses the empty string rather than storing a blurb that says nothing", () => {
    expect(boardDescriptionFromRow(rowWithProfile({ description: "" }))).toBeNull();
  });
});
