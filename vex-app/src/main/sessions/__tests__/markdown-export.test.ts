import { mkdtemp, mkdir, readFile, readdir, stat } from "node:fs/promises";
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
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map(async (dir) => {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
    }),
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
        content: "I’ll verify it first.",
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
      markdown.indexOf("I’ll verify it first."),
    );
    expect(markdown).toContain("> Tool: `token_find`");
    expect(markdown).not.toContain("private-id");
    expect(markdown).not.toContain("mint");
  });

  it("omits system, runtime, compaction, and raw tool-result rows and redacts secrets in prose", () => {
    const apiKey = `sk-or-v1-${"a".repeat(32)}`;
    const markdown = renderSessionMarkdown(SESSION, [
      message({ id: 1, role: "system", content: "hidden system prompt" }),
      message({ id: 2, role: "assistant", kind: "runtime_notice", content: "runtime noise" }),
      message({ id: 3, role: "assistant", kind: "compaction", content: "compacted" }),
      message({ id: 4, role: "tool", kind: "tool_result", content: "raw result" }),
      message({ id: 5, role: "user", content: `Use ${apiKey}` }),
    ]);

    expect(markdown).not.toContain("hidden system prompt");
    expect(markdown).not.toContain("runtime noise");
    expect(markdown).not.toContain("compacted");
    expect(markdown).not.toContain("raw result");
    expect(markdown).not.toContain(apiKey);
    expect(markdown).toContain("[redacted]");
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

  it("writes a private temporary file and atomically renames it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vex-md-export-"));
    dirs.push(dir);
    const destination = path.join(dir, "session.md");
    await writeMarkdownAtomically(destination, "# Session\n");

    expect(await readFile(destination, "utf8")).toBe("# Session\n");
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["session.md"]);
  });

  it("cleans the temporary file when the final rename fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vex-md-export-"));
    dirs.push(dir);
    const destination = path.join(dir, "occupied");
    await mkdir(destination);

    await expect(writeMarkdownAtomically(destination, "secret transcript")).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["occupied"]);
  });
});
