/**
 * THE BRIDGE CONFORMANCE TEST: the BUILT Go binary against the REAL host.
 *
 * Every other test in this arc proves one side of the wire against a fixture.
 * This one proves the two sides against each other, through a real process, a
 * real transport and the real handshake: the Go bridge re-derives or is handed
 * the endpoint, sends its own handshake bytes, and relays MCP frames that the
 * TypeScript host's own parser and transport answer.
 *
 * It is the only test that can catch a class the vectors cannot: two
 * implementations that each match the fixture but disagree about something the
 * fixture does not name.
 *
 * TWO ARMS, ONE PER TRANSPORT, each quarantined by NAME rather than by a silent
 * early return, so the reporter shows which one a runner did not meet:
 *
 *   - THE UNIX ARM, on linux/x64, over an `AF_UNIX` socket in a 0700 temp
 *     directory. It carries the whole exit-code and refusal table.
 *   - THE WIN32 ARM, on win32/x64, over a REAL NAMED PIPE bound by the REAL
 *     `vex-pipe-front.exe` that the REAL host spawns, dialled by the REAL built
 *     `vex-mcp.exe`. That is row 4 of the contract's 1.6 matrix, whose host
 *     half was measured by `front-real-binary.test.ts` on run 33650332655 and
 *     whose BRIDGE half had no test until this arm: a client of ours had never
 *     spoken to a host of ours over a pipe. It runs on the `vex-app-windows`
 *     lane, which builds both artifacts.
 *
 * SKIPPED, cleanly, when this platform's built binary is absent, so a checkout
 * without a Go toolchain still goes green.
 *
 * REQUIRED, and therefore FAILING instead of skipping, when
 * `VEX_REQUIRE_BRIDGE_CONFORMANCE=1` is set. CI builds the binary in the job
 * that runs this suite (`.github/workflows/ci.yml`, `vex-app-build-and-test`)
 * and sets that variable, because a silent skip in CI is indistinguishable
 * from a passing run: a build step that broke, a renamed artifact path or a
 * changed target triple would have turned the only cross-implementation test
 * in this arc into a no-op that reported green. The flag is what makes the
 * absence of evidence an absence of green.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { StudioToolCall } from "@vex-agent/mcp/admission.js";
import type {
  RunStudioCallOptions,
  StudioCallOutcome,
} from "@vex-agent/mcp/outcome.js";

import {
  beginStudioReadinessEpoch,
  markStudioRuntimeReady,
  resetStudioReadinessForTests,
} from "../readiness.js";
import {
  configureStudioMcpHost,
  resetStudioMcpHostForTests,
  shutdownStudioMcpHost,
  startStudioMcpHost,
  openStudioMcpAdmission,
  studioMcpHostEndpoint,
} from "../mcp-host.js";

/**
 * THE ONLY SEAM IN THIS FILE, and it replaces nothing: on win32 it hands the
 * REAL resolver the development layout, because `locateStudioPipeFront()` with
 * no arguments reads `app.isPackaged` and vitest is not an Electron runtime.
 * The path the win32 arm spawns is therefore still the one production computes
 * from `bridge/build.sh`'s output, and `pipe-front-path.test.ts` still owns the
 * resolution rules themselves. On every other platform the real module is
 * returned untouched, so the unix arm's graph is exactly what it was.
 *
 * The repo root is recomputed inside the factory on purpose: `vi.mock` hoists
 * its call above this module's own bindings, so the `REPO_ROOT` below is still
 * in its temporal dead zone when the factory runs.
 */
vi.mock("../installer/bridge-path.js", async () => {
  const actual = await vi.importActual<typeof import("../installer/bridge-path.js")>(
    "../installer/bridge-path.js",
  );
  if (process.platform !== "win32") return actual;
  const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");
  return {
    ...actual,
    locateStudioPipeFront: () => actual.locateStudioPipeFront({ packaged: false, repoRoot }),
  };
});

const PROJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const MISSING_PROJECT_ID = "11111111-2222-4333-8444-555555555555";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

