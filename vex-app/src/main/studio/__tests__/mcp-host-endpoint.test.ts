/**
 * The endpoint and handshake contract, executed against the GOLDEN VECTORS.
 *
 * `bridge-endpoint-vectors.json` is the one fixture both sides of the wire
 * agree on: this suite runs it against the TypeScript host, and stage A4c runs
 * the same file against the Go bridge's independent re-implementation. Neither
 * side shares code with the other, so a drift shows up as a red test in one of
 * them rather than as a bridge that connects to nothing.
 *
 * The vectors are DATA, not documentation of the code: every case names the
 * property it pins (a fallback trigger, an override refusal, the sun_path
 * bound, a handshake refusal code), so a change here is a deliberate contract
 * change and reads as one in review.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ENDPOINT_ANCESTOR_CHANGED_CODE,
  isWindowsPipePath,
  planStudioEndpoint,
  unprovenWindowsTransport,
  WINDOWS_TRANSPORT_PROVEN,
  studioEndpointFileName,
  studioEndpointHash,
  studioEndpointPipeName,
  STUDIO_SOCKET_OVERRIDE_ENV,
  STUDIO_SUN_PATH_MAX_BYTES,
  type EndpointDirectoryFacts,
} from "../mcp-host/endpoint.js";
import { endpointAncestorChangedRefusal } from "../mcp-host/bind.js";
import {
  parseStudioHandshake,
  encodeStudioHandshakeAck,
  STUDIO_BRIDGE_PROTOCOL_VERSION,
  STUDIO_HANDSHAKE_DEADLINE_MS,
  STUDIO_HANDSHAKE_MAX_BYTES,
} from "../mcp-host/handshake.js";
import {
  STUDIO_MAX_CONNECTIONS,
  STUDIO_MAX_HANDSHAKE_PENDING,
  STUDIO_MAX_LISTENER_SOCKETS,
  STUDIO_MAX_INFLIGHT_GLOBAL,
  STUDIO_HOST_SHUTDOWN_DEADLINE_MS,
  studioConfigDirHashInput,
} from "../mcp-host.js";
import { STUDIO_MAX_INFLIGHT_PER_CONNECTION } from "../mcp-host/connection.js";
import { CONFIG_DIR } from "../../paths/config-dir.js";
import { STUDIO_MAX_PENDING_OUTBOUND } from "../mcp-host/outbound-queue.js";
import {
  STUDIO_MAX_INBOUND_LINE_BYTES,
  STUDIO_MAX_QUEUED_INBOUND_MESSAGES,
} from "@vex-agent/mcp/socket-transport.js";

interface DirectoryFactsFixture {
  readonly isDirectory: boolean;
  readonly uid: number;
  readonly mode: number;
}

interface PlanCase {
  readonly name: string;
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  readonly tmpdir: string;
  readonly configDirRealPath: string;
  readonly env: Record<string, string>;
  readonly directories: Record<string, DirectoryFactsFixture>;
  readonly expect: Record<string, unknown>;
}

interface HandshakeCase {
  readonly name: string;
  readonly line: string;
  readonly expect: Record<string, unknown>;
}

interface HashRuleCase {
  readonly name: string;
  readonly literal: string;
  readonly resolved: string | null;
  readonly hashOf: "literal" | "resolved";
  readonly hash: string;
  readonly literalHash?: string;
  readonly cleaned?: string;
  readonly cleanedHash?: string;
  readonly nfcForm?: string;
  readonly nfcHash?: string;
}

interface Vectors {
  readonly contractVersion: number;
  readonly hash: {
    readonly cases: readonly {
      readonly configDirRealPath: string;
      readonly hash: string;
      readonly fileName: string;
    }[];
  };
  readonly limits: Record<string, number>;
  readonly realpathFallback: string;
  readonly endpointAncestorIdentity: {
    readonly changed: {
      readonly code: string;
      readonly path: string;
      readonly message: string;
    };
  };
  readonly hashRules: { readonly cases: readonly HashRuleCase[] };
  readonly derivation: readonly PlanCase[];
  readonly override: readonly PlanCase[];
  readonly handshake: {
    readonly acks: { readonly accepted: string; readonly refusalCodes: readonly string[] };
    readonly cases: readonly HandshakeCase[];
  };
}

const VECTORS_PATH = path.resolve(
  __dirname,
  "..", "..", "..", "..", "..",
  "src", "vex-agent", "tools", "tool-surface-spec", "studio-mcp",
  "bridge-endpoint-vectors.json",
);

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Vectors;

function runPlan(testCase: PlanCase): ReturnType<typeof planStudioEndpoint> {
  return planStudioEndpoint({
    platform: testCase.platform,
    configDirRealPath: testCase.configDirRealPath,
    env: testCase.env,
    tmpdir: testCase.tmpdir,
    uid: testCase.uid,
    probeDirectory: (dir: string): EndpointDirectoryFacts | null =>
      testCase.directories[dir] ?? null,
  });
}

describe("studio endpoint golden vectors", () => {
  it("the fixture is the contract version this host implements", () => {
    expect(vectors.contractVersion).toBe(1);
  });

  it("formats the ancestor-identity refusal from the shared golden vector", () => {
    const changed = vectors.endpointAncestorIdentity.changed;
    expect(ENDPOINT_ANCESTOR_CHANGED_CODE).toBe(changed.code);
    expect(endpointAncestorChangedRefusal(changed.path)).toBe(changed.message);
  });

  it.each(vectors.hash.cases)(
    "hashes $configDirRealPath to $hash",
    ({ configDirRealPath, hash, fileName }) => {
      expect(studioEndpointHash(configDirRealPath)).toBe(hash);
      expect(studioEndpointFileName(configDirRealPath)).toBe(fileName);
    },
  );

  it("a trailing separator is a DIFFERENT config path and a different endpoint", () => {
    // Pinned because it is the one derivation mistake both sides could make
    // independently: the hash input is the realpath as the platform reports
    // it, with no normalisation of its own.
    expect(studioEndpointHash("/home/alice/.config/vex")).not.toBe(
      studioEndpointHash("/home/alice/.config/vex/"),
    );
  });

  // The FROZEN hash rules, executed. Each case pins one transform that must
  // NOT happen: no Clean, no case folding, no Unicode normalisation, no
  // separator conversion. The companion hashes make each negative rule
  // testable - a forbidden transform must land on a DIFFERENT endpoint, or
  // the rule would be prose nothing can catch.
  it.each(vectors.hashRules.cases)("hash rule - $name", (testCase) => {
    const subject = testCase.hashOf === "resolved" ? testCase.resolved : testCase.literal;
    expect(subject).not.toBeNull();
    expect(studioEndpointHash(subject as string)).toBe(testCase.hash);

    if (testCase.literalHash !== undefined) {
      expect(studioEndpointHash(testCase.literal)).toBe(testCase.literalHash);
      expect(testCase.literalHash).not.toBe(testCase.hash);
    }
    if (testCase.cleaned !== undefined && testCase.cleanedHash !== undefined) {
      expect(studioEndpointHash(testCase.cleaned)).toBe(testCase.cleanedHash);
      // Cleaning the unresolvable literal would produce a DIFFERENT endpoint,
      // which is exactly why the fallback hashes the literal with no Clean.
      expect(path.posix.normalize(testCase.literal)).toBe(testCase.cleaned);
      expect(testCase.cleanedHash).not.toBe(testCase.hash);
    }
    if (testCase.nfcForm !== undefined && testCase.nfcHash !== undefined) {
      expect(studioEndpointHash(testCase.nfcForm)).toBe(testCase.nfcHash);
      expect(testCase.literal.normalize("NFC")).toBe(testCase.nfcForm);
      expect(testCase.nfcHash).not.toBe(testCase.hash);
    }
  });

  it("hashes the EXACT bytes: no BOM, no newline, no case folding", () => {
    const base = "/home/alice/.config/vex";
    for (const variant of [`\uFEFF${base}`, `${base}\n`, base.toUpperCase(), base.replace(/\//g, "\\")]) {
      expect(studioEndpointHash(variant)).not.toBe(studioEndpointHash(base));
    }
  });

  it.each(vectors.derivation)("derivation - $name", (testCase) => {
    expect(runPlan(testCase)).toMatchObject(testCase.expect);
  });

  it.each(vectors.override)("override - $name", (testCase) => {
    expect(runPlan(testCase)).toMatchObject(testCase.expect);
  });

  it("every refused plan carries a sentence that names the remedy", () => {
    for (const testCase of [...vectors.derivation, ...vectors.override]) {
      const plan = runPlan(testCase);
      if (plan.kind !== "refused") continue;
      expect(plan.message.length).toBeGreaterThan(40);
      // Every remaining refusal is a REFUSAL TO START, so they all end the
      // same way. `pending its security probe` was dropped with the Windows
      // adoption: win32 now serves a named pipe rather than refusing.
      expect(plan.message).toMatch(/did not start/);
    }
  });

  it("the bounds in the fixture are the bounds the host enforces", () => {
    expect(vectors.limits["sunPathMaxBytes"]).toBe(STUDIO_SUN_PATH_MAX_BYTES);
    expect(vectors.limits["handshakeMaxBytes"]).toBe(STUDIO_HANDSHAKE_MAX_BYTES);
    expect(vectors.limits["handshakeDeadlineMs"]).toBe(STUDIO_HANDSHAKE_DEADLINE_MS);
    expect(vectors.limits["maxConnections"]).toBe(STUDIO_MAX_CONNECTIONS);
    expect(vectors.limits["maxHandshakePending"]).toBe(STUDIO_MAX_HANDSHAKE_PENDING);
    // The LISTENER cap, which is deliberately one MORE than the two bounds: the
    // overflow socket is what turns "Node dropped you silently" into the typed
    // `at_capacity` ack this contract promises.
    expect(vectors.limits["maxListenerSockets"]).toBe(STUDIO_MAX_LISTENER_SOCKETS);
    expect(STUDIO_MAX_LISTENER_SOCKETS).toBe(
      STUDIO_MAX_CONNECTIONS + STUDIO_MAX_HANDSHAKE_PENDING + 1,
    );
    expect(vectors.limits["maxInFlightPerConnection"]).toBe(
      STUDIO_MAX_INFLIGHT_PER_CONNECTION,
    );
    expect(vectors.limits["maxInFlightGlobal"]).toBe(STUDIO_MAX_INFLIGHT_GLOBAL);
    expect(vectors.limits["shutdownDeadlineMs"]).toBe(STUDIO_HOST_SHUTDOWN_DEADLINE_MS);
    // The three the equality assertion used to omit. A bridge sizing its own
    // buffers from this table needs all of them, and an unasserted row is a row
    // that can drift from the code without a red test.
    expect(vectors.limits["mcpMaxLineBytes"]).toBe(STUDIO_MAX_INBOUND_LINE_BYTES);
    expect(vectors.limits["maxQueuedInboundMessages"]).toBe(
      STUDIO_MAX_QUEUED_INBOUND_MESSAGES,
    );
    expect(vectors.limits["maxPendingOutbound"]).toBe(STUDIO_MAX_PENDING_OUTBOUND);
  });

  it("names the BRIDGE-side bounds, and ties them to the host's own", () => {
    // The bridge is a separate binary on a separate release cadence, so its
    // dial, ack, drain and diagnostic bounds are contract rather than local
    // choices: `bridge/internal/{handshake,relay}` assert the same four rows.
    expect(vectors.limits["bridgeDialTimeoutMs"]).toBe(2_000);
    expect(vectors.limits["bridgeDiagnosticMaxBytes"]).toBe(512);
    // The ack deadline MATCHES the host's handshake deadline, and the drain
    // deadline MATCHES the host's shutdown deadline, so neither side outlives
    // the other waiting for something the other already gave up on.
    expect(vectors.limits["bridgeAckDeadlineMs"]).toBe(STUDIO_HANDSHAKE_DEADLINE_MS);
    expect(vectors.limits["bridgeDrainDeadlineMs"]).toBe(STUDIO_HOST_SHUTDOWN_DEADLINE_MS);
  });

  it("freezes the realpath fallback, so both sides derive the same endpoint", () => {
    // `realpath` fails on every first run, before the config directory exists.
    // The contract answers that with the LITERAL path rather than a refusal, and
    // the Go bridge derives the same string from the same rule.
    expect(vectors.realpathFallback).toBe("literal");
    // The rule, executed: resolvable -> the realpath, unresolvable -> the
    // literal path, never a refusal and never an invented value.
    let resolved: string | null = null;
    try {
      resolved = realpathSync(CONFIG_DIR);
    } catch {
      resolved = null;
    }
    expect(studioConfigDirHashInput()).toBe(resolved ?? CONFIG_DIR);

    // And the unresolvable branch, on a path that provably does not exist.
    const missing = path.join(tmpdir(), `vex-studio-absent-${String(process.pid)}`);
    expect(existsSync(missing)).toBe(false);
    expect(() => realpathSync(missing)).toThrow();
    // Same derivation the bridge performs on the literal string.
    expect(studioEndpointFileName(missing)).toBe(
      `vex-studio-${studioEndpointHash(missing)}.sock`,
    );
  });

  /**
   * WINDOWS SERVES A NAMED PIPE (owner decision, plan revision-log item 47),
   * replacing the `windows_probe_pending` refusal.
   *
   * What this suite can prove from any runner: the derivation, the shared
   * discriminator, and that the derived name satisfies the same syntax rule an
   * override is held to. What it CANNOT prove, and what is therefore the merge
   * gate before a Windows host ships: a second user's duplex connect is denied
   * by the default pipe security descriptor, and a native pipe round trip
   * works. Both run on a WINDOWS RUNNER.
   */
  it("derives a named pipe on win32 from the same hash input as the unix socket", () => {
    const configDir = "C:\\Users\\alice\\AppData\\Roaming\\vex";
    const plan = planStudioEndpoint({
      platform: "win32",
      configDirRealPath: configDir,
      env: {},
      tmpdir: "C:\\Temp",
      uid: -1,
      probeDirectory: () => null,
    });
    expect(plan.kind).toBe("pipe");
    if (plan.kind !== "pipe") return;
    expect(plan.path).toBe(`\\\\.\\pipe\\vex-studio-${studioEndpointHash(configDir)}`);
    // The host must not bind a name the bridge's own validator would refuse.
    expect(isWindowsPipePath(plan.path)).toBe(true);
    // The discriminator is transport-independent: one config directory, one
    // endpoint identity, whichever platform is serving it.
    expect(studioEndpointPipeName(configDir)).toBe(plan.path);
    expect(studioEndpointFileName(configDir)).toBe(
      `vex-studio-${studioEndpointHash(configDir)}.sock`,
    );
  });

  it("gives two config directories two DIFFERENT pipes", () => {
    const first = studioEndpointPipeName("C:\\Users\\alice\\AppData\\Roaming\\vex");
    const second = studioEndpointPipeName("C:\\Users\\bob\\AppData\\Roaming\\vex");
    expect(first).not.toBe(second);
  });

  it("lets VEX_STUDIO_SOCKET override the derived pipe, still validated", () => {
    const derive = (value: string) =>
      planStudioEndpoint({
        platform: "win32",
        configDirRealPath: "C:\\Users\\alice\\AppData\\Roaming\\vex",
        env: { VEX_STUDIO_SOCKET: value },
        tmpdir: "C:\\Temp",
        uid: -1,
        probeDirectory: () => null,
      });
    expect(derive("\\\\.\\pipe\\custom")).toMatchObject({
      kind: "pipe",
      path: "\\\\.\\pipe\\custom",
    });
    expect(derive("\\\\.\\pipe\\a\\b")).toMatchObject({
      kind: "refused",
      code: "override_invalid_pipe",
    });
  });

  it("accepts and rejects Windows pipe syntax structurally", () => {
    expect(isWindowsPipePath("\\\\.\\pipe\\vex-studio")).toBe(true);
    expect(isWindowsPipePath("\\\\?\\pipe\\vex-studio")).toBe(true);
    expect(isWindowsPipePath("\\\\.\\pipe\\")).toBe(false);
    expect(isWindowsPipePath("\\\\.\\pipe\\a\\b")).toBe(false);
    expect(isWindowsPipePath("/tmp/vex.sock")).toBe(false);
  });

  /**
   * THE TRANSPORT GATE (contract 1.6), asserted with the pattern it gates.
   *
   * Both halves in one test on purpose: the derivation, the pipe name and the
   * override syntax above must keep working exactly as the vectors pin them,
   * AND opening the transport must be refused by name. A change that
   * "disabled Windows" by breaking the plan would satisfy one half and fail
   * this one.
   */
  it("refuses to OPEN the derived pipe while the transport is unproven", () => {
    expect(
      WINDOWS_TRANSPORT_PROVEN,
      "this flag may only be flipped by extending the required bridge-windows "
        + "CI job with the contract 1.6 proof matrix",
    ).toBe(false);

    const plan = planStudioEndpoint({
      platform: "win32",
      configDirRealPath: "C:\\Users\\alice\\AppData\\Roaming\\vex",
      env: {},
      tmpdir: "C:\\Temp",
      uid: -1,
      probeDirectory: () => null,
    });
    // The PATTERN survives the gate.
    expect(plan.kind).toBe("pipe");

    const gated = unprovenWindowsTransport(plan);
    expect(gated).not.toBeNull();
    expect(gated).toMatchObject({
      kind: "refused",
      code: "windows_pending_platform_proof",
    });
    if (gated?.kind === "refused") {
      expect(gated.message).toMatch(/did not start/);
      expect(gated.message.length).toBeGreaterThan(40);
    }
  });

  it("leaves a unix plan alone: the gate refuses one transport, not every plan", () => {
    const plan = planStudioEndpoint({
      platform: "linux",
      configDirRealPath: "/home/alice/.config/vex",
      env: {},
      tmpdir: "/tmp",
      uid: 1000,
      probeDirectory: () => null,
    });
    expect(plan.kind).toBe("unix");
    expect(unprovenWindowsTransport(plan)).toBeNull();
  });

  /**
   * PIPE SYNTAX IS A WINDOWS-TARGET STATEMENT (contract 1.4).
   *
   * The vectors pin three shapes; this pins the RULE across both unix targets
   * and every pipe-looking prefix, and pins that win32 still accepts them. The
   * defect it closes: a `\\`-prefixed override was classified as a pipe on
   * EVERY platform, so on Linux the whole ownership/mode/lstat table was
   * skipped and `server.listen` was handed a name that binds an ordinary file
   * in the working directory.
   */
  it("refuses pipe syntax on every unix target, by name", () => {
    for (const platform of ["linux", "darwin"] as const) {
      for (const value of [
        "\\\\.\\pipe\\vex-studio-abc",
        "\\\\?\\pipe\\vex-studio-abc",
        "\\\\.\\pipe\\",
        "\\\\server\\share\\studio.sock",
      ]) {
        const plan = planStudioEndpoint({
          platform,
          configDirRealPath: "/home/alice/.config/vex",
          env: { VEX_STUDIO_SOCKET: value },
          tmpdir: "/tmp",
          uid: 1000,
          probeDirectory: () => null,
        });
        expect(plan, `${platform} + ${value}`).toMatchObject({
          kind: "refused",
          code: "override_pipe_on_unix",
        });
      }
    }

    // The same value on a win32 TARGET is still the accepted pipe override.
    expect(
      planStudioEndpoint({
        platform: "win32",
        configDirRealPath: "C:\\Users\\alice\\AppData\\Roaming\\vex",
        env: { VEX_STUDIO_SOCKET: "\\\\.\\pipe\\vex-studio-abc" },
        tmpdir: "C:\\Temp",
        uid: -1,
        probeDirectory: () => null,
      }),
    ).toMatchObject({ kind: "pipe", path: "\\\\.\\pipe\\vex-studio-abc" });
  });
});

