/**
 * `.vex/vex-guide.md`: NOTHING WAS LOST IN THE SPLIT, and the guide is managed
 * exactly as the block is.
 *
 * The risk this file exists for is not formatting. On 2026-09-04 one document
 * became two because Codex loads `AGENTS.md` under `project_doc_max_bytes`
 * (32,768 by default, `agents-colab/codex/codex-rs/config/defaults.toml:8`) as
 * a TOTAL across the root-to-cwd chain and TRUNCATES the file that crosses it
 * (`codex-rs/core/src/agents_md.rs`). A split done wrong loses a section
 * silently, which is the same failure with a nicer name - so the first suite
 * below proves, paragraph by paragraph, that the union of the two documents is
 * everything the single block composed, that no section is in BOTH, and that
 * the only text neither document had before is the connective prose the split
 * itself introduced.
 *
 * The second suite is the drift contract, which the guide shares with the block
 * through the same fence machinery: a human edit inside the markers is detected,
 * never silently overwritten, and replaced only by an explicit Repair.
 */

import { describe, it, expect } from "vitest";

import {
  STUDIO_BUG_REPORT_NOTE,
  STUDIO_BUILDING_APPS_NOTE,
  STUDIO_CHANGE_NOTE_LIMIT,
  STUDIO_COMMON_JOBS_NOTE,
  STUDIO_READ_ON_START_NOTE,
  STUDIO_YOUR_POSITION_NOTE,
  boundStudioChangeNotes,
  renderStudioBlockTitle,
  renderStudioHowToWorkWithVexMcp,
  renderStudioProjectIdentity,
  renderStudioThisFileLog,
  renderStudioWhatsNewInVex,
} from "@vex-agent/studio/instructions/project-brief.js";
import { renderStudioProtocolBlocks } from "@vex-agent/studio/instructions/protocol-blocks.js";
import {
  renderStudioManagedBody,
  studioManagedBodyHash,
} from "@vex-agent/studio/installer/render/managed-block.js";
import {
  STUDIO_VEX_GUIDE_PATH,
  inspectStudioVexGuide,
  mergeStudioVexGuide,
  renderStudioVexGuide,
  renderStudioVexGuideBody,
} from "@vex-agent/studio/installer/render/vex-guide.js";
import { removeStudioManagedBlock } from "@vex-agent/studio/installer/render/managed-block.js";

import { STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT } from "./render-fixtures.js";

const block = renderStudioManagedBody(STUDIO_TEST_BRIEF);
const guide = renderStudioVexGuideBody(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT);

function textOf(result: ReturnType<typeof mergeStudioVexGuide>): string {
  if (result.status !== "rendered") {
    throw new Error(`expected rendered bytes, got ${result.status}`);
  }
  return result.text;
}

/**
 * A document's paragraphs, with heading LEVELS normalised.
 *
 * The level is the one thing a section may legitimately gain or lose when it
 * moves between two documents (a `###` under a heading that stayed behind would
 * be an orphan). Its TEXT may not, and neither may anything else, so `#` runs
 * are stripped and every other byte is compared as it is.
 */