/**
 * The bridge's stderr bound, read from the CONTRACT FIXTURE rather than
 * restated here: the Go side compares the same key against its own
 * `handshake.DiagnosticMaxBytes`, so the three cannot drift apart silently.
 *
 * It bounds the COMPLETE wire line - the `vex-mcp: ` prefix, the body and the
 * newline - so every assertion below measures the captured stderr UNSLICED.
 */
const STUDIO_BRIDGE_DIAGNOSTIC_MAX_BYTES = (
  JSON.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        "src", "vex-agent", "tools", "tool-surface-spec", "studio-mcp",
        "bridge-endpoint-vectors.json",
      ),
      "utf8",
    ),
  ) as { limits: Record<string, number> }
).limits["bridgeDiagnosticMaxBytes"] as number;
/**
 * The built bridge for THIS runner, in the dev layout `bridge/build.sh` writes.
 * Both arms spawn the same program; only the transport under it differs.
 */
const BRIDGE_BINARY =
  process.platform === "win32"
    ? path.join(REPO_ROOT, "bridge", "dist", "windows-amd64", "vex-mcp.exe")
    : path.join(REPO_ROOT, "bridge", "dist", "linux-amd64", "vex-mcp");

/**
 * Each arm runs where its artifact runs. `describe.skipIf` rather than a silent
 * early return: a skipped suite is visible in the reporter, an early return is
 * not.
 */
function unavailableBecause(platform: "linux" | "win32"): string | null {
  const triple = platform === "win32" ? "windows-amd64" : "linux-amd64";
  if (process.platform !== platform) {
    return `this arm needs the ${triple} bridge and this runner is ${process.platform}`;
  }
  if (process.arch !== "x64") {
    return `this arm needs the ${triple} bridge and this runner is ${process.arch}`;
  }
  if (!existsSync(BRIDGE_BINARY)) {
    return `the built bridge is missing at ${BRIDGE_BINARY}; run \`bridge/build.sh ${
      platform === "win32" ? "windows" : "linux"
    } amd64\``;
  }
  return null;
}

const unavailableReason = unavailableBecause("linux");
const unavailable = unavailableReason !== null;
const windowsUnavailableReason = unavailableBecause("win32");
const windowsUnavailable = windowsUnavailableReason !== null;

/**
 * CI sets this. When it is set, an unavailable artifact FAILS rather than
 * skipping, and the failure names which precondition was missing.
 */
const conformanceRequired = process.env["VEX_REQUIRE_BRIDGE_CONFORMANCE"] === "1";

describe("the bridge conformance precondition", () => {
  it("has the built artifact whenever conformance is REQUIRED", () => {
    if (!conformanceRequired) {
      expect(conformanceRequired).toBe(false);
      return;
    }
    // THIS RUNNER'S OWN ARM, not the unix one everywhere: the promise the flag
    // makes is that the platform it was set on actually exercised its
    // transport. Asserting the linux arm on the Windows lane would fail a lane
    // that is doing exactly what it was asked to, and asserting nothing there
    // would let the win32 arm skip silently on a required job - the precise
    // hole this precondition exists to close.
    const reason = process.platform === "win32" ? windowsUnavailableReason : unavailableReason;
    expect(
      reason,
      "VEX_REQUIRE_BRIDGE_CONFORMANCE=1 promises this suite actually ran, and it did not: "
        + String(reason),
    ).toBeNull();
  });
});