describe("studio handshake golden vectors", () => {
  it.each(vectors.handshake.cases)("handshake - $name", (testCase) => {
    const parsed = parseStudioHandshake(Buffer.from(testCase.line, "utf8"));
    const expected = testCase.expect;
    expect(parsed.kind).toBe(expected["kind"]);
    if (parsed.kind === "accepted") {
      expect(parsed.projectId).toBe(expected["projectId"]);
      expect(parsed.remainder.toString("utf8")).toBe(expected["remainder"]);
    }
    if (parsed.kind === "refused") {
      expect(parsed.code).toBe(expected["code"]);
    }
  });

  it("the coalesced case loses NOT ONE byte of the second frame", () => {
    const initialize = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n';
    const parsed = parseStudioHandshake(
      Buffer.from(
        `{"v":${String(STUDIO_BRIDGE_PROTOCOL_VERSION)},"projectId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}\n${initialize}`,
        "utf8",
      ),
    );
    expect(parsed.kind).toBe("accepted");
    if (parsed.kind !== "accepted") return;
    expect(parsed.remainder.toString("utf8")).toBe(initialize);
  });

  it("a handshake line over the byte bound is refused as malformed", () => {
    const oversized = `{"v":1,"pad":"${"x".repeat(STUDIO_HANDSHAKE_MAX_BYTES)}"}\n`;
    const parsed = parseStudioHandshake(Buffer.from(oversized, "utf8"));
    expect(parsed.kind).toBe("refused");
    if (parsed.kind !== "refused") return;
    expect(parsed.code).toBe("malformed");
  });

  it("encodes the two ack shapes exactly as the fixture names them", () => {
    expect(encodeStudioHandshakeAck({ ok: true })).toBe(
      vectors.handshake.acks.accepted,
    );
    for (const code of vectors.handshake.acks.refusalCodes) {
      const line = encodeStudioHandshakeAck({
        ok: false,
        code: code as "malformed",
        message: "why",
      });
      expect(JSON.parse(line) as Record<string, unknown>).toEqual({
        ok: false,
        code,
        message: "why",
      });
      expect(line.endsWith("\n")).toBe(true);
    }
  });
});

