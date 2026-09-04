/**
 * THE CODEX CHILD PROCESS AND ITS EVENT STREAM, as one owner.
 *
 * Extracted from `studio-mcp-live.spec.ts` so the acceptance spec asserts on a
 * decoded turn instead of also spawning and parsing one. Three capabilities,
 * all about the same binary:
 *
 *  - `runCodex` runs ONE non-interactive turn against a Vex host and returns
 *    the decoded events. This is the layer that spends real tokens.
 *  - `listCodexMcpServers` asks the binary WHICH MCP servers a given
 *    configuration gives it, and costs nothing: `codex mcp list --json` reaches
 *    no model and needs no credentials.
 *  - `createTemporaryCodexHome` owns the throwaway `CODEX_HOME` directories the
 *    first capability needs, including their removal.
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
 * So the two live capabilities divide exactly along that measurement:
 * `listCodexMcpServers` proves the zero-override configuration path, and
 * `runCodex` proves the agent turn by replaying the installed entry's own
 * bytes through `-c mcp_servers.vex.*` overrides under the owner's real
 * `CODEX_HOME`. Neither reads, copies or writes any credential.
 *
 * ## Lifecycle policy
 *
 * TIMEOUTS: every invocation of the binary carries one, the synchronous ones
 * included. `spawnSync` with a `timeout` kills AND reaps before it returns;
 * the asynchronous turn escalates SIGTERM to SIGKILL and AWAITS the child's
 * `close` event before it rejects, so a timed-out run leaves no process
 * behind. The escalation shape is VS Code's for the same kind of child
 * (`agents-colab/vscode/src/vs/workbench/contrib/mcp/node/mcpStdioStateHandler.ts`).
 *
 * BOUNDS: the raw stdout and stderr this file RETAINS are bounded and report
 * what they dropped (`./bounded-text-capture.ts`). Decoding does not depend on
 * that bound: every line is parsed as it arrives, so a turn whose archive was
 * clipped still yields every tool call and the final message. The decoder's own
 * held tail is bounded too, and a peer that writes past it without a newline
 * ends the turn with a framing failure instead of growing a buffer forever.
 *
 * MALFORMED LINES are counted by kind and returned on the run, never silently
 * skipped, so "the agent called no tool" can be told apart from "the stream
 * this walk could not read".
 *
 * TEMPORARY CODEX HOMES are removed when the run that made them passed, and
 * RETAINED when it failed so the failure can be read. They are throwaway
 * state, not evidence: Codex writes its own history, session and state
 * databases into `CODEX_HOME`, and keeping those under the evidence directory
 * of every green run is accumulation with no reader.
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createBoundedTextCapture } from "./bounded-text-capture.js";
import type { InstalledVexEntry } from "./studio-mcp-client.js";

/** How long one Codex turn may take before the walk counts as stuck. */
export const CODEX_TIMEOUT_MS = 360_000;

/**
 * How long a free, model-free `codex` invocation may take.
 *
 * `codex mcp list --json` and `codex --version` read a config file and print;
 * a minute is already an order of magnitude more than either needs, and it is
 * a bound rather than a wait.
 */
export const CODEX_SYNC_TIMEOUT_MS = 60_000;

/** Output bound for the synchronous invocations, in bytes. */
export const CODEX_SYNC_MAX_BUFFER_BYTES = 8_388_608;

/** Retention bound for a turn's raw JSONL stream. Decoding is not bounded by it. */
export const CODEX_RAW_LIMIT_BYTES = 16_777_216;

/** Retention bound for a turn's stderr. */
export const CODEX_STDERR_LIMIT_BYTES = 1_048_576;

/** How long each shutdown step waits before escalating, once a turn timed out. */
export const CODEX_SHUTDOWN_GRACE_MS = 10_000;

/**
 * The longest single stdout line the decoder holds before declaring the stream
 * unframed. Far above any `codex exec --json` event and far below the memory a
 * peer that stopped writing newlines would otherwise take.
 */
export const CODEX_MAX_LINE_BYTES = 16_777_216;

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

/**
 * What the decoder could not use, counted rather than dropped.
 *
 * A caller asserts these are zero, or archives them beside the run; either way
 * an unreadable stream stops looking like a quiet one.
 */