/** One spawned bridge, with newline framing on both of its streams. */
class BridgeProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private readonly stdoutLines: string[] = [];
  private stderrText = "";
  private wake: (() => void) | null = null;
  private exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(env: NodeJS.ProcessEnv, args: readonly string[] = []) {
    this.child = spawn(BRIDGE_BINARY, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf8");
      for (;;) {
        const nl = this.stdoutBuffer.indexOf("\n");
        if (nl === -1) break;
        this.stdoutLines.push(this.stdoutBuffer.slice(0, nl));
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      }
      this.wake?.();
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrText += chunk.toString("utf8");
      this.wake?.();
    });
    this.child.on("exit", (code, signal) => {
      this.exit = { code, signal };
      this.wake?.();
    });
  }

  writeRaw(text: string): void {
    this.child.stdin.write(text);
  }

  send(message: Record<string, unknown>): void {
    this.writeRaw(`${JSON.stringify(message)}\n`);
  }

  /** Clean stdin EOF - the edge that must produce a half-close and a drain. */
  endStdin(): void {
    this.child.stdin.end();
  }

  signal(name: NodeJS.Signals): void {
    this.child.kill(name);
  }

  stderr(): string {
    return this.stderrText;
  }

  private async settle(timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.wake = resolve;
      const timer = setTimeout(resolve, Math.min(25, timeoutMs));
      timer.unref?.();
    });
    this.wake = null;
  }

  async nextLine(timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = this.stdoutLines.shift();
      if (line !== undefined) return line;
      if (this.exit !== null) {
        throw new Error(
          `the bridge exited (code ${String(this.exit.code)}) before a line arrived; stderr: ${this.stderrText}`,
        );
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for a bridge line");
      await this.settle(timeoutMs);
    }
  }

  async nextMessage(timeoutMs = 10_000): Promise<Record<string, unknown>> {
    return JSON.parse(await this.nextLine(timeoutMs)) as Record<string, unknown>;
  }

  async responseFor(id: number, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const message = await this.nextMessage(Math.max(50, deadline - Date.now()));
      if (message["id"] === id) return message;
    }
  }

  async waitForExit(timeoutMs = 10_000): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.exit !== null) return this.exit;
      if (Date.now() > deadline) {
        this.child.kill("SIGKILL");
        throw new Error(`the bridge did not exit; stderr: ${this.stderrText}`);
      }
      await this.settle(timeoutMs);
    }
  }

  destroy(): void {
    if (this.exit === null) this.child.kill("SIGKILL");
  }
}

let socketDir = "";
const spawned: BridgeProcess[] = [];

function bridge(env: NodeJS.ProcessEnv, args: readonly string[] = []): BridgeProcess {
  const child = new BridgeProcess(
    { VEX_STUDIO_SOCKET: process.env["VEX_STUDIO_SOCKET"], ...env },
    args,
  );
  spawned.push(child);
  return child;
}

/** The complete 2025-era initialize the host answers. */
function initialize(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bridge-conformance", version: "1" },
    },
  };
}

let runCallImpl: (
  projectId: string,
  call: StudioToolCall,
  options: RunStudioCallOptions,
) => Promise<StudioCallOutcome>;
let projectExistsImpl: (projectId: string) => Promise<boolean>;

