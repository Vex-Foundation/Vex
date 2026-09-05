/**
 * THE VERSIONED NOTES, AND THE TAGS THAT COME FROM THEM.
 *
 * The section is the first thing an agent reads after an update, and the tags it
 * produces are the only way a reader can tell WHICH part of a long file moved.
 * Both are worth pinning: a hand-written tag would outlive its entry, and an
 * entry with a subject nothing renders would announce a change no reader can
 * find.
 *
 * Pure data, no DB, no network.
 */

import { describe, it, expect } from "vitest";

import {
  STUDIO_CHANGELOG,
  STUDIO_CHANGELOG_VERSION_LIMIT,
  studioChangelogSummary,
  studioChangelogTag,
  studioChangelogVersions,
  studioChangelogWindow,
  studioTaggedHeading,
  type StudioChangelogEntry,
} from "@vex-agent/studio/instructions/changelog.js";
import { renderStudioManagedBody } from "@vex-agent/studio/installer/render/managed-block.js";
import { renderStudioVexGuideBody } from "@vex-agent/studio/installer/render/vex-guide.js";
import { getAdvertisedProtocolNavigation } from "@vex-agent/tools/protocols/descriptions.js";

import { STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT } from "./render-fixtures.js";

const entry = (over: Partial<StudioChangelogEntry>): StudioChangelogEntry => ({
  version: "1.0",
  kind: "added",
  target: "rule",
  subject: "Subject",
  text: "text",
  ...over,
});

/**
 * The two managed documents, concatenated: what a reader who followed
 * `AGENTS.md`'s "Read these on start" section actually has in front of them.
 */
function renderedDocuments(): string {
  return [
    renderStudioManagedBody(STUDIO_TEST_BRIEF),
    renderStudioVexGuideBody(STUDIO_TEST_BRIEF, STUDIO_TEST_ENVIRONMENT),
  ].join("\n\n");
}

describe("the shipped change log", () => {
  it("is newest first, so the window keeps the newest versions", () => {
    const versions = studioChangelogVersions();
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.length).toBeLessThanOrEqual(STUDIO_CHANGELOG_VERSION_LIMIT);
    expect(versions[0]).toBe(STUDIO_CHANGELOG[0]?.version);
  });

  it("bounds by VERSION, not by entry, so one busy release cannot evict the rest", () => {
    // The whole reason the bound is on versions: a release with twenty notes
    // would otherwise push every earlier release out of a reader's view.
    const many: StudioChangelogEntry[] = [];
    for (let v = 0; v < STUDIO_CHANGELOG_VERSION_LIMIT + 3; v += 1) {
      for (let n = 0; n < 5; n += 1) {
        many.push(entry({ version: `9.${String(v)}`, subject: `s${String(v)}-${String(n)}` }));
      }
    }
    const versions = studioChangelogVersions(many);
    expect(versions).toHaveLength(STUDIO_CHANGELOG_VERSION_LIMIT);
    expect(versions[0]).toBe("9.0");
    expect(studioChangelogWindow(many)).toHaveLength(STUDIO_CHANGELOG_VERSION_LIMIT * 5);
  });

  it("tags a heading from the NEWEST entry that names it", () => {
    const entries = [
      entry({ version: "2.0", kind: "changed", subject: "Thing" }),
      entry({ version: "1.0", kind: "added", subject: "Thing" }),
    ];
    expect(studioChangelogTag("Thing", entries)).toBe("Changed in Vex 2.0");
  });

  it("does NOT tag a heading from a `removed` entry", () => {
    // The thing it names is gone; there is no heading left to label.
    const entries = [entry({ kind: "removed", subject: "GoneTool" })];
    expect(studioChangelogTag("GoneTool", entries)).toBeNull();
    expect(studioTaggedHeading("## GoneTool", "GoneTool")).toBe("## GoneTool");
  });

  it("leaves an untouched heading alone", () => {
    expect(studioTaggedHeading("## Nothing", "a subject with no entry"))
      .toBe("## Nothing");
  });

  it("summarizes a version by kind for the installer's own line", () => {
    const entries = [
      entry({ version: "0.9.5", kind: "added", subject: "a" }),
      entry({ version: "0.9.5", kind: "added", subject: "b" }),
      entry({ version: "0.9.5", kind: "changed", subject: "c" }),
      entry({ version: "0.9.4", kind: "removed", subject: "d" }),
    ];
    expect(studioChangelogSummary("0.9.5", entries)).toBe("Vex 0.9.5: 2 added, 1 changed");
    expect(studioChangelogSummary("0.9.4", entries)).toBe("Vex 0.9.4: 1 removed");
    // A version with no notes says nothing rather than "0 added, 0 changed".
    expect(studioChangelogSummary("0.9.3", entries)).toBeNull();
  });

  it("names only subjects the two managed documents can actually show the reader", () => {
    // An entry whose subject matches nothing announces a change no reader can
    // find. Section subjects must appear as headings; protocol subjects must be
    // namespaces the server advertises; tool subjects are named in the text.
    //
    // BOTH DOCUMENTS, since the 2026-09-04 split: the notes live in
    // `.vex/vex-guide.md` and the sections they name are spread across it and
    // `AGENTS.md`, so a subject satisfied by either file is findable by the
    // reader the notes address - who is told to read both.
    const body = renderedDocuments();
    const namespaces = new Set(
      getAdvertisedProtocolNavigation().map((navigation) => navigation.namespace as string),
    );
    for (const note of STUDIO_CHANGELOG) {
      if (note.target === "protocol") {
        expect(namespaces, `${note.subject} must be an advertised namespace`)
          .toContain(note.subject);
      } else {
        expect(body, `${note.subject} must appear in the rendered block`)
          .toContain(note.subject);
      }
    }
  });

  it("puts its tags beside the headings it named", () => {
    const body = renderedDocuments();
    for (const note of STUDIO_CHANGELOG) {
      if (note.kind === "removed" || note.target === "tool") continue;
      const tag = studioChangelogTag(note.subject);
      expect(tag).not.toBeNull();
      expect(body, `${note.subject} must carry ${String(tag)}`)
        .toContain(`## ${note.subject} (${String(tag)})`);
    }
  });
});
