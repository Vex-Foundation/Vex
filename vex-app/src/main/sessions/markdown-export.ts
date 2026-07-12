/** Readable, privacy-preserving session Markdown export. */

import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { SessionMessageDto } from "@shared/schemas/messages.js";
import type { SessionListItem } from "@shared/schemas/sessions.js";

const REDACTED = "[redacted]";

function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, REDACTED)
    .replace(/\b[A-Za-z0-9+/]{86}={0,2}\b/g, REDACTED)
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{50,}\b/g, REDACTED)
    .replace(/\b(?:[a-z]+\s+){11,23}[a-z]+\b/g, REDACTED);
}

function safeToolName(name: string): string {
  return name.replace(/[\r\n`]/g, "").trim().slice(0, 120) || "tool";
}

function entryFor(message: SessionMessageDto): string | null {
  if (message.role !== "user" && message.role !== "assistant") return null;
  if (
    message.kind === "runtime_notice" ||
    message.kind === "compaction" ||
    message.kind === "error" ||
    message.kind === "tool_result"
  ) {
    return null;
  }

  const prose = redactSecrets(message.content.trim());
  const toolNames = (message.toolCalls ?? [])
    .map((call) => safeToolName(call.toolName))
    .filter((name, index, names) => names.indexOf(name) === index);
  if (toolNames.length === 0 && message.toolName !== null) {
    toolNames.push(safeToolName(message.toolName));
  }
  if (prose.length === 0 && toolNames.length === 0) return null;

  const speaker = message.role === "user" ? "You" : "Vex";
  const parts = [`## ${speaker} — ${message.createdAt}`];
  if (prose.length > 0) parts.push(prose);
  if (toolNames.length > 0) {
    parts.push(toolNames.map((name) => `> Tool: \`${name}\``).join("\n"));
  }
  return parts.join("\n\n");
}

export function renderSessionMarkdown(
  session: SessionListItem,
  messages: readonly SessionMessageDto[],
): string {
  const title = session.title?.trim() || session.initialGoal?.trim() || "Vex session";
  const entries: string[] = [];
  for (const message of messages) {
    const entry = entryFor(message);
    if (entry !== null) entries.push(entry);
  }
  const mode = session.mode === "mission" ? "Mission" : "Agent";
  return [
    `# ${redactSecrets(title)}`,
    `- Mode: ${mode}`,
    `- Started: ${session.startedAt}`,
    ...entries,
    "",
  ].join("\n\n");
}

export function defaultSessionMarkdownFilename(
  title: string | null,
  startedAt: string,
): string {
  const safeTitle = redactSecrets(title ?? "vex-session")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[ .]+$/g, "")
    .trim()
    .slice(0, 80)
    .replace(/[ .]+$/g, "") || "vex-session";
  const parsed = new Date(startedAt);
  const date = Number.isNaN(parsed.getTime())
    ? new Date().toISOString().slice(0, 10)
    : parsed.toISOString().slice(0, 10);
  return `${safeTitle}-${date}.md`;
}

/** Write a private temp file beside the destination, then atomically rename. */
export async function writeMarkdownAtomically(
  destination: string,
  markdown: string,
): Promise<void> {
  const suffix = `${process.pid}.${randomBytes(6).toString("hex")}`;
  const tempPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${suffix}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(markdown, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, destination);
  } catch (cause) {
    if (handle !== null) await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw cause;
  }
}
