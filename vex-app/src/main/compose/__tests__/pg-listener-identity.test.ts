/**
 * Classification of what answers on the published Postgres port.
 *
 * Every row is anchored to a LIVE observation made on the shadowed
 * development box (WSL2 mirrored networking, 2026-09-01): a foreign Vex
 * Postgres on 127.0.0.1:27432 answered `28P01`; a closed port answered
 * `ECONNREFUSED`; an HTTP listener and a Redis listener produced
 * `timeout expired` / `Connection terminated unexpectedly` with NO
 * SQLSTATE at all. The table exists so a future edit cannot quietly
 * turn one of those into another.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const runSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../docker/spawn-runner.js", () => ({ runSpawn: runSpawnMock }));

import {
  classifyPgConnectError,
  isSafePgIdentifier,
  probeOwnDbContainerAuth,
  verdictForAuthRejection,
  type PgConnectEvidence,
  type PgIdentityVerdict,
  type PgOwnContainerEvidence,
} from "../pg-listener-identity.js";

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: "FATAL" });
}

function socketError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, errno: -111 });
}

describe("classifyPgConnectError", () => {
  const rows: ReadonlyArray<
    readonly [string, unknown, PgConnectEvidence["kind"]]
  > = [
    [
      "foreign Postgres rejecting this install's password (measured live)",
      pgError("28P01", 'password authentication failed for user "vex"'),
      "auth_rejected",
    ],
    [
      "server refusing the authorization outright",
      pgError("28000", "no pg_hba.conf entry for host"),
      "auth_rejected",
    ],
    [
      "server that does not host this install's database",
      pgError("3D000", 'database "vex" does not exist'),
      "auth_rejected",
    ],
    [
      "our own Postgres still starting up",
      pgError("57P03", "the database system is starting up"),
      "server_transient",
    ],
    [
      "our own Postgres out of connection slots",
      pgError("53300", "sorry, too many clients already"),
      "server_transient",
    ],
    [
      "an unmapped SQLSTATE still names its code instead of collapsing",
      pgError("XX000", "internal error"),
      "server_transient",
    ],
    [
      "closed port (measured live)",
      socketError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:39999"),
      "no_usable_answer",
    ],
    [
      "non-Postgres listener that never speaks (measured live: HTTP, Redis)",
      new Error("timeout expired"),
      "no_usable_answer",
    ],
    [
      "listener that closes the socket (measured live: a Node HTTP server)",
      new Error("Connection terminated unexpectedly"),
      "no_usable_answer",
    ],
    ["a non-Error rejection", "boom", "no_usable_answer"],
  ];

  it.each(rows)("%s", (_name, err, expected) => {
    expect(classifyPgConnectError(err).kind).toBe(expected);
  });

  it("names the SQLSTATE it could not map, so no branch reads as an unexpected error", () => {
    const evidence = classifyPgConnectError(pgError("XX000", "internal error"));
    expect(evidence.kind).toBe("server_transient");
    if (evidence.kind !== "server_transient") throw new Error("unreachable");
    expect(evidence.detail).toContain("XX000");
  });

  it("does not mistake a libuv errno for a SQLSTATE", () => {
    // Both arrive in `err.code`, and `EPIPE` satisfies the SQLSTATE
    // character class on its own. Only an error the server sent carries
    // `severity`, so a socket error must never be read as a server
    // verdict about our credentials.
    expect(
      classifyPgConnectError(socketError("EPIPE", "broken pipe")).kind
    ).toBe("no_usable_answer");
    expect(
      classifyPgConnectError(socketError("28P01", "not from a server")).kind
    ).toBe("no_usable_answer");
  });
});

describe("verdictForAuthRejection", () => {
  const rows: ReadonlyArray<
    readonly [string, PgOwnContainerEvidence, PgIdentityVerdict]
  > = [
    [
      "our container accepts the same secret, so the port is not ours",
      { kind: "authenticates" },
      "foreign_listener",
    ],
    [
      "our container is not even running, so the rejecting listener is not ours",
      { kind: "absent" },
      "foreign_listener",
    ],
    [
      "our container rejects it too: our stored password is stale, not shadowed",
      { kind: "rejects" },
      "stale_credentials",
    ],
    [
      "corroboration unavailable: report the weaker outcome, never accuse",
      { kind: "inconclusive", detail: "docker ps exited with 1" },
      "unreachable",
    ],
  ];

  it.each(rows)("%s", (_name, evidence, expected) => {
    expect(verdictForAuthRejection(evidence)).toBe(expected);
  });
});

describe("isSafePgIdentifier", () => {
  const accepted: ReadonlyArray<readonly [string, string]> = [
    ["the name the compose template actually uses", "vex"],
    ["digits and underscores after the first character", "vex_1"],
    ["a leading underscore, which Postgres allows unquoted", "_x"],
    ["exactly the 63-byte Postgres identifier bound", "v".repeat(63)],
  ];

  it.each(accepted)("accepts %s", (_name, value) => {
    expect(isSafePgIdentifier(value)).toBe(true);
  });

  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["the empty string", ""],
    ["a command separator", "vex;rm -rf /"],
    ["a double quote that would escape the psql argument", 'vex"; echo'],
    ["a single quote that would escape the sh -c string", "vex'; echo"],
    ["an uppercase name, which Postgres would fold anyway", "Vex"],
    ["a hyphen, which is only legal when quoted", "vex-app"],
    ["a name one byte past the identifier bound", "v".repeat(64)],
    ["a space", "vex db"],
    ["command substitution", "vex$(id)"],
    ["backtick substitution", "vex`id`"],
    ["a newline, which would start a second shell command", "vex\nid"],
    ["a null byte", "vex\u0000"],
  ];

  it.each(rejected)("rejects %s", (_name, value) => {
    expect(isSafePgIdentifier(value)).toBe(false);
  });
});

describe("probeOwnDbContainerAuth identifier guard", () => {
  const INSTALL_ID = "11111111-2222-4333-8444-555555555555";

  beforeEach(() => {
    runSpawnMock.mockReset();
  });

  it("refuses an unsafe user without spawning anything", async () => {
    const evidence = await probeOwnDbContainerAuth({
      installId: INSTALL_ID,
      database: "vex",
      user: 'vex"; cat /run/secrets/pg_password #',
    });

    expect(evidence.kind).toBe("inconclusive");
    if (evidence.kind !== "inconclusive") throw new Error("unreachable");
    expect(evidence.detail).toContain("`user`");
    // The value could be attacker-shaped, so it must not travel into a
    // message an operator or a log will read back.
    expect(evidence.detail).not.toContain("pg_password");
    // The point of the guard: the shell sink is never reached at all.
    expect(runSpawnMock).not.toHaveBeenCalled();
  });

  it("refuses an unsafe database without spawning anything", async () => {
    const evidence = await probeOwnDbContainerAuth({
      installId: INSTALL_ID,
      database: "vex; DROP DATABASE vex",
      user: "vex",
    });

    expect(evidence.kind).toBe("inconclusive");
    if (evidence.kind !== "inconclusive") throw new Error("unreachable");
    expect(evidence.detail).toContain("`database`");
    expect(evidence.detail).not.toContain("DROP");
    expect(runSpawnMock).not.toHaveBeenCalled();
  });

  it("still probes when both identifiers are safe, so the guard is not a blanket refusal", async () => {
    runSpawnMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      aborted: false,
      timedOut: false,
    });

    const evidence = await probeOwnDbContainerAuth({
      installId: INSTALL_ID,
      database: "vex",
      user: "vex",
    });

    expect(evidence.kind).toBe("absent");
    expect(runSpawnMock).toHaveBeenCalledTimes(1);
  });
});
