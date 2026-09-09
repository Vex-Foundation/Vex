import { describe, expect, it } from "vitest";

import {
  inspectStudioFencedDocument,
  inspectStudioManagedBlock,
  mergeStudioFencedDocument,
  mergeStudioManagedBlock,
  removeStudioManagedBlock,
  renderStudioFencedDocument,
  renderStudioManagedBlock,
} from "@vex-agent/studio/installer/render/managed-block.js";
import {
  STUDIO_CLAUDE_MD_IMPORTS,
  claudeMdMissingStudioImports,
  mergeClaudeMdImports,
  removeClaudeMdImports,
} from "@vex-agent/studio/installer/render/claude-md.js";
import { STUDIO_TEST_BRIEF } from "./render-fixtures.js";

describe("managed document boundary regressions", () => {
  it("treats inline delimiter examples as user text and preserves them", () => {
    const surrounding = "Example: <!-- vex:studio:begin hash=abc --> and <!-- vex:studio:end -->\n";
    expect(inspectStudioFencedDocument(surrounding, "body")).toEqual({ kind: "absent" });
    const merged = mergeStudioFencedDocument(surrounding, "body", "0.2.7", { overwriteDrift: false });
    expect(merged.status).toBe("rendered");
    if (merged.status !== "rendered") throw new Error("expected rendered");
    expect(removeStudioManagedBlock(merged.text)).toEqual({ status: "rendered", text: surrounding });
  });

  it("keeps marker-like project names intact and Repair idempotent", () => {
    const brief = { ...STUDIO_TEST_BRIEF, projectName: "test <!-- vex:studio:end -->" };
    const fresh = renderStudioManagedBlock(brief);
    expect(inspectStudioManagedBlock(fresh, brief)).toEqual({ kind: "intact", upToDate: true });
    const edited = fresh.replace("This repository is connected", "This repository WAS connected");
    const repaired = mergeStudioManagedBlock(edited, brief, { overwriteDrift: true });
    expect(repaired).toEqual({ status: "rendered", text: fresh });
    if (repaired.status !== "rendered") throw new Error("expected rendered");
    expect(mergeStudioManagedBlock(repaired.text, brief, { overwriteDrift: true }))
      .toEqual({ status: "unchanged" });
  });

  it.each(["second block", "second begin", "second end"])("refuses %s by name even during Repair", (variant) => {
    const block = renderStudioFencedDocument("body", "0.2.7");
    const duplicate = variant === "second block" ? block + block
      : variant === "second begin" ? "<!-- vex:studio:begin hash=abc -->\n" + block
        : block + "<!-- vex:studio:end -->\n";
    expect(inspectStudioFencedDocument(duplicate, "body")).toMatchObject({ kind: "malformed" });
    for (const result of [
      mergeStudioFencedDocument(duplicate, "body", "0.2.7", { overwriteDrift: true }),
      removeStudioManagedBlock(duplicate),
    ]) {
      expect(result).toMatchObject({ status: "refused", reason: "malformed_managed_block" });
      if (result.status === "refused") expect(result.detail).toContain("duplicate_managed_block");
    }
  });

  it("accepts untouched CRLF content and preserves surrounding bytes through refresh and removal", () => {
    const before = "# User\r\n  trailing spaces  \r\n";
    const after = "\r\nUser suffix\r\n";
    const block = renderStudioFencedDocument("first\nsecond", "0.2.7").replace(/\n/g, "\r\n");
    const existing = before + block + after;
    expect(inspectStudioFencedDocument(existing, "first\nsecond"))
      .toEqual({ kind: "intact", upToDate: true });
    expect(mergeStudioFencedDocument(existing, "first\nsecond", "0.2.7", { overwriteDrift: false }))
      .toEqual({ status: "unchanged" });
    const refresh = mergeStudioFencedDocument(existing, "updated\nbody", "0.2.7", { overwriteDrift: false });
    expect(refresh.status).toBe("rendered");
    if (refresh.status !== "rendered") throw new Error("expected rendered");
    expect(refresh.text.startsWith(before)).toBe(true);
    expect(refresh.text.endsWith(after)).toBe(true);
    expect(inspectStudioFencedDocument(refresh.text, "updated\nbody"))
      .toEqual({ kind: "intact", upToDate: true });
    expect(removeStudioManagedBlock(refresh.text)).toEqual({ status: "rendered", text: before + after });
    expect(inspectStudioFencedDocument(existing.replace("second", "edited"), "first\nsecond").kind)
      .toBe("drifted");
  });
});

describe("active Claude imports", () => {
  it("preserves fenced imports inside a nested list and appends active imports", () => {
    const example = "- Example:\n    ```md\n    @AGENTS.md\n    @.vex/vex-guide.md\n    ```\n";
    expect(claudeMdMissingStudioImports(example)).toEqual(STUDIO_CLAUDE_MD_IMPORTS);
    expect(removeClaudeMdImports(example)).toEqual({ status: "unchanged" });
    const merged = mergeClaudeMdImports(example);
    expect(merged.status).toBe("rendered");
    if (merged.status !== "rendered") throw new Error("expected rendered");
    expect(claudeMdMissingStudioImports(merged.text)).toEqual([]);
    expect(removeClaudeMdImports(merged.text)).toEqual({ status: "rendered", text: example });
  });

  it("refuses to append imports inside an unclosed example", () => {
    const example = "# Example\n```md\n@AGENTS.md\n";
    expect(mergeClaudeMdImports(example)).toMatchObject({
      status: "refused", reason: "malformed_markdown_fence",
    });
    expect(removeClaudeMdImports(example)).toEqual({ status: "unchanged" });
  });

  it.each(["```md", "~~~~markdown", "   ```"])("ignores and preserves examples in %s fences", (opening) => {
    const marker = opening.trim().startsWith("~") ? "~~~~" : "```";
    const example = ["# Examples", opening, ...STUDIO_CLAUDE_MD_IMPORTS, marker, ""].join("\r\n");
    expect(claudeMdMissingStudioImports(example)).toEqual(STUDIO_CLAUDE_MD_IMPORTS);
    expect(removeClaudeMdImports(example)).toEqual({ status: "unchanged" });
    const merged = mergeClaudeMdImports(example);
    expect(merged.status).toBe("rendered");
    if (merged.status !== "rendered") throw new Error("expected rendered");
    expect(merged.text.startsWith(example)).toBe(true);
    expect(claudeMdMissingStudioImports(merged.text)).toEqual([]);
    expect(removeClaudeMdImports(merged.text)).toEqual({ status: "rendered", text: example });
  });

  it("does not close a fence on a shorter or different marker", () => {
    const example = ["````md", "```", "~~~", ...STUDIO_CLAUDE_MD_IMPORTS, "````", ""].join("\n");
    expect(claudeMdMissingStudioImports(example)).toEqual(STUDIO_CLAUDE_MD_IMPORTS);
    expect(removeClaudeMdImports(example)).toEqual({ status: "unchanged" });
  });
});
