/**
 * The Vex Studio half of a relock.
 *
 * The one property that must hold whatever the database is doing: the
 * SYNCHRONOUS SCRUB and the signing revocation happen FIRST, before any await,
 * and a failure in either Studio step is logged rather than thrown past them.
 *
 * The order after the scrub is also a safety property and is asserted here:
 *
 *   0. CLOSE THE MCP HOST - mark it locked, stop the listener, destroy every
 *      registered socket. Synchronous, and before the advance: each blocked
 *      MCP call's abort chain starts here carrying the TRUSTED cause `lock`,
 *      and the advance must not queue behind network teardown.
 *   1. ADVANCE the durable dispatch generation - after this commits, no queued
 *      Studio action can take a dispatch slot;
 *   2. REFUSE the pending intents durably, which is what releases the blocked
 *      MCP calls.
 *
 * Never the other way round: releasing a waiter while its row could still be
 * dispatched is exactly the hole the generation exists to close.
 *
 * ## The POISON
 *
 * An advance that FAILS leaves the old generation current - which is the value
 * every pre-lock intent recorded, so the fence never moved and a pre-lock
 * intent would still be dispatchable once the database came back. That is the
 * opposite of "more restricted", and it is why a failed advance now poisons the
 * Studio runtime: no queueing, no dispatch, until an advance succeeds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const advanceStudioDispatchGeneration = vi.fn();
const refuseAllPendingStudioIntents = vi.fn();
const clearKeystorePasswordProvider = vi.fn();
const setKeystorePasswordProvider = vi.fn();
const order: string[] = [];

vi.mock("@vex-lib/local-secret-vault.js", () => ({
  applySecretVaultToProcessEnv: vi.fn(),
  createSecretVault: vi.fn(),
  getSecretVaultStatus: vi.fn(() => ({ configured: true })),
  LocalSecretVaultError: class extends Error {},
  stripManagedSecretsFromDotenvFile: vi.fn(),
  unlockSecretVault: vi.fn(),
  writeSecretVaultSecrets: vi.fn(),
}));
vi.mock("@vex-lib/secret-keys.js", () => ({
  MASTER_PASSWORD_ENV_KEY: "VEX_MASTER_PASSWORD",
  VAULT_SECRET_KEYS: ["JUPITER_API_KEY"] as const,
  MANAGED_SECRET_ENV_KEYS: ["VEX_MASTER_PASSWORD", "JUPITER_API_KEY"] as const,
}));
vi.mock("@vex-agent/inference/registry.js", () => ({ resetProvider: vi.fn() }));
vi.mock("@vex-agent/engine/core/approval-runtime.js", () => ({
  advanceStudioDispatchGeneration: (...args: unknown[]) => {
    order.push("advance");
    return advanceStudioDispatchGeneration(...args);
  },
}));
const lockStudioMcpHost = vi.fn();
vi.mock("../../studio/mcp-host.js", () => ({
  lockStudioMcpHost: (cause?: string) => {
    order.push("host_lock");
    lockStudioMcpHost(cause);
  },
  openStudioMcpAdmission: () => {
    order.push("host_unlock");
  },
  startStudioMcpHost: () => {
    order.push("host_start");
    return Promise.resolve({ started: true, endpoint: "/tmp/not-in-this-test" });
  },
}));
vi.mock("../../studio/approval-refusals.js", () => ({
  refuseAllPendingStudioIntents: (...args: unknown[]) => {
    order.push("refuse");
    return refuseAllPendingStudioIntents(...args);
  },
}));
vi.mock("../../paths/config-dir.js", () => ({
  ENV_FILE: "/tmp/vex-test-env",
  SECRETS_VAULT_FILE: "/tmp/vex-test-vault",
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@utils/env.js", () => ({
  clearKeystorePasswordProvider: () => {
    order.push("revoke_signing");
    clearKeystorePasswordProvider();
  },
  setKeystorePasswordProvider: () => setKeystorePasswordProvider(),
}));

const session = await import("../session.js");

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
  session.resetStudioDispatchPoisonForTests();
  advanceStudioDispatchGeneration.mockResolvedValue({ ok: true, generation: "2" });
  refuseAllPendingStudioIntents.mockResolvedValue(1);
  process.env.JUPITER_API_KEY = "secret-value";
});

afterEach(() => {
  session.resetStudioDispatchPoisonForTests();
  vi.useRealTimers();
  delete process.env.JUPITER_API_KEY;
});

describe("lockSecretSession", () => {
  it("scrubs and revokes signing SYNCHRONOUSLY, before the Studio steps", async () => {
    const pending = session.lockSecretSession();
    // Not awaited yet: the scrub must already have happened.
    expect(process.env.JUPITER_API_KEY).toBeUndefined();
    expect(order[0]).toBe("revoke_signing");
    // STEP 2 IS SYNCHRONOUS TOO. The listener is closed and every socket is
    // destroyed before the first await, so the dispatch-generation advance
    // that follows never waits on a peer noticing its socket is gone.
    expect(order[1]).toBe("host_lock");
    expect(session.isStudioSessionTransitionInProgress()).toBe(true);
    expect(session.isStudioDispatchPoisoned()).toBe(true);
    await pending;
    expect(order).toEqual(["revoke_signing", "host_lock", "advance", "refuse"]);
    expect(session.isStudioSessionTransitionInProgress()).toBe(false);
  });

  it("still scrubs, and still advances the fence, when the refusal fails", async () => {
    // The database is gone. The lock's security guarantee is the scrub and the
    // revoked signer, both of which already happened; the durable refusal is
    // reconciled by the scheduled sweep, which expires the rows anyway.
    refuseAllPendingStudioIntents.mockResolvedValue(null);
    await session.lockSecretSession();
    expect(process.env.JUPITER_API_KEY).toBeUndefined();
    expect(advanceStudioDispatchGeneration).toHaveBeenCalledTimes(1);
    expect(session.isSecretSessionUnlocked()).toBe(false);
  });

  it("does not throw when the refusal owner itself rejects", async () => {
    refuseAllPendingStudioIntents.mockRejectedValue(new Error("db down"));
    await expect(session.lockSecretSession()).resolves.toBeUndefined();
    expect(process.env.JUPITER_API_KEY).toBeUndefined();
  });

  it("does not throw when the generation advance fails", async () => {
    advanceStudioDispatchGeneration.mockResolvedValue({ ok: false, cause: new Error("x") });
    await expect(session.lockSecretSession()).resolves.toBeUndefined();
    // The refusal still runs: a fence that did not move makes the durable
    // refusal MORE important, not less.
    expect(refuseAllPendingStudioIntents).toHaveBeenCalledWith("lock");
    // And the runtime is POISONED: until an advance succeeds, Vex cannot prove
    // that a queued Studio action would be stopped by this lock.
    expect(session.isStudioDispatchPoisoned()).toBe(true);
  });

  it("poisons when the advance THROWS as well", async () => {
    advanceStudioDispatchGeneration.mockRejectedValue(new Error("db down"));
    await session.lockSecretSession();
    expect(session.isStudioDispatchPoisoned()).toBe(true);
  });

  it("leaves the runtime available when the advance committed", async () => {
    await session.lockSecretSession();
    expect(session.isStudioDispatchPoisoned()).toBe(false);
  });
});

describe("the poison and its bounded retry", () => {
  it("retries on a timer and CLEARS the poison when an advance finally commits", async () => {
    vi.useFakeTimers();
    advanceStudioDispatchGeneration.mockResolvedValue({ ok: false, cause: new Error("x") });
    await session.lockSecretSession();
    expect(session.isStudioDispatchPoisoned()).toBe(true);

    advanceStudioDispatchGeneration.mockResolvedValue({ ok: true, generation: "9" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(session.isStudioDispatchPoisoned()).toBe(false);

    // Cleared means STOPPED: no timer keeps running once the fence is proven.
    const callsAfterClear = advanceStudioDispatchGeneration.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(advanceStudioDispatchGeneration.mock.calls.length).toBe(callsAfterClear);
  });

  it("stops the retry when the quit cleanup disposes it", async () => {
    vi.useFakeTimers();
    advanceStudioDispatchGeneration.mockResolvedValue({ ok: false, cause: new Error("x") });
    await session.lockSecretSession();
    const callsAtDispose = advanceStudioDispatchGeneration.mock.calls.length;
    session.disposeStudioDispatchPoisonRetry();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(advanceStudioDispatchGeneration.mock.calls.length).toBe(callsAtDispose);
  });

  it("keeps Studio closed across unlock until a failed typed refusal sweep repairs", async () => {
    vi.useFakeTimers();
    refuseAllPendingStudioIntents.mockResolvedValueOnce(null);
    await session.lockSecretSession("vex_quit");

    expect(session.hasPendingStudioRefusalRepair()).toBe(true);
    expect(session.isStudioDispatchPoisoned()).toBe(true);

    // A fresh generation is necessary but not sufficient. ADMISSION must not
    // reopen while the durable quit refusal remains unwritten. (The listener
    // itself is not part of this decision any more: it stays bound, refusing
    // every peer with the typed `locked` ack.)
    order.length = 0;
    await session.unlockSecretSession("pw");
    expect(session.isSecretSessionUnlocked()).toBe(true);
    expect(session.isStudioDispatchPoisoned()).toBe(true);
    expect(order).not.toContain("host_unlock");

    const advancesBeforeRepair = advanceStudioDispatchGeneration.mock.calls.length;
    refuseAllPendingStudioIntents.mockResolvedValue(2);
    await vi.advanceTimersByTimeAsync(15_000);

    // The owner retries the WRITE obligation with the original machine cause.
    // It does not advance the already-proven generation again.
    expect(refuseAllPendingStudioIntents).toHaveBeenLastCalledWith("vex_quit");
    expect(advanceStudioDispatchGeneration.mock.calls.length).toBe(
      advancesBeforeRepair,
    );
    expect(session.hasPendingStudioRefusalRepair()).toBe(false);
    expect(session.isStudioDispatchPoisoned()).toBe(false);
    expect(order).toContain("host_unlock");
  });
});

describe("unlockSecretSession", () => {
  it("advances the generation too, so a pre-lock intent is never resurrected", async () => {
    const outcome = await session.unlockSecretSession("pw");
    expect(outcome.ok).toBe(true);
    expect(session.isSecretSessionUnlocked()).toBe(true);
    expect(advanceStudioDispatchGeneration).toHaveBeenCalledTimes(1);
    expect(session.isStudioDispatchPoisoned()).toBe(false);
  });

  it("AWAITS the advance, so a failure has poisoned the runtime before it reports success", async () => {
    let resolveAdvance: (value: unknown) => void = () => {
      throw new Error("advance resolver was not installed");
    };
    let resolverInstalled = false;
    advanceStudioDispatchGeneration.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAdvance = resolve;
          resolverInstalled = true;
        }),
    );
    const pending = session.unlockSecretSession("pw");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(resolverInstalled).toBe(true);
    });
    // Still blocked on the advance: fire-and-forget would have returned here.
    expect(settled).toBe(false);
    expect(session.isStudioSessionTransitionInProgress()).toBe(true);
    resolveAdvance({
      ok: false,
      cause: new Error("db down"),
    });
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    expect(session.isStudioDispatchPoisoned()).toBe(true);
  });

  it("a successful unlock advance CLEARS a poison left by a failed lock advance", async () => {
    advanceStudioDispatchGeneration.mockResolvedValue({ ok: false, cause: new Error("x") });
    await session.lockSecretSession();
    expect(session.isStudioDispatchPoisoned()).toBe(true);
    advanceStudioDispatchGeneration.mockResolvedValue({ ok: true, generation: "4" });
    await session.unlockSecretSession("pw");
    expect(session.isStudioDispatchPoisoned()).toBe(false);
  });
});

/**
 * THE TYPED LOCK CAUSE.
 *
 * A quit used to reach `lockSecretSession()` with the default, so its durable
 * refusal pass stamped `lock` on every pending Studio intent it won the CAS
 * for, while the ordered quit cleanup stamped `vex_quit` on the rest. One
 * event, two stories in one audit column, and which one a reader saw depended
 * on a race. The cause is now threaded from the ONE caller that knows it, all
 * the way to the refusal owner and to the cause each blocked MCP call reports.
 */