describe.skipIf(unavailable)("the built Go bridge against the real Studio host", () => {
  beforeAll(() => {
    socketDir = mkdtempSync(path.join(tmpdir(), "vex-bridge-conf-"));
    // The override's own precondition, which the BRIDGE re-validates
    // independently: a directory this user owns, mode exactly 0700.
    chmodSync(socketDir, 0o700);
    process.env["VEX_STUDIO_SOCKET"] = path.join(socketDir, "s.sock");
  });

  afterAll(() => {
    delete process.env["VEX_STUDIO_SOCKET"];
    rmSync(socketDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    runCallImpl = async () => ({ kind: "completed", result: { success: true, output: "ok" } });
    projectExistsImpl = async (projectId) => projectId === PROJECT_ID;
    resetStudioMcpHostForTests();
    markStudioRuntimeReady(beginStudioReadinessEpoch());
    configureStudioMcpHost({
      runCall: (projectId, call, options) => runCallImpl(projectId, call, options),
      projectExists: (projectId) => projectExistsImpl(projectId),
    });
    openStudioMcpAdmission();
    const started = await startStudioMcpHost();
    expect(started.started).toBe(true);
    expect(studioMcpHostEndpoint()).not.toBeNull();
  });

  afterEach(async () => {
    for (const child of spawned.splice(0)) child.destroy();
    await shutdownStudioMcpHost();
    resetStudioMcpHostForTests();
    resetStudioReadinessForTests();
  });

  // The generous timeout is the FIRST test's alone: the host dynamically
  // imports the MCP SDK on the first connection, and that import dominates
  // this suite's cold start. Every later case reuses the loaded module.
  it("handshakes and relays a full initialize round trip", async () => {
    const child = bridge({ VEX_PROJECT_ID: PROJECT_ID });
    child.send(initialize(1));
    const response = await child.responseFor(1, 60_000);
    const result = response["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe("2025-06-18");
    expect(result["serverInfo"]).toMatchObject({ name: "vex-studio" });
    // The ack itself never reaches stdout: the bridge consumes it, and stdout
    // carries MCP framing only. A leaked `{"ok":true}` would corrupt the
    // client's parser.
    expect(response["jsonrpc"]).toBe("2.0");
    expect(child.stderr()).toBe("");
  }, 90_000);

  it("takes the project id from --project as well as the environment", async () => {
    const child = bridge({}, ["--project", PROJECT_ID]);
    child.send(initialize(1));
    expect((await child.responseFor(1))["result"]).toBeDefined();
  });

  it("loses nothing from a COALESCED opening write", async () => {
    // Everything in one stdin write, before any ack could have arrived. The
    // bridge waits for the ack before forwarding, and the host's parser is
    // remainder-preserving, so neither frame may be dropped.
    const child = bridge({ VEX_PROJECT_ID: PROJECT_ID });
    child.writeRaw(
      `${JSON.stringify(initialize(1))}\n`
        + `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
        + `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
    );
    expect((await child.responseFor(1))["result"]).toBeDefined();
    const listed = await child.responseFor(2);
    const tools = (listed["result"] as Record<string, unknown>)["tools"];
    expect(Array.isArray(tools)).toBe(true);
    expect((tools as unknown[]).length).toBeGreaterThan(0);
  });

  it("relays a LARGE frame with every byte intact", async () => {
    // A content-blind relay must not reframe, re-chunk into a lost boundary,
    // or bound a frame the host accepts. The payload is well inside the host's
    // 4 MiB inbound line bound and far past any pipe buffer.
    const payload = "z".repeat(512 * 1024);
    let observed = "";
    runCallImpl = async (_projectId, call) => {
      observed = String((call.args as Record<string, unknown>)["query"] ?? "");
      return { kind: "completed", result: { success: true, output: `${observed.length}` } };
    };

    const child = bridge({ VEX_PROJECT_ID: PROJECT_ID });
    child.send(initialize(1));
    await child.responseFor(1, 60_000);
    child.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // The payload rides in a field the tool's own schema declares: an unknown
    // property is rejected by the SDK before `runCall` ever sees it, which
    // would make this test pass on a relay that dropped every byte.
    child.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "vex_ToolSearch", arguments: { query: payload } },
    });
    const response = await child.responseFor(2, 30_000);
    expect(response["error"]).toBeUndefined();
    // The bytes the HOST saw, not the bridge's self-report.
    expect(observed.length).toBe(payload.length);
    expect(observed).toBe(payload);
  }, 90_000);

  it("exits 0 on stdin EOF, after draining the host's answer", async () => {
    const child = bridge({ VEX_PROJECT_ID: PROJECT_ID });
    child.send(initialize(1));
    await child.responseFor(1);
    child.endStdin();
    const exit = await child.waitForExit();
    expect(exit.code).toBe(0);
    expect(child.stderr()).toBe("");
  });

  it("exits 0 when the HOST closes the connection", async () => {
    const child = bridge({ VEX_PROJECT_ID: PROJECT_ID });
    child.send(initialize(1));
    await child.responseFor(1);
    // The host's own teardown, which is the peer FIN the bridge must answer by
    // closing stdout and returning rather than waiting on its blocked stdin.
    await shutdownStudioMcpHost();
    const exit = await child.waitForExit();
    expect(exit.code).toBe(0);
  });

  it("prints ONE actionable line and a distinct exit code for unknown_project", async () => {
    const child = bridge({ VEX_PROJECT_ID: MISSING_PROJECT_ID });
    const exit = await child.waitForExit();
    expect(exit.code).toBe(5);
    const stderr = child.stderr();
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(stderr).toMatch(/^vex-mcp: /);
    expect(stderr).toContain("does not exist");
  });

  /**
   * PIPE SYNTAX ON A UNIX TARGET IS REFUSED BY NAME (contract 1.4), asserted
   * against the BUILT BINARY on Linux.
   *
   * The defect: the override was classified as a pipe from its VALUE on every
   * platform, so this run skipped the whole unix validation table and dialled
   * a relative path, producing an ENOENT sentence about a missing host. The
   * user's actual mistake - a Windows pipe name on Linux - was never named.
   */
  it("refuses a pipe-syntax override on Linux by NAME, not with an ENOENT", async () => {
    const child = bridge({
      VEX_PROJECT_ID: PROJECT_ID,
      VEX_STUDIO_SOCKET: "\\\\.\\pipe\\vex-studio-abc",
    });
    const exit = await child.waitForExit();
    // Exit 2 is "endpoint refused locally", NOT 3 ("dial failed").
    expect(exit.code).toBe(2);
    const stderr = child.stderr();
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(stderr).toContain("override_pipe_on_unix");
    expect(stderr).toContain("not Windows");
    // The old behaviour, which must not come back.
    expect(stderr).not.toMatch(/no Vex Studio host is listening/);
  });

  it("prints ONE actionable line and a distinct exit code when Vex is not listening", async () => {
    await shutdownStudioMcpHost();
    const child = bridge({ VEX_PROJECT_ID: PROJECT_ID });
    const exit = await child.waitForExit();
    expect(exit.code).toBe(3);
    const stderr = child.stderr();
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(stderr).toMatch(/no Vex Studio host is listening|not accepting connections/);
  });

  /**
   * ONE BOUNDED STDERR LINE, asserted against the BUILT BINARY.
   *
   * Three defects met here. The `flag` package wrote its own error line plus a
   * multi-line usage dump to stderr BEFORE the program's own diagnostic, so a
   * contract promising one line produced five. `Diagnostic` kept 512 bytes and
   * THEN appended its omission notice, so the "512-byte" bound produced 578.
   * And the body was budgeted 512 while the writer added `vex-mcp: ` and the
   * newline on top, so the BUILT BINARY put 522 bytes on the pipe.
   *
   * The assertion is therefore on the COMPLETE captured stderr, with NO
   * prefix slicing: what the process actually wrote is the thing the contract
   * bounds, and slicing the prefix off before measuring is what hid the third
   * defect.
   */
  it("writes a COMPLETE stderr line within the bound for a long usage error", async () => {
    // Far past the 512-byte bound, so the omission notice is in play.
    const long = "q".repeat(4000);
    const child = bridge({ VEX_PROJECT_ID: "" }, ["--project", PROJECT_ID, long]);
    const exit = await child.waitForExit();
    expect(exit.code).toBe(1);

    const stderr = child.stderr();
    expect(stderr.endsWith("\n")).toBe(true);
    // ONE line: no `flag` usage dump ahead of it, no wrapped remainder after.
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(stderr.startsWith("vex-mcp: ")).toBe(true);
    // THE WHOLE WIRE PAYLOAD: prefix and trailing newline included, unsliced.
    expect(
      Buffer.byteLength(stderr, "utf8"),
      `the complete stderr line was ${String(Buffer.byteLength(stderr, "utf8"))} bytes`,
    ).toBeLessThanOrEqual(STUDIO_BRIDGE_DIAGNOSTIC_MAX_BYTES);
    expect(stderr).toContain("more bytes omitted");
  });

  it("prints ONE line for an unknown flag, with no usage dump from the flag package", async () => {
    const child = bridge({ VEX_PROJECT_ID: PROJECT_ID }, ["--not-a-flag"]);
    const exit = await child.waitForExit();
    expect(exit.code).toBe(1);

    const stderr = child.stderr();
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(stderr).toContain("accepts --project <uuid>");
    // The two things `flag` itself would have written, and must not have.
    expect(stderr).not.toContain("Usage of vex-mcp");
    expect(stderr).not.toContain("flag provided but not defined");
    // The COMPLETE line, unsliced.
    expect(Buffer.byteLength(stderr, "utf8")).toBeLessThanOrEqual(
      STUDIO_BRIDGE_DIAGNOSTIC_MAX_BYTES,
    );
  });

  it("answers --help on ONE line and exits 0", async () => {
    const child = bridge({ VEX_PROJECT_ID: PROJECT_ID }, ["--help"]);
    const exit = await child.waitForExit();
    // A request that was ANSWERED is not a failure.
    expect(exit.code).toBe(0);
    const stderr = child.stderr();
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(stderr).toContain("usage: vex-mcp");
  });

  it("refuses a usage error locally, without dialling", async () => {
    const child = bridge({ VEX_PROJECT_ID: "" }, ["--project", "not-a-uuid"]);
    const exit = await child.waitForExit();
    expect(exit.code).toBe(1);
    expect(child.stderr()).toContain("must be a UUID");
  });

  it("refuses an override in a directory it does not accept, before dialling", async () => {
    const child = bridge({
      VEX_PROJECT_ID: PROJECT_ID,
      VEX_STUDIO_SOCKET: "relative/vex.sock",
    });
    const exit = await child.waitForExit();
    expect(exit.code).toBe(2);
    expect(child.stderr()).toContain("override_not_absolute");
  });

  it("stops on a signal with its own exit code", async () => {
    const child = bridge({ VEX_PROJECT_ID: PROJECT_ID });
    child.send(initialize(1));
    await child.responseFor(1);
    child.signal("SIGTERM");
    const exit = await child.waitForExit();
    // The bridge handles the signal itself, so the process EXITS rather than
    // being killed by it: a teardown that skipped the connection close would
    // leave the host's approval waiting for a peer that is gone.
    expect(exit.signal).toBeNull();
    expect(exit.code).toBe(12);
  });
});

