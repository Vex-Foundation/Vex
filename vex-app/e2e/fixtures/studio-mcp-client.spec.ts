/**
 * THE MCP TRANSPORT'S OWN CONTRACT, without a bridge and without Electron.
 *
 * The live walk (`../studio-mcp-live.spec.ts`) can only run when a Studio, a
 * database and a Codex login are all present, so the transport's failure paths
 * would otherwise be proven by nothing. These are the paths: response
 * discrimination, malformed frames, the framing bound, the stderr bound, and a
 * shutdown that actually ends the process.
 *
 * Shape borrowed from VS Code's test for the same problem
 * (`agents-colab/vscode/src/vs/workbench/contrib/mcp/test/node/mcpStdioStateHandler.test.ts`):
 * spawn `node -e <tiny script>` as the peer, give the handler a short grace
 * time, and assert on what the real child did. A fake object cannot prove that
 * a SIGKILL was awaited.
 *
 * Placed beside `vex-stack.spec.ts`, which is the repository's existing
 * precedent for asserting a fixture's own decisions inside the e2e project
 * without launching the app.
 */

import { test, expect } from "@playwright/test";
import {
  openBridgeSession,
  readJsonRpcFrame,
  type InstalledVexEntry,
  type JsonRpcFrame,
} from "./studio-mcp-client.js";

/** A grace time short enough for a test and long enough to be a real wait. */
const GRACE_MS = 150;

/** A peer that is a `node -e` script rather than the shipped bridge. */
function peer(script: string): InstalledVexEntry {
  return { command: process.execPath, args: ["-e", script], tool_timeout_sec: 1 };
}

test.describe("JSON-RPC response discrimination", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly line: unknown;
    readonly expected: JsonRpcFrame;
  }> = [
    {
      name: "a result frame",
      line: { jsonrpc: "2.0", id: 7, result: { ok: true } },
      expected: { kind: "response", response: { kind: "result", id: 7, result: { ok: true } } },
    },
    {
      name: "a null result is still a result",
      line: { jsonrpc: "2.0", id: 7, result: null },
      expected: { kind: "response", response: { kind: "result", id: 7, result: null } },
    },
    {
      name: "an error frame",
      line: { jsonrpc: "2.0", id: 7, error: { code: -32_601, message: "no such method" } },
      expected: {
        kind: "response",
        response: { kind: "error", id: 7, code: -32_601, message: "no such method", data: undefined },
      },
    },
    {
      name: "a notification is not an answer",
      line: { jsonrpc: "2.0", method: "notifications/progress", params: {} },
      expected: { kind: "notification", method: "notifications/progress" },
    },
  ];

  for (const one of cases) {
    test(one.name, () => {
      expect(readJsonRpcFrame(one.line)).toEqual(one.expected);
    });
  }

  test("refuses a frame carrying BOTH result and error", () => {
    const frame = readJsonRpcFrame({
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
      error: { code: 1, message: "and also this" },
    });
    expect(frame.kind).toBe("malformed");
    if (frame.kind !== "malformed") throw new Error("unreachable: asserted malformed above");
    expect(frame.id).toBe(7);
    expect(frame.reason).toContain("both");
  });

  test("refuses a frame carrying NEITHER result nor error", () => {
    const frame = readJsonRpcFrame({ jsonrpc: "2.0", id: 7 });
    expect(frame.kind).toBe("malformed");
    if (frame.kind !== "malformed") throw new Error("unreachable: asserted malformed above");
    expect(frame.id).toBe(7);
    expect(frame.reason).toContain("neither");
  });

  test("refuses an error member that is not a JSON-RPC error object", () => {
    const frame = readJsonRpcFrame({ jsonrpc: "2.0", id: 7, error: "boom" });
    expect(frame.kind).toBe("malformed");
  });

  test("refuses anything that is not a JSON-RPC 2.0 object", () => {
    for (const line of [null, 3, "text", [], { id: 7, result: {} }, { jsonrpc: "1.0", id: 7, result: {} }]) {
      expect(readJsonRpcFrame(line).kind, JSON.stringify(line)).toBe("malformed");
    }
  });
});

test.describe("bridge session lifecycle", () => {
  test("a malformed answer fails the request it was addressed to, and is counted", async () => {
    const session = openBridgeSession(
      peer(`
        process.stdin.on("data", () => {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: 1, result: {}, error: { code: -1, message: "and also this" },
          }) + "\\n");
        });
        process.stdin.resume();
      `),
      {},
      { shutdownGraceMs: GRACE_MS },
    );
    try {
      await expect(session.request("initialize", {})).rejects.toThrow(
        /initialize: the server's response frame is malformed - .*both/u,
      );
      expect(session.diagnostics().malformedFrames).toBe(1);
      expect(session.diagnostics().uncorrelatedResponses).toBe(0);
    } finally {
      await session.close();
    }
  });

  test("a frame nobody asked for is counted rather than ignored", async () => {
    const session = openBridgeSession(
      // Writes its frame and ends on its own. The grace stays long so a slow
      // node start cannot be killed before it writes, which would make this
      // test measure the machine rather than the counter.
      peer(`
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 99, result: {} }) + "\\n");
      `),
      {},
      { shutdownGraceMs: 10_000 },
    );
    await session.close();
    expect(session.diagnostics().uncorrelatedResponses).toBe(1);
    expect(session.diagnostics().malformedFrames).toBe(0);
  });

  test("an unframed peer is rejected at the line bound instead of buffered forever", async () => {
    const session = openBridgeSession(
      peer(`
        process.stdin.on("data", () => { process.stdout.write("x".repeat(5000)); });
        process.stdin.resume();
      `),
      {},
      { shutdownGraceMs: GRACE_MS, maxLineBytes: 1024 },
    );
    try {
      await expect(session.request("initialize", {})).rejects.toThrow(/with no newline/u);
    } finally {
      await session.close();
    }
  });

  test("stderr is bounded and says what it dropped", async () => {
    const session = openBridgeSession(
      peer(`
        for (let i = 0; i < 40; i += 1) process.stderr.write("noise".repeat(100) + "\\n");
      `),
      {},
      { shutdownGraceMs: 10_000, maxStderrBytes: 512 },
    );
    await session.close();
    expect(session.diagnostics().droppedStderrBytes).toBeGreaterThan(0);
    expect(session.stderr(), "a bounded stream must name its loss").toContain(
      "bytes were not retained",
    );
  });

  test("close ends a peer that ignores stdin and SIGTERM, and waits for it to be gone", async () => {
    const session = openBridgeSession(
      peer(`
        setInterval(() => {}, 1000);
        process.on("SIGTERM", () => {});
        process.stdin.resume();
      `),
      {},
      { shutdownGraceMs: GRACE_MS },
    );

    await session.close();

    // BOTH escalation steps ran and BOTH were awaited, proven by the peer's own
    // exit rather than by a clock: SIGKILL is only reached after the SIGTERM
    // grace expired, and the signal is only known because `close` was observed.
    expect(session.diagnostics().exit, "close returned before the peer had ended").not.toBeNull();
    expect(session.diagnostics().exit?.signal).toBe("SIGKILL");
    // A session that only signalled and returned would still accept a write.
    expect(() => {
      session.notify("notifications/cancelled", {});
    }).toThrow(/already exited/u);
  });

  test("close is safe to call twice", async () => {
    const session = openBridgeSession(peer("process.exit(0);"), {}, { shutdownGraceMs: GRACE_MS });
    await session.close();
    await session.close();
  });
});