export interface CodexStreamDiagnostics {
  /** Non-empty stdout lines that were not JSON. */
  readonly nonJsonLines: number;
  /** JSON lines that did not match the event envelope. */
  readonly unrecognizedEvents: number;
  /** Raw stdout bytes past the retention bound. Decoding saw them all. */
  readonly droppedRawBytes: number;
  /** Stderr bytes past the retention bound. */
  readonly droppedStderrBytes: number;
}

export interface CodexRun {
  readonly raw: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly finalMessage: string;
  readonly toolCalls: readonly CodexToolCall[];
  readonly diagnostics: CodexStreamDiagnostics;
}

/**
 * Run one binary synchronously, under a timeout and an output bound.
 *
 * The single owner of every blocking invocation the live walk makes - `codex`
 * and `git` alike - so no caller can add one that hangs the walk forever.
 * `spawnSync` with `timeout` kills the child with `killSignal` and REAPS it
 * before returning, and it does the same on `maxBuffer`; both arrive back as
 * `error` plus `signal`, which the thrown message repeats rather than hiding
 * behind "status null".
 *
 * `binary` is REQUIRED rather than defaulted to `codex`: a bound that belongs
 * to whichever process is being run should not read as a Codex-only helper,
 * and every caller already knows which binary it means.
 */