/**
 * THE WIN32 ARM: the real built `vex-mcp.exe` against the real host, over a
 * real named pipe bound by the real `vex-pipe-front.exe`.
 *
 * WHY IT EXISTS AND WHAT IT CLOSES. Row 4 of the contract's 1.6 matrix is a
 * native pipe round trip. Its HOST half was measured on run 33650332655 by
 * `front-real-binary.test.ts` - the front binds, reports its readback-confirmed
 * flags, relays main's refusal to a real pipe client. Its BRIDGE half had no
 * test at all: every frame the Go bridge and the TypeScript host have ever
 * exchanged travelled over a unix socket. A pipe is not a socket in the two
 * places this arc has already been bitten - it is message-mode with small
 * kernel buffers, and it has NO half-close - so a relay that is correct on
 * `AF_UNIX` is not thereby correct here.
 *
 * THE OVERRIDE, NOT THE DERIVED NAME, on purpose. The derivation is pinned by
 * the vectors on both sides and the derived pipe is what the CI matrix
 * measured; what this arm needs instead is ISOLATION, exactly as the unix arm
 * takes a temp directory rather than the real endpoint. A developer's own Vex
 * may already own the derived name, and `firstInstance` would then fail the
 * bind - a green suite would be reporting the wrong machine's pipe.
 *
 * THE RESOLVER SEAM. `locateStudioPipeFront()` reads `app.isPackaged` when it
 * is given nothing, and there is no Electron runtime under vitest. The mock
 * hands the REAL resolver the dev layout instead of replacing it, so the path
 * this arm spawns is still the one production computes from
 * `bridge/build.sh`'s output, and `pipe-front-path.test.ts` still owns the
 * resolution rules themselves. On linux the real function is passed through
 * untouched.
 */