describe("the lock cause", () => {
  it("defaults to `lock` for a user-initiated relock", async () => {
    await session.lockSecretSession();
    expect(lockStudioMcpHost).toHaveBeenCalledWith("lock");
    expect(advanceStudioDispatchGeneration).toHaveBeenCalledWith("lock");
    expect(refuseAllPendingStudioIntents).toHaveBeenCalledWith("lock");
  });

  it("stamps `vex_quit` everywhere when the quit hooks lock", async () => {
    await session.lockSecretSession("vex_quit");
    // BOTH owners, one cause: the host hands `vex_quit` to every blocked call's
    // abort chain, and the durable refusal writes the same value.
    expect(lockStudioMcpHost).toHaveBeenCalledWith("vex_quit");
    expect(advanceStudioDispatchGeneration).toHaveBeenCalledWith("vex_quit");
    expect(refuseAllPendingStudioIntents).toHaveBeenCalledWith("vex_quit");
    // And the scrub still happened: the cause changes the audit story, never
    // the security guarantee.
    expect(process.env.JUPITER_API_KEY).toBeUndefined();
    expect(session.isSecretSessionUnlocked()).toBe(false);
  });

  it("keeps the ordered sequence whichever cause is given", async () => {
    await session.lockSecretSession("vex_quit");
    expect(order).toEqual(["revoke_signing", "host_lock", "advance", "refuse"]);
  });
});