export function invokeBoundedSync(options: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly label: string;
  readonly context: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}): string {
  const run = spawnSync(options.binary, [...options.args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    timeout: options.timeoutMs ?? CODEX_SYNC_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: options.maxBufferBytes ?? CODEX_SYNC_MAX_BUFFER_BYTES,
  });
  if (run.error !== undefined || run.status !== 0) {
    const cause = run.error === undefined ? "" : ` (${run.error.message})`;
    const signal = run.signal === null ? "" : `, signal ${run.signal}`;
    throw new Error(
      `${options.label} failed (status ${String(run.status)}${signal})${cause} ` +
        `${options.context}; its stderr:\n${run.stderr}`,
    );
  }
  return run.stdout;
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
 *
 * A hung binary is bounded by `timeout`, and an unbounded printer by
 * `maxBuffer`; `spawnSync` kills and reaps the child itself in both cases, and
 * surfaces the reason in `error` and `signal`, which the message repeats.
 */
export function listCodexMcpServers(options: {
  readonly codexHome: string;
  readonly cwd: string;
}): readonly CodexMcpServer[] {
  const stdout = invokeBoundedSync({
    binary: "codex",
    args: ["mcp", "list", "--json"],
    label: "codex mcp list",
    context: `under CODEX_HOME=${options.codexHome}`,
    cwd: options.cwd,
    env: { CODEX_HOME: options.codexHome },
  });
  return z.array(codexMcpServerSchema).parse(JSON.parse(stdout));
}

/** The Codex build this evidence came from. */
export function codexVersion(): string {
  try {
    return invokeBoundedSync({
      binary: "codex",
      args: ["--version"],
      label: "codex --version",
      context: "for the provenance record",
    }).trim();
  } catch {
    return "codex: unavailable";
  }
}

/** The outcome of the test that owns a temporary Codex home. */
export type CodexHomeOutcome = "passed" | "failed";

/**
 * A throwaway `CODEX_HOME`, and the decision about what happens to it.
 *
 * The caller must call `release` exactly once, with the outcome of the run
 * that used it.
 */
export interface TemporaryCodexHome {
  readonly path: string;
  /**
   * Remove the directory after a passing run, retain it after a failing one.
   *
   * Returns the sentence the caller puts in its report, which names the
   * retained path when there is one. Idempotent: a second call reports the
   * same decision and touches nothing.
   */
  release(outcome: CodexHomeOutcome): string;
}

/**
 * Mint a `CODEX_HOME` under `parentDir`, optionally seeded with a config file.
 *
 * `seedConfigTomlPath` is COPIED, never edited: a rewritten config would prove
 * a file this walk composed rather than the file the product wrote.
 */
export function createTemporaryCodexHome(options: {
  readonly parentDir: string;
  readonly name: string;
  readonly seedConfigTomlPath?: string;
}): TemporaryCodexHome {
  const home = path.join(options.parentDir, options.name);
  fs.mkdirSync(home, { recursive: true });
  if (options.seedConfigTomlPath !== undefined) {
    fs.copyFileSync(options.seedConfigTomlPath, path.join(home, "config.toml"));
  }
  let released = false;
  let decision = "";
  return {
    path: home,
    release(outcome) {
      if (released) return decision;
      released = true;
      if (outcome === "failed") {
        decision = `retained the temporary CODEX_HOME of a failed run at ${home}`;
        return decision;
      }
      fs.rmSync(home, { recursive: true, force: true });
      decision = `removed the temporary CODEX_HOME ${home}`;
      return decision;
    },
  };
}

/**
 * THE JSONL DECODER, fed as bytes arrive.
 *
 * Separate from the process owner because it is the part with a decision in
 * it: what counts as a tool call, which agent message is the answer, and what
 * an unreadable line does. Feeding it does not depend on any retention bound,
 * which is why a clipped archive never costs the walk an assertion.
 *
 * The HELD TAIL is the one thing here that could grow without limit, so it has
 * its own bound. Past it the decoder declares the stream UNFRAMED, drops the
 * tail and stops decoding: a line longer than the bound is not a big event, it
 * is a peer that stopped emitting JSONL, and buffering the rest of it would
 * trade a diagnosis for an out-of-memory. The violation is a sentence the
 * owner reads and turns into a failure, never a silent skip - same policy as
 * `studio-mcp-client.ts` applies to the bridge's own stdout.
 */
export interface CodexStreamDecoder {
  /** Feed raw stdout. Complete lines are decoded; a partial tail is held. */
  feed(chunk: string): void;
  /** Decode whatever the stream ended on without a trailing newline. */
  end(): void;
  finalMessage(): string;
  toolCalls(): readonly CodexToolCall[];
  nonJsonLines(): number;
  unrecognizedEvents(): number;
  /**
   * Why this stream stopped being decodable, or null while it is fine.
   *
   * Set once, by the line bound. The owner surfaces it as a run failure.
   */
  framingViolation(): string | null;
}

export function createCodexStreamDecoder(
  options: { readonly maxLineBytes?: number } = {},
): CodexStreamDecoder {
  const maxLineBytes = options.maxLineBytes ?? CODEX_MAX_LINE_BYTES;
  const toolCalls: CodexToolCall[] = [];
  let finalMessage = "";
  let nonJsonLines = 0;
  let unrecognizedEvents = 0;
  let lineBuffer = "";
  let framingViolation: string | null = null;

  const decodeLine = (line: string): void => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      nonJsonLines += 1;
      return;
    }
    const event = codexEventSchema.safeParse(parsed);
    if (!event.success) {
      unrecognizedEvents += 1;
      return;
    }
    const item = event.data.item;
    if (event.data.type !== "item.completed" || item === undefined) return;
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
  };

  return {
    feed(chunk) {
      if (framingViolation !== null) return;
      lineBuffer += chunk;
      for (;;) {
        const newline = lineBuffer.indexOf("\n");
        if (newline === -1) break;
        const line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        decodeLine(line);
      }
      const pendingBytes = Buffer.byteLength(lineBuffer, "utf8");
      if (pendingBytes > maxLineBytes) {
        framingViolation =
          `codex exec wrote ${String(pendingBytes)} bytes with no newline, past the ` +
          `${String(maxLineBytes)}-byte line bound; \`codex exec --json\` is ` +
          "newline-delimited JSON";
        // Dropped rather than kept: the tail is unusable by definition, and the
        // reason to stop is the sentence above, not the bytes.
        lineBuffer = "";
      }
    },
    end() {
      if (framingViolation !== null) return;
      const rest = lineBuffer;
      lineBuffer = "";
      decodeLine(rest);
    },
    finalMessage: () => finalMessage,
    toolCalls: () => toolCalls,
    nonJsonLines: () => nonJsonLines,
    unrecognizedEvents: () => unrecognizedEvents,
    framingViolation: () => framingViolation,
  };
}

/** How a child is allowed to end, and what is said when it will not. */
export interface ChildExitPolicy {
  readonly timeoutMs: number;
  readonly shutdownGraceMs: number;
  /** How the child is named in a failure, e.g. `codex exec`. */
  readonly label: string;
  /** Evidence appended to a timeout failure, read at the moment it happens. */
  readonly evidence: () => string;
}

/**
 * Wait for a child to close, and if it will not, KILL IT AND AWAIT THE CLOSE.
 *
 * The escalation is VS Code's for the same class of child: SIGTERM, a grace
 * period, then SIGKILL, then wait again. It rejects only AFTER the process is
 * gone and reaped, because a rejection that races the child's death hands the
 * caller a passing `finally` and a live process holding this run's pipes.
 *
 * Resolves with the exit code (null when a signal ended it), rejects on a
 * spawn failure or on the deadline.
 */