/**
 * HOST-INDEPENDENCE. The defect these tests close is that `planStudioEndpoint`
 * answers for a TARGET `platform` that arrives as an input, but used to build
 * its paths with the ambient `node:path`, which follows the HOST. On Linux the
 * two coincide, so every vector was green; on a Windows runner running the
 * same linux and darwin rows, `path.join("/run/user/1000", name)` is
 * `\run\user\1000\...` and `path.dirname("/srv/sockets/x.sock")` is
 * `\srv\sockets`.
 *
 * These assertions are worth running from Linux precisely BECAUSE they do not
 * depend on the host: one is a static gate over the module's source, and the
 * rest compare the planner's output against expectations derived from the
 * TARGET's own flavour, so they hold byte for byte wherever CI runs them.
 */
describe("studio endpoint path flavour follows the target, not the host", () => {
  const ENDPOINT_SOURCE = readFileSync(
    path.resolve(__dirname, "..", "mcp-host", "endpoint.ts"),
    "utf8",
  );

  it("the module performs no path operation through the ambient host flavour", () => {
    // The static gate. `flavour(platform)` is the only admitted entry point;
    // a bare `path.join`/`path.dirname`/`path.isAbsolute`/`path.resolve` is
    // the defect itself and is refused by name rather than left to a runner
    // on another operating system to discover.
    const code = ENDPOINT_SOURCE.split("\n")
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .join("\n");
    for (const forbidden of [
      "path.join(",
      "path.dirname(",
      "path.isAbsolute(",
      "path.resolve(",
      "path.normalize(",
      "path.basename(",
    ]) {
      expect(code, `endpoint.ts calls ${forbidden} on the host flavour`).not.toContain(
        forbidden,
      );
    }
    expect(code).toContain("flavour(input.platform)");
  });

  it.each([...vectors.derivation, ...vectors.override])(
    "$name carries the target's separators",
    (testCase) => {
      const plan = runPlan(testCase);
      if (plan.kind === "unix") {
        // A unix-target plan is posix all the way through, whatever separator
        // the host uses.
        expect(plan.path).not.toContain("\\");
        expect(plan.parentDir).not.toContain("\\");
        expect(plan.path.startsWith("/")).toBe(true);
      }
      if (plan.kind === "pipe") {
        // A pipe name is win32 vocabulary and must never acquire a forward
        // slash from a posix host.
        expect(plan.path).not.toContain("/");
        expect(isWindowsPipePath(plan.path)).toBe(true);
      }
    },
  );

  it("the vector table actually carries BOTH directions", () => {
    // Without this, a future edit that drops the win32 rows would silently
    // turn the table above into a posix-only test.
    const platforms = new Set(
      [...vectors.derivation, ...vectors.override].map((testCase) => testCase.platform),
    );
    expect(platforms.has("win32")).toBe(true);
    expect(platforms.has("linux") || platforms.has("darwin")).toBe(true);
  });

  it("the unix derivation sites equal the POSIX join for the target", () => {
    const configDirRealPath = "/home/alice/.config/vex";
    const fileName = studioEndpointFileName(configDirRealPath);

    const runtimeDir = "/run/user/1000";
    const xdg = planStudioEndpoint({
      platform: "linux",
      configDirRealPath,
      env: { XDG_RUNTIME_DIR: runtimeDir },
      tmpdir: "/tmp",
      uid: 1000,
      probeDirectory: (dir) =>
        dir === runtimeDir ? { isDirectory: true, uid: 1000, mode: 0o700 } : null,
    });
    expect(xdg.kind === "unix" && xdg.path).toBe(path.posix.join(runtimeDir, fileName));

    const fallback = planStudioEndpoint({
      platform: "darwin",
      configDirRealPath,
      env: {},
      tmpdir: "/var/folders/ab/T",
      uid: 501,
      probeDirectory: () => null,
    });
    const wantParent = path.posix.join("/var/folders/ab/T", "vex-studio-501");
    expect(fallback.kind === "unix" && fallback.parentDir).toBe(wantParent);
    expect(fallback.kind === "unix" && fallback.path).toBe(
      path.posix.join(wantParent, fileName),
    );
  });

  it.each([
    { override: "/srv/sockets/vex.sock", parent: "/srv/sockets" },
    // Doubled separator: `path.posix.dirname` keeps it, and the Go bridge's
    // `DirnamePosix` keeps it too. A `Clean`-ing dirname on either side would
    // stat a different directory than the other side reports.
    { override: "/srv//sockets/vex.sock", parent: "/srv//sockets" },
    { override: "/vex.sock", parent: "/" },
  ])("override $override resolves its parent with the POSIX dirname", ({ override, parent }) => {
    const plan = planStudioEndpoint({
      platform: "linux",
      configDirRealPath: "/home/alice/.config/vex",
      env: { [STUDIO_SOCKET_OVERRIDE_ENV]: override },
      tmpdir: "/tmp",
      uid: 1000,
      probeDirectory: (dir) =>
        dir === parent ? { isDirectory: true, uid: 1000, mode: 0o700 } : null,
    });
    // The probe answers ONLY for the posix dirname, so any other spelling
    // refuses with `override_parent_missing`.
    expect(plan.kind).toBe("unix");
    expect(plan.kind === "unix" && plan.parentDir).toBe(parent);
    expect(path.posix.dirname(override)).toBe(parent);
  });
});
