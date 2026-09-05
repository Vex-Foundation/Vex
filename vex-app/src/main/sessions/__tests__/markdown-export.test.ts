import { mkdtemp, mkdir, readFile, readdir, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionMessageDto } from "@shared/schemas/messages.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import {
  defaultSessionMarkdownFilename,
  renderSessionMarkdown,
  writeMarkdownAtomically,
} from "../markdown-export.js";

const dirs: string[] = [];
const SESSION: SessionListItem = {
  id: "00000000-0000-4000-8000-0000000000e1",
  mode: "agent",
  permission: "restricted",
  title: "Research / ANSEM",
  initialGoal: null,
  startedAt: "2026-07-12T10:00:00.000Z",
  endedAt: null,
  missionStatus: null,
  pinnedAt: null,
};

function message(
  overrides: Partial<SessionMessageDto> & Pick<SessionMessageDto, "id" | "role">,
): SessionMessageDto {
  return {
    sessionId: SESSION.id,
    kind: "text",
    content: "",
    createdAt: `2026-07-12T10:0${overrides.id}:00.000Z`,
    toolCallId: null,
    toolName: null,
    toolCalls: null,
    explorerRefs: null,
    reasoning: null,
    durationMs: null,
    success: null,
    displayStatus: null,
    board: null,
    interruptDisposition: null,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("session Markdown export", () => {
  it("renders readable prose and concise tool names in chronological input order", () => {
    const markdown = renderSessionMarkdown(SESSION, [
      message({ id: 1, role: "user", content: "Buy ANSEM." }),
      message({
        id: 2,
        role: "assistant",
        kind: "tool_call",
        content: "I'll verify it first.",
        toolName: "token_find",
        toolCalls: [
          { toolCallId: "private-id", toolName: "token_find", toolArgs: '{"mint":"secret"}' },
        ],
      }),
      message({ id: 3, role: "assistant", content: "Token confirmed." }),
    ]);

    expect(markdown).toContain("# Research / ANSEM");
    expect(markdown).toContain("- Mode: Agent");
    expect(markdown.indexOf("Buy ANSEM.")).toBeLessThan(
      markdown.indexOf("I'll verify it first."),
    );
    expect(markdown).toContain("> Tool: `token_find`");
    expect(markdown).not.toContain("private-id");
    expect(markdown).not.toContain("mint");
  });

  /**
   * The export reads `ToolCallDisplay.toolName`, which the messages mapper
   * already canonicalized. This pins the END of that chain: an exported
   * transcript never shows a human the model's OpenAI-legal wire name.
   */
  it("prints the canonical dotted toolId, never a `__` wire name", () => {
    const markdown = renderSessionMarkdown(SESSION, [
      message({
        id: 2,
        role: "assistant",
        kind: "tool_call",
        content: "Pricing it.",
        toolName: "kyberswap.swap.quote",
        toolCalls: [
          { toolCallId: "c1", toolName: "kyberswap.swap.quote", toolArgs: null },
        ],
      }),
    ]);

    expect(markdown).toContain("> Tool: `kyberswap.swap.quote`");
    expect(markdown).not.toContain("__");
  });

  // DELIBERATE CONTRACT CHANGE (2026-08-28). This case used to pin that EVERY
  // tool result is dropped. Measured cost: the export of the 2026-08-27 refusal
  // loop showed seven `> Tool:` rows and nothing else, so the human could not
  // see that any call had failed. A tool result whose outcome is unambiguously
  // FAILED now contributes one capped, redacted `> Failed:` line (see the
  // sibling suite below). A successful or unknown-outcome result is still
  // omitted whole, which is what this case keeps pinning.
  it("omits system, runtime, compaction, and non-failed tool-result rows and redacts secrets in prose", () => {
    const apiKey = `sk-or-v1-${"a".repeat(32)}`;
    const markdown = renderSessionMarkdown(SESSION, [
      message({ id: 1, role: "system", content: "hidden system prompt" }),
      message({ id: 2, role: "assistant", kind: "runtime_notice", content: "runtime noise" }),
      message({ id: 3, role: "assistant", kind: "compaction", content: "compacted" }),
      message({ id: 4, role: "tool", kind: "tool_result", content: "raw result" }),
      message({
        id: 6,
        role: "tool",
        kind: "tool_result",
        content: "raw success payload",
        success: true,
      }),
      message({ id: 5, role: "user", content: `Use ${apiKey}` }),
    ]);

    expect(markdown).not.toContain("hidden system prompt");
    expect(markdown).not.toContain("runtime noise");
    expect(markdown).not.toContain("compacted");
    // `success: null` is UNKNOWN, never failure.
    expect(markdown).not.toContain("raw result");
    expect(markdown).not.toContain("raw success payload");
    expect(markdown).not.toContain("> Failed:");
    expect(markdown).not.toContain(apiKey);
    expect(markdown).toContain("[redacted]");
  });

  describe("failed tool results", () => {
    it("renders one correlated failure line naming the tool that failed", () => {
      const markdown = renderSessionMarkdown(SESSION, [
        message({
          id: 1,
          role: "assistant",
          kind: "tool_call",
          content: "Checking new pairs.",
          toolCalls: [
            { toolCallId: "call-1", toolName: "dexscreener.pairs.new", toolArgs: "{}" },
          ],
        }),
        message({
          id: 2,
          role: "tool",
          kind: "tool_result",
          toolCallId: "call-1",
          content: 'Parameter "chainIds" was an empty array.',
          success: false,
        }),
      ]);

      expect(markdown).toContain("> Failed: `dexscreener.pairs.new`: Parameter \"chainIds\" was an empty array.");
    });

    it("says nothing for a PENDING result, which is unresolved rather than failed", () => {
      const markdown = renderSessionMarkdown(SESSION, [
        message({
          id: 2,
          role: "tool",
          kind: "tool_result",
          content: "broadcast in flight",
          success: false,
          displayStatus: "pending",
        }),
      ]);

      expect(markdown).not.toContain("> Failed:");
      expect(markdown).not.toContain("broadcast in flight");
    });

    it("reports its own cap instead of cutting silently", () => {
      const long = `x`.repeat(900);
      const markdown = renderSessionMarkdown(SESSION, [
        message({
          id: 2,
          role: "tool",
          kind: "tool_result",
          content: `${long}\nsecond line`,
          success: false,
        }),
      ]);

      expect(markdown).toContain("400 of 900 characters");
      expect(markdown).toContain("first line only");
      expect(markdown).toContain("the full output is in the session view");
      expect(markdown).not.toContain("second line");
    });

    // The COMPLETE output is redacted before the summary is selected. Selecting
    // first would hand the redactor a fragment and let a secret that straddles
    // the cut reach the file intact.
    it("redacts a secret that straddles the summary cap", () => {
      const apiKey = `sk-or-v1-${"b".repeat(32)}`;
      const markdown = renderSessionMarkdown(SESSION, [
        message({
          id: 2,
          role: "tool",
          kind: "tool_result",
          content: `${"y".repeat(390)}${apiKey} trailing`,
          success: false,
        }),
      ]);

      expect(markdown).not.toContain(apiKey);
      expect(markdown).not.toContain(`sk-or-v1-${"b".repeat(10)}`);
    });
  });

  it("quotes persisted assistant reasoning before the prose, redacted like content", () => {
    const apiKey = `sk-or-v1-${"b".repeat(32)}`;
    const markdown = renderSessionMarkdown(SESSION, [
      message({
        id: 1,
        role: "assistant",
        content: "Token confirmed.",
        reasoning: `Checked the mint.\nThen used ${apiKey}.`,
      }),
    ]);

    expect(markdown).toContain("> **Reasoning**");
    expect(markdown).toContain("> Checked the mint.");
    expect(markdown).not.toContain(apiKey);
    expect(markdown.indexOf("> **Reasoning**")).toBeLessThan(
      markdown.indexOf("Token confirmed."),
    );
  });

  it("emits no Reasoning section for user rows or when reasoning is null", () => {
    const markdown = renderSessionMarkdown(SESSION, [
      message({ id: 1, role: "user", content: "Buy ANSEM.", reasoning: "leaked?" }),
      message({ id: 2, role: "assistant", content: "Done.", reasoning: null }),
    ]);

    expect(markdown).not.toContain("Reasoning");
    expect(markdown).not.toContain("leaked?");
  });

  it("leaves a tx hash in tool prose legible (export precision contract)", () => {
    const txHash =
      "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const markdown = renderSessionMarkdown(SESSION, [
      message({ id: 1, role: "assistant", content: `Confirmed tx ${txHash}` }),
    ]);
    expect(markdown).toContain(txHash);
  });

  it("sanitizes the default filename and appends the session date", () => {
    expect(
      defaultSessionMarkdownFilename('  Research: <ANSEM> / "swap".  ', SESSION.startedAt),
    ).toBe("Research ANSEM swap-2026-07-12.md");
    expect(
      defaultSessionMarkdownFilename(
        `key sk-or-v1-${"a".repeat(32)}`,
        SESSION.startedAt,
      ),
    ).toBe("key [redacted]-2026-07-12.md");
  });

  it("writes a temporary file and atomically renames it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vex-md-export-"));
    dirs.push(dir);
    const destination = path.join(dir, "session.md");
    await writeMarkdownAtomically(destination, "# Session\n");

    expect(await readFile(destination, "utf8")).toBe("# Session\n");
    expect(await readdir(dir)).toEqual(["session.md"]);
  });

  /**
   * POSIX mode bits are kernel-enforced on macOS and Linux. On Windows libuv
   * maps `mode` onto the read-only attribute alone, so the group/other bits
   * that make the export private have no NTFS representation and the check
   * would measure nothing there.
   *
   * `it.skipIf` rather than an inline `if`: a skipped test is visible in the
   * reporter, while a swallowed assertion reports as PASSING on the one
   * platform where it proved nothing. The atomic-rename and no-leftover-temp
   * contract above still runs on all three lanes.
   */
  it.skipIf(process.platform === "win32")(
    "gives the exported transcript mode 0600",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "vex-md-export-"));
      dirs.push(dir);
      const destination = path.join(dir, "session.md");
      await writeMarkdownAtomically(destination, "# Session\n");

      expect((await stat(destination)).mode & 0o777).toBe(0o600);
    },
  );

  it("cleans the temporary file when the final rename fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vex-md-export-"));
    dirs.push(dir);
    const destination = path.join(dir, "occupied");
    await mkdir(destination);

    await expect(writeMarkdownAtomically(destination, "secret transcript")).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["occupied"]);
  });
});