export async function awaitChildExit(
  child: ChildProcessWithoutNullStreams,
  policy: ChildExitPolicy,
): Promise<number | null> {
  let closed = false;
  const closedPromise = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      closed = true;
      resolve(code);
    });
  });

  /** True when the child closed within `ms`, false when the wait expired. */
  const waitForClose = async (ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (closed) {
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(false), ms);
      timer.unref();
      void closedPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });

  // ONE promise, not a race against the close event. A `Promise.race` here
  // would be won by the child's own `close` the moment the deadline killed it,
  // so a timed-out run would resolve with a null exit code and read as an
  // ordinary end. The deadline therefore latches, and the close path stops
  // being an outcome once it has.
  let timedOut = false;
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await new Promise<number | null>((resolve, reject) => {
      void closedPromise.then((code) => {
        if (!timedOut) resolve(code);
      });
      child.once("error", (cause: Error) => {
        reject(new Error(`${policy.label} could not be spawned: ${cause.message}`));
      });
      deadline = setTimeout(() => {
        timedOut = true;
        void (async () => {
          child.kill("SIGTERM");
          let gone = await waitForClose(policy.shutdownGraceMs);
          if (!gone) {
            child.kill("SIGKILL");
            gone = await waitForClose(policy.shutdownGraceMs);
          }
          // SIGKILL cannot be ignored, so a child that still has not closed is
          // one whose DESCENDANTS hold its stdio. Saying "the child has closed"
          // there would hand the caller a tidy sentence over a live pipe.
          const ending = gone
            ? "the child has closed"
            : `the child (pid ${String(child.pid)}) did NOT close within ` +
              `${String(policy.shutdownGraceMs)}ms of SIGKILL, so a process it spawned is ` +
              "still holding its stdio and has to be ended by hand";
          reject(
            new Error(
              `${policy.label} did not finish within ${String(policy.timeoutMs)}ms and was ` +
                `killed; ${ending}. Its evidence:\n${policy.evidence()}`,
            ),
          );
        })();
      }, policy.timeoutMs);
    });
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
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
  readonly timeoutMs?: number;
  readonly shutdownGraceMs?: number;
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

  const rawCapture = createBoundedTextCapture("codex stdout", CODEX_RAW_LIMIT_BYTES);
  const stderrCapture = createBoundedTextCapture("codex stderr", CODEX_STDERR_LIMIT_BYTES);
  const decoder = createCodexStreamDecoder();

  // DECODE AS IT ARRIVES, so the retention bound can never cost the walk a tool
  // call or the final message.
  // An unframed peer never becomes framed, so the turn ends the moment the
  // decoder says so rather than waiting out the whole timeout on a stream
  // nobody can read. `awaitChildExit` below then returns the ordinary close,
  // and the violation is raised after it with the stderr that explains it.
  let killedForFraming = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    rawCapture.append(chunk);
    decoder.feed(chunk);
    if (decoder.framingViolation() !== null && !killedForFraming) {
      killedForFraming = true;
      child.kill("SIGKILL");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrCapture.append(chunk);
  });

  const stderrText = (): string => {
    const report = stderrCapture.dropReport();
    return report === "" ? stderrCapture.text() : `${stderrCapture.text()}\n${report}\n`;
  };

  const exitCode = await awaitChildExit(child, {
    timeoutMs: options.timeoutMs ?? CODEX_TIMEOUT_MS,
    shutdownGraceMs: options.shutdownGraceMs ?? CODEX_SHUTDOWN_GRACE_MS,
    label: "codex exec",
    evidence: stderrText,
  });
  decoder.end();

  const violation = decoder.framingViolation();
  if (violation !== null) {
    throw new Error(`${violation}. Its stderr:\n${stderrText()}`);
  }

  return {
    raw: rawCapture.text(),
    stderr: stderrText(),
    exitCode,
    finalMessage: decoder.finalMessage(),
    toolCalls: decoder.toolCalls(),
    diagnostics: {
      nonJsonLines: decoder.nonJsonLines(),
      unrecognizedEvents: decoder.unrecognizedEvents(),
      droppedRawBytes: rawCapture.droppedBytes(),
      droppedStderrBytes: stderrCapture.droppedBytes(),
    },
  };
}
