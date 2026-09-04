/**
 * THE CODEX CHILD PROCESS AND ITS EVENT STREAM, as one owner.
 *
 * Extracted from `studio-mcp-live.spec.ts` so the acceptance spec asserts on a
 * decoded turn instead of also spawning and parsing one. Two capabilities, both
 * about the same binary:
 *
 *  - `runCodex` runs ONE non-interactive turn against a Vex host and returns
 *    the decoded events. This is the layer that spends real tokens.
 *  - `listCodexMcpServers` asks the binary WHICH MCP servers a given
 *    configuration gives it, and costs nothing: `codex mcp list --json` reaches
 *    no model and needs no credentials.
 *
 * ## What this file measured about Codex configuration, and when
 *
 * codex-cli 0.153.2, measured 2026-09-04:
 *
 *  A. a project-level `.codex/config.toml` is NOT read. Run from inside a
 *     directory holding one, `codex mcp list --json` answers `[]`.
 *  B. `$CODEX_HOME/config.toml` IS read, and the installer's block is a valid
 *     one verbatim: copied into a throwaway `CODEX_HOME`, the same command
 *     answers with the `vex` stdio entry, its `command`, its `args` and its
 *     `tool_timeout_sec`, with NO command-line override.
 *  C. B cannot carry an agent TURN here, because `CODEX_HOME` is also where
 *     Codex reads credentials: `codex exec` under a throwaway home answers
 *     401 Unauthorized. Making it authenticate would mean placing the owner's
 *     credentials inside a test-owned directory, or writing into the owner's
 *     real `~/.codex` - the first is forbidden by the repository's secret
 *     rules, the second is a test mutating the developer's machine.
 *
 * So the two capabilities here divide exactly along that measurement:
 * `listCodexMcpServers` proves the zero-override configuration path, and
 * `runCodex` proves the agent turn by replaying the installed entry's own
 * bytes through `-c mcp_servers.vex.*` overrides under the owner's real
 * `CODEX_HOME`. Neither reads, copies or writes any credential.
 */

import { spawn, spawnSync } from "node:child_process";
import { z } from "zod";
import type { InstalledVexEntry } from "./studio-mcp-client.js";

/** How long one Codex turn may take before the walk counts as stuck. */
export const CODEX_TIMEOUT_MS = 360_000;

/**
 * One `codex exec --json` line. Only the fields this walk reads are named; a
 * stream carrying more is normal and is archived whole.
 *
 * The item vocabulary is the binary's own: `item.started` / `item.completed`
 * envelopes carrying an item whose `type` is one of `mcp_tool_call`,
 * `agent_message`, `command_execution` and the rest, which is what
 * `strings` over the shipped codex binary enumerates.
 */
const codexEventSchema = z.object({
  type: z.string(),
  item: z
    .object({
      type: z.string(),
      server: z.string().optional(),
      tool: z.string().optional(),
      status: z.string().optional(),
      text: z.string().optional(),
      arguments: z.unknown().optional(),
      // `error` is the CLIENT's own transport failure; a tool that refused
      // still answers, and its sentence arrives inside `result.content`.
      error: z.unknown().nullable().optional(),
      result: z
        .object({
          content: z
            .array(z.object({ type: z.string(), text: z.string().optional() }).loose())
            .optional(),
        })
        .loose()
        .nullable()
        .optional(),
    })
    .loose()
    .optional(),
});