describe.skipIf(windowsUnavailable)(
  "the built Go bridge against the real Studio host, over the Windows pipe",
  () => {
    let pipeName = "";

    beforeAll(() => {
      // Unique per run: two suites (or two developers on one machine) must not
      // race for a name whose first instance is exclusive by design.
      pipeName = `\\\\.\\pipe\\vex-studio-conformance-${process.pid}-${Date.now().toString(36)}`;
      process.env["VEX_STUDIO_SOCKET"] = pipeName;
    });

    afterAll(() => {
      delete process.env["VEX_STUDIO_SOCKET"];
    });

    beforeEach(async () => {
      runCallImpl = async () => ({ kind: "completed", result: { success: true, output: "ok" } });
      projectExistsImpl = async (projectId) => projectId === PROJECT_ID;
      resetStudioMcpHostForTests();
      markStudioRuntimeReady(beginStudioReadinessEpoch());
      configureStudioMcpHost({
        runCall: (projectId, call, options) => runCallImpl(projectId, call, options),
        projectExists: (projectId) => projectExistsImpl(projectId),
      });
      openStudioMcpAdmission();
      const started = await startStudioMcpHost();
      // The front bound the pipe AND Windows confirmed its flags on readback:
      // the host publishes nothing on a BOUND that did not (contract 1.6).
      expect(started.started).toBe(true);
      expect(studioMcpHostEndpoint()).toBe(pipeName);
    });

    afterEach(async () => {
      for (const child of spawned.splice(0)) child.destroy();
      await shutdownStudioMcpHost();
      resetStudioMcpHostForTests();
      resetStudioReadinessForTests();
    });

    // Generous for the same reason the unix arm's first case is: the host
    // dynamically imports the MCP SDK on the first connection, and here the
    // front process has to come up as well.
    it("handshakes and relays a full initialize round trip over the pipe", async () => {
      const child = bridge({ VEX_PROJECT_ID: PROJECT_ID });
      child.send(initialize(1));
      const response = await child.responseFor(1, 60_000);
      const result = response["result"] as Record<string, unknown>;
      expect(result["protocolVersion"]).toBe("2025-06-18");
      expect(result["serverInfo"]).toMatchObject({ name: "vex-studio" });
      // The ack is consumed by the bridge on this transport too: a leaked
      // `{"ok":true}` would corrupt the client's parser.
      expect(response["jsonrpc"]).toBe("2.0");
      expect(child.stderr()).toBe("");
    }, 90_000);

    it("relays a LARGE frame with every byte intact through the front", async () => {
      // THE PIPE-SPECIFIC RISK. This payload crosses a message-mode pipe with
      // 4096-byte kernel buffers and then the front's four framed planes before
      // it reaches main. A relay that reframed, re-chunked into a lost boundary
      // or dropped a partial message would pass every unix test and fail here.
      const payload = "z".repeat(512 * 1024);
      let observed = "";
      runCallImpl = async (_projectId, call) => {
        observed = String((call.args as Record<string, unknown>)["query"] ?? "");
        return { kind: "completed", result: { success: true, output: `${observed.length}` } };
      };

      const child = bridge({ VEX_PROJECT_ID: PROJECT_ID });
      child.send(initialize(1));
      await child.responseFor(1, 60_000);
      child.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      child.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "vex_ToolSearch", arguments: { query: payload } },
      });
      const response = await child.responseFor(2, 60_000);
      expect(response["error"]).toBeUndefined();
      // The bytes the HOST saw, not the bridge's self-report.
      expect(observed.length).toBe(payload.length);
      expect(observed).toBe(payload);
    }, 90_000);

    it("prints ONE actionable line and exit 5 for unknown_project over the pipe", async () => {
      // The refusal path across the front: main composes the ack, the front
      // relays it byte for byte, and the bridge turns it into the contract's
      // exit code rather than a dial failure.
      const child = bridge({ VEX_PROJECT_ID: MISSING_PROJECT_ID });
      const exit = await child.waitForExit(60_000);
      expect(exit.code).toBe(5);
      const stderr = child.stderr();
      expect(stderr.trimEnd().split("\n")).toHaveLength(1);
      expect(stderr).toMatch(/^vex-mcp: /);
    }, 90_000);

    it("exits 0 on stdin EOF after the drain a pipe cannot half-close", async () => {
      // CONTRACT 3.5's SECOND BRANCH, which only this transport reaches. On a
      // unix socket the bridge half-closes and the host's FIN ends the drain
      // early. A pipe has no half-close, so the drain runs to its 5000 ms bound
      // and the connection is then closed fully - and that is a CLEAN exit 0,
      // not a relay failure, which is exactly the distinction a client would
      // otherwise see collapse into exit 11.
      const child = bridge({ VEX_PROJECT_ID: PROJECT_ID });
      child.send(initialize(1));
      await child.responseFor(1, 60_000);
      child.endStdin();
      const exit = await child.waitForExit(30_000);
      expect(exit.code).toBe(0);
      expect(child.stderr()).toBe("");
    }, 90_000);
  },
);