function paragraphs(document: string): readonly string[] {
  return document
    .split("\n\n")
    .map((paragraph) => paragraph.trim().replace(/^#+ /gm, ""))
    .filter((paragraph) => paragraph !== "");
}

describe("the split moved every section WHOLE", () => {
  /**
   * THE SINGLE BLOCK, composed from the same parts it was composed from before
   * the split - the eight authored sections plus the title.
   *
   * Rendered from the PARTS rather than replayed from a frozen copy on purpose:
   * a frozen copy would fail on any future rewording, which is a legitimate
   * change reviewed as a golden diff. What must never happen is a section
   * ending up in NEITHER document, or being paraphrased into a shorter one on
   * its way across, and that is exactly what comparing the parts against the
   * union catches.
   */
  const singleBlock = [
    renderStudioBlockTitle(STUDIO_TEST_BRIEF),
    renderStudioWhatsNewInVex(STUDIO_TEST_BRIEF),
    renderStudioThisFileLog(STUDIO_TEST_BRIEF),
    renderStudioProjectIdentity(STUDIO_TEST_BRIEF),
    renderStudioHowToWorkWithVexMcp(STUDIO_TEST_BRIEF),
    STUDIO_COMMON_JOBS_NOTE,
    renderStudioProtocolBlocks(STUDIO_TEST_ENVIRONMENT),
    STUDIO_YOUR_POSITION_NOTE,
    STUDIO_BUILDING_APPS_NOTE,
    STUDIO_BUG_REPORT_NOTE,
  ].join("\n\n");

  const before = paragraphs(singleBlock);
  const after = [...paragraphs(block), ...paragraphs(guide)];

  it("keeps every paragraph the one block had, in one of the two documents", () => {
    const union = new Set(after);
    const lost = before.filter((paragraph) => !union.has(paragraph));
    expect(
      lost,
      `${String(lost.length)} paragraph(s) of the pre-split block are in NEITHER `
        + "AGENTS.md nor .vex/vex-guide.md. Nothing may be dropped or shortened by "
        + "the split; move the whole section instead.",
    ).toEqual([]);
    // Not a vacuous comparison: the block really was a big document.
    expect(before.length).toBeGreaterThan(100);
  });

  it("puts each of them in exactly ONE document, never both", () => {
    const duplicated = before.filter(
      (paragraph) =>
        paragraphs(block).includes(paragraph) && paragraphs(guide).includes(paragraph),
    );
    expect(
      duplicated,
      "a paragraph in both files is a second source of truth for text an agent "
        + "acts on, and the two copies drift the moment one file is regenerated",
    ).toEqual([]);
  });

  it("adds nothing but the connective text the split itself needed", () => {
    // The other direction, so a green run cannot be bought by pasting new prose
    // into the documents: everything in them is either a paragraph the single
    // block already had, or one of the four texts the split introduced.
    const introduced = new Set([
      ...paragraphs(STUDIO_READ_ON_START_NOTE),
      // The two documents' own opening paragraphs and their generated-file
      // footers, which name each file and point at the other.
      ...paragraphs(block).filter((paragraph) =>
        paragraph.startsWith("This repository is connected to Vex")
        || paragraph.startsWith("AGENTS: this section is generated by Vex")),
      ...paragraphs(guide).filter((paragraph) =>
        paragraph.startsWith("Vex guide - project")
        || paragraph.startsWith("The companion to this project's")
        || paragraph.startsWith("AGENTS: this file is generated by Vex")),
      "---",
    ]);
    const known = new Set([...before, ...introduced]);
    expect(after.filter((paragraph) => !known.has(paragraph))).toEqual([]);
  });

  it("carries the Vex notes and the project log together, as one section", () => {
    // They were one section under one heading before the split ("what changed
    // in Vex" and "what changed for this project"), and they moved together:
    // the `### This file` sub-heading still sits directly under the `##` it
    // belonged to, so the guide's opening is byte-identical to the block's.
    expect(guide).toContain(
      `${renderStudioWhatsNewInVex(STUDIO_TEST_BRIEF)}\n\n`
        + renderStudioThisFileLog(STUDIO_TEST_BRIEF),
    );
    expect(guide).toContain("### This file");
  });
});

describe("what the guide carries", () => {
  it("renders the four sections in order, under its own title", () => {
    const order = [
      "# Vex guide - project \"acme-trading\"",
      "## What's new in Vex 0.2.6",
      "### This file",
      "## Protocols available to this project",
      "## Building on Vex MCP",
      "## Reporting Vex bugs (bounty)",
    ];
    const positions = order.map((heading) => guide.indexOf(heading));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("says WHERE the authority is, so the guide is never read as the whole protocol", () => {
    expect(guide).toContain("`AGENTS.md`");
    expect(guide).toContain("READ THIS FILE AT THE START OF A");
  });

  it("tells the agent an app it builds speaks MCP to the SAME server", () => {
    expect(guide).toContain("## Building on Vex MCP");
    expect(guide).toContain("MCP IS the API");
    expect(guide).toContain("`vex-mcp` bridge command");
    expect(guide).toContain("publicName");
  });

  it("says the app inherits every restriction, and that there is NO REST API", () => {
    // The load-bearing half: an agent that believes it can build a thin HTTP
    // wrapper around a wallet has just invented a door around the approval
    // card, the permission snapshot and the vault.
    expect(guide).toContain("INHERITS EVERY RESTRICTION");
    expect(guide).toContain("because there is no other");
    expect(guide).toContain("per-call scope snapshot");
    expect(guide).toContain("approval card");
    expect(guide).toContain("vault-locked signing");
    expect(guide).toContain("NO separate REST endpoint");
    expect(guide).toContain("digest");
  });

  it("ends with a bug-report note that ASKS and never reports on its own", () => {
    expect(guide).toContain("https://github.com/Vex-Foundation/Vex");
    expect(guide).toContain("USDC or");
    expect(guide).toContain("Discord");
    expect(guide).toContain("ASK FIRST, ALWAYS");
    expect(guide).toContain("Never open a report");
    // I-6j, p1.txt lines 71-73. The privacy sentence forbade what every quote
    // necessarily does.
    expect(guide).toContain("Calling a Vex tool is not publishing");
    expect(guide).not.toContain("leaves this machine without");
  });

  it("carries THIS installation's provider keys, not the machine's", () => {
    // The one thing in either document that depends on the installation rather
    // than the project, and the reason the guide's renderers take an
    // environment: a stated one keeps the goldens machine-independent.
    expect(guide).toContain("RETTIWT_API_KEY");
    expect(guide).toContain("JUPITER_API_KEY");
    const other = renderStudioVexGuideBody(STUDIO_TEST_BRIEF, {
      configuredKeys: [],
      missingKeys: ["RETTIWT_API_KEY", "JUPITER_API_KEY"],
    });
    expect(other).not.toBe(guide);
  });

  it("lists change-log entries newest first and declares its own bound", () => {
    expect(guide).toContain(`Vex keeps the last ${String(STUDIO_CHANGE_NOTE_LIMIT)} entries`);
    const newest = guide.indexOf("updated the wallet selection");
    const older = guide.indexOf("added the codex config");
    expect(newest).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(newest);
  });

  it("tells the reader the file does NOT grow across Vex updates", () => {
    // t1 #1 and #2: "nothing else is hidden" had no referent, and the entries
    // sat BELOW a sentence that called them "above".
    expect(guide).toContain("THIS SECTION STAYS BOUNDED");
    expect(guide).toContain("only change-log entries are ever dropped");
    expect(guide).toContain("the change log below");
    expect(guide).toContain("OUTSIDE the markers, which Vex never touches");
    expect(guide).not.toContain("nothing else is hidden");
  });

  it("bounds the change-note list by dropping the OLDEST entries", () => {
    const many = Array.from({ length: STUDIO_CHANGE_NOTE_LIMIT + 4 }, (_, i) => ({
      version: "0.9.9",
      date: "2026-08-25",
      summary: `change ${String(i)}`,
    }));
    const bounded = boundStudioChangeNotes(many);
    expect(bounded).toHaveLength(STUDIO_CHANGE_NOTE_LIMIT);
    expect(bounded[0]?.summary).toBe("change 0");
    expect(bounded.at(-1)?.summary).toBe(`change ${String(STUDIO_CHANGE_NOTE_LIMIT - 1)}`);
  });

  it("says the first render is the first render, not an empty log", () => {
    const first = renderStudioVexGuideBody(
      { ...STUDIO_TEST_BRIEF, changeNotes: [] },
      STUDIO_TEST_ENVIRONMENT,
    );
    expect(first).toContain("initial render for this project");
    expect(first).toContain("Vex 0.2.6");
  });

  it("announces the split itself in the Vex change log", () => {
    // The reader of a regenerated project must be able to see why AGENTS.md
    // suddenly got shorter and where the rest went - the same rule every other
    // agent-visible change follows.
    expect(guide).toContain("Read these on start");
    expect(guide).toContain(STUDIO_VEX_GUIDE_PATH);
  });
});

describe("the guide's fence", () => {
  const installed = textOf(
    mergeStudioVexGuide("", STUDIO_TEST_BRIEF, {
      overwriteDrift: false,
      environment: STUDIO_TEST_ENVIRONMENT,
    }),
  );

  it("records the digest of its own body in the opening marker", () => {
    const document = renderStudioVexGuide(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT);
    const expected = studioManagedBodyHash(guide);
    expect(
      document.startsWith(
        `<!-- vex:studio:begin vex=${STUDIO_TEST_BRIEF.vexVersion} hash=${expected} -->\n`,
      ),
    ).toBe(true);
    expect(document.endsWith("<!-- vex:studio:end -->\n")).toBe(true);
  });

  it("is idempotent: merging an up-to-date file changes nothing", () => {
    expect(
      mergeStudioVexGuide(installed, STUDIO_TEST_BRIEF, {
        overwriteDrift: false,
        environment: STUDIO_TEST_ENVIRONMENT,
      }).status,
    ).toBe("unchanged");
  });

  it("reports an untouched guide as intact and up to date", () => {
    expect(inspectStudioVexGuide(installed, STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT))
      .toEqual({ kind: "intact", upToDate: true });
  });

  it("covers the CHANGE NOTES with the drift hash", () => {
    // The whole point of putting the log inside the markers: editing an entry
    // is drift, exactly like editing a protocol block. The log moved to this
    // file in the split, and its protection moved with it.
    const tampered = installed.replace("added the codex config", "did nothing");
    expect(
      inspectStudioVexGuide(tampered, STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT).kind,
    ).toBe("drifted");
  });

  it("never silently overwrites a drifted guide, and Repair does", () => {
    const edited = installed.replace(
      "MCP IS the API",
      "MCP IS TOTALLY the API",
    );
    expect(
      mergeStudioVexGuide(edited, STUDIO_TEST_BRIEF, {
        overwriteDrift: false,
        environment: STUDIO_TEST_ENVIRONMENT,
      }).status,
    ).toBe("unchanged");

    const repaired = textOf(
      mergeStudioVexGuide(edited, STUDIO_TEST_BRIEF, {
        overwriteDrift: true,
        environment: STUDIO_TEST_ENVIRONMENT,
      }),
    );
    expect(repaired).not.toContain("TOTALLY");
    expect(inspectStudioVexGuide(repaired, STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT))
      .toEqual({ kind: "intact", upToDate: true });
  });

  it("reports a stale guide as intact but NOT up to date when the brief moves", () => {
    const state = inspectStudioVexGuide(
      installed,
      { ...STUDIO_TEST_BRIEF, vexVersion: "0.9.9" },
      STUDIO_TEST_ENVIRONMENT,
    );
    expect(state).toEqual({ kind: "intact", upToDate: false });
  });

  it("comes back out through the same removal the block uses", () => {
    // The teardown path: `.vex/vex-guide.md` is Vex's file, but a user's notes
    // outside the markers are still theirs.
    const withNotes = `# My own notes\n\n${installed}`;
    const removed = removeStudioManagedBlock(withNotes);
    expect(removed.status).toBe("rendered");
    if (removed.status === "rendered") {
      expect(removed.text).toBe("# My own notes\n");
    }
  });
});