/**
 * THE DEFENSIVE RELOCK.
 *
 * A vault that cannot be read is the state where a lock matters most, and the
 * presence probe's failure path used to scrub and stop there: the MCP listener
 * stayed up serving a vault nobody could read, the dispatch fence never
 * advanced, and every pending Studio intent stayed pending. It now runs the
 * SAME complete lock flow, and the synchronous half still completes before this
 * synchronous getter returns.
 */
describe("the defensive relock in getUnlockedSecretPresence", () => {
  it("closes the host and advances the fence, not just the scrub", async () => {
    const vault = await import("@vex-lib/local-secret-vault.js");
    vi.mocked(vault.unlockSecretVault).mockReturnValue({
      version: 1,
      secrets: { JUPITER_API_KEY: "x" },
    });
    await session.unlockSecretSession("pw");
    order.length = 0;
    vi.clearAllMocks();
    advanceStudioDispatchGeneration.mockResolvedValue({ ok: true, generation: "9" });
    refuseAllPendingStudioIntents.mockResolvedValue(0);

    // The probe now fails: the vault cannot be read with the cached password.
    vi.mocked(vault.unlockSecretVault).mockImplementation(() => {
      throw new Error("vault unreadable");
    });
    process.env.JUPITER_API_KEY = "secret-value";

    const presence = session.getUnlockedSecretPresence();

    // SYNCHRONOUS HALF, already done when this returned.
    expect(presence.unlocked).toBe(false);
    expect(process.env.JUPITER_API_KEY).toBeUndefined();
    expect(order.slice(0, 2)).toEqual(["revoke_signing", "host_lock"]);
    expect(session.isSecretSessionUnlocked()).toBe(false);

    // ASYNCHRONOUS REMAINDER, on the microtasks after it.
    await vi.waitFor(() => {
      expect(advanceStudioDispatchGeneration).toHaveBeenCalledTimes(1);
      expect(refuseAllPendingStudioIntents).toHaveBeenCalledWith("lock");
    });
  });
});
