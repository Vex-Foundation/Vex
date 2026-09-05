/**
 * THE CODEX RUNNER'S LIFECYCLE AND DECODER, without a Codex login.
 *
 * `runCodex` itself spends real tokens and cannot be a unit test, so the parts
 * that decide whether a live run is honest are the ones exercised here: the
 * bound on a synchronous invocation, the kill-and-await escalation, the
 * counted malformed lines, and the temporary-home policy.
 *
 * The peer is `node -e <tiny script>`, which is how VS Code tests the same
 * class of child
 * (`agents-colab/vscode/src/vs/workbench/contrib/mcp/test/node/mcpStdioStateHandler.test.ts`);
 * the escalation under test is the one from
 * `agents-colab/vscode/src/vs/workbench/contrib/mcp/node/mcpStdioStateHandler.ts`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import {
  awaitChildExit,
  createCodexStreamDecoder,
  createTemporaryCodexHome,
  invokeBoundedSync,
} from "./codex-live-runner.js";

const GRACE_MS = 150;

function nodePeer(script: string) {
  return spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
}

test.describe("synchronous invocation bounds", () => {
  test("returns the child's stdout when it succeeds", () => {
    const stdout = invokeBoundedSync({
      binary: process.execPath,
      args: ["-e", 'process.stdout.write("0.153.2")'],
      label: "codex --version",
      context: "in a test",
    });
    expect(stdout).toBe("0.153.2");
  });

  test("kills a hanging invocation at the timeout and names the signal", () => {
    const before = Date.now();
    expect(() =>
      invokeBoundedSync({
        binary: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        label: "codex mcp list",
        context: "in a test",
        timeoutMs: 300,
      }),
    ).toThrow(/signal SIGKILL/u);
    // A missing timeout is the regression this catches: without one the call
    // never returns at all, so the assertion above can only run because the
    // bound exists.
    expect(Date.now() - before).toBeLessThan(10_000);
  });

  test("refuses an invocation that outgrows its output bound", () => {
    expect(() =>
      invokeBoundedSync({
        binary: process.execPath,
        args: ["-e", 'process.stdout.write("x".repeat(100000))'],
        label: "codex mcp list",
        context: "in a test",
        maxBufferBytes: 1024,
      }),
    ).toThrow(/codex mcp list failed/u);
  });

  test("reports a non-zero exit with its stderr", () => {
    expect(() =>
      invokeBoundedSync({
        binary: process.execPath,
        args: ["-e", 'process.stderr.write("no config"); process.exit(3);'],
        label: "codex mcp list",
        context: "under CODEX_HOME=/nowhere",
      }),
    ).toThrow(/status 3.*under CODEX_HOME=\/nowhere.*no config/su);
  });
});

test.describe("child exit escalation", () => {
  test("kills a child that ignores SIGTERM and rejects only once it has closed", async () => {
    const child = nodePeer(`
      setInterval(() => {}, 1000);
      process.on("SIGTERM", () => {});
    `);
    await expect(
      awaitChildExit(child, {
        timeoutMs: 200,
        shutdownGraceMs: GRACE_MS,
        label: "codex exec",
        evidence: () => "no stderr",
      }),
    ).rejects.toThrow(/codex exec did not finish within 200ms and was killed/u);

    // THE POINT: the rejection came after the child was gone and reaped, not
    // alongside a signal that may or may not have landed.
    expect(child.signalCode, "the child was not SIGKILLed").toBe("SIGKILL");
    expect(child.exitCode).toBeNull();
  });

  test("returns the exit code of a child that ends on its own", async () => {
    const child = nodePeer("process.exit(4);");
    const code = await awaitChildExit(child, {
      timeoutMs: 10_000,
      shutdownGraceMs: GRACE_MS,
      label: "codex exec",
      evidence: () => "",
    });
    expect(code).toBe(4);
  });

  test("says so when the child has NOT closed after SIGKILL", async () => {
    // A descendant holding the child's stdout is the only way a SIGKILLed
    // process still has no `close` event: the signal cannot be ignored, but the
    // pipe stays open while the grandchild owns a copy of it. The grandchild
    // ends on its own so the test leaves nothing behind.
    const child = nodePeer(`
      const { spawn } = require("child_process");
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], {
        stdio: ["ignore", 1, 2],
        detached: true,
      }).unref();
      setInterval(() => {}, 1000);
      process.on("SIGTERM", () => {});
    `);
    await expect(
      awaitChildExit(child, {
        timeoutMs: 300,
        shutdownGraceMs: GRACE_MS,
        label: "codex exec",
        evidence: () => "no stderr",
      }),
    ).rejects.toThrow(/did NOT close within .*SIGKILL, so a process it spawned is still holding/su);
    // The signal landed; what did not happen is the close, which is exactly the
    // difference the message now carries.
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("a SIGTERM the child honours needs no SIGKILL", async () => {
    const child = nodePeer("setInterval(() => {}, 1000);");
    await expect(
      awaitChildExit(child, {
        timeoutMs: 100,
        shutdownGraceMs: 5_000,
        label: "codex exec",
        evidence: () => "",
      }),
    ).rejects.toThrow(/was killed/u);
    expect(child.signalCode).toBe("SIGTERM");
  });
});

test.describe("codex stream decoder", () => {
  const toolCall = (tool: string, text: string): string =>
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "vex",
        tool,
        status: "completed",
        result: { content: [{ type: "text", text }] },
      },
    });

  test("decodes tool calls and the last agent message across chunk boundaries", () => {
    const decoder = createCodexStreamDecoder();
    const line = toolCall("dexscreener__candles_list", "open 1 high 2");
    // Split mid-line on purpose: a chunk boundary is not a line boundary.
    decoder.feed(line.slice(0, 20));
    decoder.feed(`${line.slice(20)}\n`);
    decoder.feed(
      `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } })}\n`,
    );
    decoder.feed(
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } }),
    );
    decoder.end();

    expect(decoder.toolCalls().map((call) => call.tool)).toEqual(["dexscreener__candles_list"]);
    expect(decoder.toolCalls()[0]?.answer).toBe("open 1 high 2");
    expect(decoder.finalMessage(), "the trailing line without a newline was dropped").toBe("final");
    expect(decoder.nonJsonLines()).toBe(0);
    expect(decoder.unrecognizedEvents()).toBe(0);
  });

  test("counts a line that is not JSON instead of skipping it", () => {
    const decoder = createCodexStreamDecoder();
    decoder.feed("Refusing to create helper binaries under temporary dir\n");
    decoder.feed(`${toolCall("vex_ToolSearch", "ok")}\n`);
    decoder.end();
    expect(decoder.nonJsonLines()).toBe(1);
    expect(decoder.toolCalls()).toHaveLength(1);
  });

  test("counts JSON that is not an event envelope instead of skipping it", () => {
    const decoder = createCodexStreamDecoder();
    decoder.feed(`${JSON.stringify({ kind: "something-else" })}\n`);
    decoder.feed(`${JSON.stringify({ type: 7 })}\n`);
    decoder.end();
    expect(decoder.unrecognizedEvents()).toBe(2);
    expect(decoder.nonJsonLines()).toBe(0);
  });

  test("ignores blank lines without counting them as damage", () => {
    const decoder = createCodexStreamDecoder();
    decoder.feed("\n   \n");
    decoder.end();
    expect(decoder.nonJsonLines()).toBe(0);
    expect(decoder.unrecognizedEvents()).toBe(0);
  });
});

test.describe("decoder framing bound", () => {
  test("declares an unframed stream instead of buffering it forever", () => {
    const decoder = createCodexStreamDecoder({ maxLineBytes: 1024 });
    decoder.feed("x".repeat(5000));
    const violation = decoder.framingViolation();
    expect(violation, "an unbounded buffer would have kept growing quietly").not.toBeNull();
    expect(violation).toContain("5000 bytes with no newline");
    expect(violation).toContain("1024-byte line bound");

    // Once violated the decoder is done: further bytes are neither buffered nor
    // counted as damage of another kind, and `end()` decodes nothing.
    decoder.feed(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "late" } })}\n`);
    decoder.end();
    expect(decoder.finalMessage()).toBe("");
    expect(decoder.nonJsonLines()).toBe(0);
    expect(decoder.unrecognizedEvents()).toBe(0);
  });

  test("a long line that DOES arrive framed is decoded, not refused", () => {
    const decoder = createCodexStreamDecoder({ maxLineBytes: 1024 });
    const text = "y".repeat(600);
    decoder.feed(
      `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`,
    );
    expect(decoder.framingViolation()).toBeNull();
    expect(decoder.finalMessage()).toBe(text);
  });
});

test.describe("temporary codex home", () => {
  test("removes the home of a passing run", () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-codex-home-"));
    try {
      const home = createTemporaryCodexHome({ parentDir, name: "codex-home-empty" });
      // Codex fills a CODEX_HOME with its own state; stand in for it.
      fs.writeFileSync(path.join(home.path, "history.jsonl"), "{}\n", "utf8");
      const note = home.release("passed");
      expect(fs.existsSync(home.path), "a passing run left its temporary home behind").toBe(false);
      expect(note).toContain("removed");
      // Idempotent: the second call reports the same decision and touches nothing.
      expect(home.release("failed")).toBe(note);
      expect(fs.existsSync(home.path)).toBe(false);
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  test("retains the home of a failing run and names its path", () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-codex-home-"));
    try {
      const home = createTemporaryCodexHome({ parentDir, name: "codex-home-installed" });
      const note = home.release("failed");
      expect(fs.existsSync(home.path)).toBe(true);
      expect(note).toContain(home.path);
      expect(note).toContain("retained");
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });

  test("copies a seed config verbatim rather than composing one", () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "vex-codex-home-"));
    try {
      const seed = path.join(parentDir, "installed-config.toml");
      const bytes = '[mcp_servers.vex]\ncommand = "/opt/vex/vex-mcp"\ntool_timeout_sec = 120\n';
      fs.writeFileSync(seed, bytes, "utf8");
      const home = createTemporaryCodexHome({
        parentDir,
        name: "codex-home-installed",
        seedConfigTomlPath: seed,
      });
      expect(fs.readFileSync(path.join(home.path, "config.toml"), "utf8")).toBe(bytes);
      home.release("passed");
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });
});
