/**
 * The poll loop that decides whether the published Postgres port is THIS
 * install's database.
 *
 * The connector and the container corroborator are faked; everything
 * else (the loop, the terminal-verdict policy, the sentences the
 * renderer shows) is the real code. The behavior under test is the one
 * the shadowed-port incident needs: an answer that is provably not our
 * database must stop the loop at once and must never be reported as
 * healthy, while a port that simply has not come up yet must keep being
 * retried.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgConnectEvidence } from "../pg-listener-identity.js";

const mocks = vi.hoisted(() => ({
  pgConnectProbe: vi.fn(),
  probeOwnDbContainerAuth: vi.fn(),
}));

vi.mock("../pg-health.js", () => ({
  pgConnectProbe: mocks.pgConnectProbe,
  DEFAULT_PG_DATABASE: "vex",
  DEFAULT_PG_USER: "vex",
}));

vi.mock("../pg-listener-identity.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../pg-listener-identity.js")
  >();
  return { ...actual, probeOwnDbContainerAuth: mocks.probeOwnDbContainerAuth };
});

import { waitForHealth } from "../health.js";

const ARGS = {
  pgPort: 27432,
  pgPasswordPath: "/tmp/secrets/pg_password",
  installId: "11111111-2222-4333-8444-555555555555",
} as const;

function evidence(e: PgConnectEvidence): PgConnectEvidence {
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("waitForHealth listener identity", () => {
  it("reports usable when the port authenticates and names this install's database", async () => {
    mocks.pgConnectProbe.mockResolvedValue(evidence({ kind: "identity_ok" }));

    const result = await waitForHealth({ ...ARGS });

    expect(result.verdict).toBe("usable");
    expect(mocks.probeOwnDbContainerAuth).not.toHaveBeenCalled();
  });

  it("reports foreign_listener, once and immediately, when our own container accepts the secret the port rejects", async () => {
    mocks.pgConnectProbe.mockResolvedValue(
      evidence({ kind: "auth_rejected", sqlState: "28P01" })
    );
    mocks.probeOwnDbContainerAuth.mockResolvedValue({ kind: "authenticates" });

    const result = await waitForHealth({ ...ARGS });

    expect(result.verdict).toBe("foreign_listener");
    // Terminal: no second connect attempt, no 60s of "not healthy yet".
    expect(mocks.pgConnectProbe).toHaveBeenCalledTimes(1);
    expect(result.message).toContain("27432");
    expect(result.message).toMatch(/mirrored networking/i);
  });

  it("reports foreign_listener when something rejects us on a port our stack is not even running on", async () => {
    mocks.pgConnectProbe.mockResolvedValue(
      evidence({ kind: "auth_rejected", sqlState: "28P01" })
    );
    mocks.probeOwnDbContainerAuth.mockResolvedValue({ kind: "absent" });

    const result = await waitForHealth({ ...ARGS });

    expect(result.verdict).toBe("foreign_listener");
    expect(result.message).toContain("27432");
  });

  it("does NOT accuse a foreign install when our own container rejects the same secret", async () => {
    mocks.pgConnectProbe.mockResolvedValue(
      evidence({ kind: "auth_rejected", sqlState: "28P01" })
    );
    mocks.probeOwnDbContainerAuth.mockResolvedValue({ kind: "rejects" });

    const result = await waitForHealth({ ...ARGS });

    expect(result.verdict).toBe("stale_credentials");
    expect(result.message).not.toMatch(/another vex/i);
  });

  it("stops after one corroboration attempt even when it was inconclusive", async () => {
    mocks.pgConnectProbe.mockResolvedValue(
      evidence({ kind: "auth_rejected", sqlState: "28P01" })
    );
    mocks.probeOwnDbContainerAuth.mockResolvedValue({
      kind: "inconclusive",
      detail: "`docker ps` exited with 1",
    });

    const result = await waitForHealth({ ...ARGS });

    // The verdict stays honest (we could not prove a foreign owner), but
    // the loop must not spawn a `docker exec` every two seconds for a
    // password that cannot start working mid-poll.
    expect(result.verdict).toBe("unreachable");
    expect(mocks.probeOwnDbContainerAuth).toHaveBeenCalledTimes(1);
    expect(mocks.pgConnectProbe).toHaveBeenCalledTimes(1);
    expect(result.message).toContain("28P01");
  });

  it("reports foreign_listener when the server authenticates us into a different database", async () => {
    mocks.pgConnectProbe.mockResolvedValue(
      evidence({
        kind: "identity_mismatch",
        detail: "server reports database other and role other",
      })
    );

    const result = await waitForHealth({ ...ARGS });

    expect(result.verdict).toBe("foreign_listener");
    expect(mocks.probeOwnDbContainerAuth).not.toHaveBeenCalled();
  });

  it("keeps polling a port that has not come up yet and reports unreachable at the deadline", async () => {
    vi.useFakeTimers();
    try {
      mocks.pgConnectProbe.mockResolvedValue(
        evidence({ kind: "no_usable_answer", detail: "timeout expired" })
      );

      const pending = waitForHealth({ ...ARGS });
      await vi.advanceTimersByTimeAsync(70_000);
      const result = await pending;

      expect(result.verdict).toBe("unreachable");
      expect(mocks.pgConnectProbe.mock.calls.length).toBeGreaterThan(1);
      expect(result.message).toContain("timeout expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling while the server reports a transient condition of its own", async () => {
    vi.useFakeTimers();
    try {
      mocks.pgConnectProbe
        .mockResolvedValueOnce(
          evidence({
            kind: "server_transient",
            detail: "server reported SQLSTATE 57P03: starting up",
          })
        )
        .mockResolvedValue(evidence({ kind: "identity_ok" }));

      const pending = waitForHealth({ ...ARGS });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result.verdict).toBe("usable");
      expect(mocks.pgConnectProbe).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops on an aborted signal without probing", async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await waitForHealth({ ...ARGS, signal: ac.signal });

    expect(result.verdict).toBe("unreachable");
    expect(mocks.pgConnectProbe).not.toHaveBeenCalled();
  });

  it("never puts the install's password into a message the renderer sees", async () => {
    mocks.pgConnectProbe.mockResolvedValue(
      evidence({ kind: "auth_rejected", sqlState: "28P01" })
    );
    mocks.probeOwnDbContainerAuth.mockResolvedValue({ kind: "authenticates" });

    const result = await waitForHealth({ ...ARGS });

    expect(result.message).not.toContain("/tmp/secrets/pg_password");
    expect(result.message).not.toMatch(/password authentication failed/i);
  });
});