/** One row of `codex mcp list --json`, narrowed to the stdio fields we assert on. */
const codexMcpServerSchema = z
  .object({
    name: z.string(),
    enabled: z.boolean(),
    transport: z
      .object({
        type: z.string(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
      })
      .loose(),
    tool_timeout_sec: z.number().nullable().optional(),
  })
  .loose();

export type CodexMcpServer = z.infer<typeof codexMcpServerSchema>;

export interface CodexToolCall {
  readonly server: string | undefined;
  readonly tool: string | undefined;
  readonly status: string | undefined;
  /**
   * Did the HOST answer this call with a refusal sentence of its own?
   *
   * True means the tool ran nothing and said why, which is a normal outcome the
   * caller can act on. False on a failed call means nothing came back at all.
   */
  readonly refusedByName: boolean;
  /** The tool's own sentence, when it answered one. */
  readonly answer: string;
}

export interface CodexRun {
  readonly raw: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly finalMessage: string;
  readonly toolCalls: readonly CodexToolCall[];
}

/**
 * Which MCP servers does Codex see under `codexHome`, from `cwd`?
 *
 * The binary's own answer, in its own JSON, and the only honest way to state
 * what a configuration file achieves. Reaches no model and needs no
 * credentials, so it is safe to call in a walk that must not spend tokens.
 *
 * `CODEX_HOME` is REQUIRED rather than defaulted: a caller that forgot it would
 * silently read the developer's real configuration and assert on it.
 *
 * MEASURED NOISE, not a failure: a `CODEX_HOME` under `/tmp` makes codex print
 * "Refusing to create helper binaries under temporary dir" to stderr. It exits
 * 0 and its JSON is unaffected, which is why only `status` is checked here.
 */
export function listCodexMcpServers(options: {
  readonly codexHome: string;
  readonly cwd: string;
}): readonly CodexMcpServer[] {
  const run = spawnSync("codex", ["mcp", "list", "--json"], {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: options.codexHome },
  });
  if (run.error !== undefined || run.status !== 0) {
    throw new Error(
      `codex mcp list failed (status ${String(run.status)}) under CODEX_HOME=` +
        `${options.codexHome}; its stderr:\n${run.stderr}`,
    );
  }
  return z.array(codexMcpServerSchema).parse(JSON.parse(run.stdout));
}

/**
 * Run one non-interactive Codex turn against this run's Vex host.
 *
 * `--skip-git-repo-check` because a freshly created Vex project is not a git
 * repository, and `--sandbox read-only` because nothing this walk asks for
 * writes anything: the sandbox is the second, independent guarantee that a
 * live agent turn inside a test cannot touch the tree.
 *
 * The `-c mcp_servers.vex.*` overrides replay the INSTALLED entry's own bytes.
 * They are runtime-only: the owner's `~/.codex/config.toml` is never read,
 * copied or written. See this file's header for why they are used instead of
 * the zero-override path.
 */
export async function runCodex(options: {
  readonly projectDir: string;
  readonly entry: InstalledVexEntry;
  readonly bridgeEnv: Readonly<Record<string, string>>;
  readonly prompt: string;
}): Promise<CodexRun> {
  const envToml = Object.entries(options.bridgeEnv)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
  const args = [
    "exec",
    "--cd",
    options.projectDir,
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--json",
    "-c",
    `mcp_servers.vex.command=${JSON.stringify(options.entry.command)}`,
    "-c",
    `mcp_servers.vex.args=${JSON.stringify(options.entry.args)}`,
    "-c",
    `mcp_servers.vex.tool_timeout_sec=${String(options.entry.tool_timeout_sec)}`,
    "-c",
    `mcp_servers.vex.env={${envToml}}`,
    "-",
  ];

  const child = spawn("codex", args, {
    cwd: options.projectDir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(options.prompt);
  child.stdin.end();

  let raw = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    raw += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `codex exec did not finish within ${String(CODEX_TIMEOUT_MS)}ms; its stderr:\n${stderr}`,
        ),
      );
    }, CODEX_TIMEOUT_MS);
    child.once("error", (cause: Error) => {
      clearTimeout(timer);
      reject(new Error(`codex could not be spawned: ${cause.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  const toolCalls: CodexToolCall[] = [];
  let finalMessage = "";
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = codexEventSchema.safeParse(parsed);
    if (!event.success) continue;
    const item = event.data.item;
    if (event.data.type !== "item.completed" || item === undefined) continue;
    if (item.type === "mcp_tool_call") {
      const answer = (item.result?.content ?? [])
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
      toolCalls.push({
        server: item.server,
        tool: item.tool,
        status: item.status,
        refusedByName: item.error === null || item.error === undefined ? answer !== "" : false,
        answer,
      });
    }
    // The LAST agent message is the answer; earlier ones are the turn's
    // narration and are kept in the archived stream rather than asserted on.
    if (item.type === "agent_message" && item.text !== undefined) finalMessage = item.text;
  }

  return { raw, stderr, exitCode, finalMessage, toolCalls };
}

/** The Codex build this evidence came from. */
export function codexVersion(): string {
  const run = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (run.error !== undefined || run.status !== 0) return "codex: unavailable";
  return run.stdout.trim();
}
