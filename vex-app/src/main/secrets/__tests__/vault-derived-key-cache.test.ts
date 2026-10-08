/**
 * VAULT_DERIVED_KEY_CACHE end to end in the main process (fastLighterClick
 * FLC-0): the REAL secret session, the REAL vault with the real scrypt KDF on a
 * temp vault file, the REAL unlock throttle and the REAL `vex:secrets:unlock`
 * and `vex:secrets:lock` IPC handlers. Only Electron, the logger, paths and the
 * Studio/engine side effects of a lock or unlock are stubbed.
 *
 * The async `scrypt` (the vault KDF) is counted, so each step states how many
 * derives it ran. The same script runs with the switch OFF and ON: every
 * outcome, every throttle answer and every unlock attempt's derive count must
 * match; only unlocked-session reads and writes may derive less.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireValue } from "../../../../../src/__tests__/helpers/require-value.js";

const kdf = { calls: 0 };
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    scrypt: (
      password: string,
      salt: Uint8Array,
      keylen: number,
      options: import("node:crypto").ScryptOptions,
      callback: (err: Error | null, derivedKey: Buffer) => void,
    ) => {
      kdf.calls += 1;
      actual.scrypt(password, salt, keylen, options, callback);
    },
  };
});

const paths = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? "/tmp").replace(/\/$/, "");
  const dir = `${root}/vex-flc0-${process.pid}-${Date.now()}`;
  return { dir, vault: `${dir}/secrets.vault.json`, env: `${dir}/.env` };
});

type Handler = (event: unknown, raw: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const logInfo = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: { isPackaged: true, relaunch: vi.fn(), quit: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  dialog: { showMessageBox: vi.fn() },
}));
vi.mock("../vault-reset-journal.js", () => ({ writeVaultResetJournal: vi.fn() }));
vi.mock("../../paths/config-dir.js", () => ({
  ENV_FILE: paths.env,
  SECRETS_VAULT_FILE: paths.vault,
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@vex-agent/inference/registry.js", () => ({ resetProvider: vi.fn() }));
vi.mock("@vex-agent/engine/core/approval-runtime.js", () => ({
  advanceStudioDispatchGeneration: vi.fn().mockResolvedValue({ ok: true, generation: "2" }),
}));
vi.mock("../../studio/mcp-host.js", () => ({
  lockStudioMcpHost: vi.fn(),
  openStudioMcpAdmission: vi.fn(),
  startStudioMcpHost: vi.fn(() => Promise.resolve({ started: true, endpoint: "/tmp/none" })),
}));
vi.mock("../../studio/approval-refusals.js", () => ({
  refuseAllPendingStudioIntents: vi.fn().mockResolvedValue(0),
}));
vi.mock("../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: () => Promise.resolve({ ok: true, data: undefined }),
}));

import { mkdirSync, rmSync } from "node:fs";
import {
  createSecretVault,
  writeSecretVaultExtraSecrets,
  writeSecretVaultSecrets,
} from "@vex-lib/local-secret-vault.js";
import type { LighterTradingCredentialVaultReference } from "@tools/lighter/trading-credentials.js";

const PASSWORD = "correct-horse-battery-staple";
const WRONG_PASSWORD = "correct-horse-battery-stapler";
const PRIVATE_KEY = `0x${"1".repeat(80)}`;
const REFERENCE: LighterTradingCredentialVaultReference = {
  kind: "encrypted_vault_reference",
  environment: "rhc",
  accountIndex: 42,
  apiKeyIndex: 7,
  vaultCredentialId: "lighter/rhc/account-42/api-key-7",
};
const TRUSTED_SENDER = {
  senderFrame: (() => {
    const frame: { url: string; parent: null; top: unknown } = {
      url: "app://vex/index.html",
      parent: null,
      top: null,
    };
    frame.top = frame;
    return frame;
  })(),
};

let now = 1_800_000_000_000;

beforeEach(async () => {
  rmSync(paths.dir, { recursive: true, force: true });
  mkdirSync(paths.dir, { recursive: true });
  await createSecretVault(PASSWORD, { filePath: paths.vault });
  await writeSecretVaultSecrets(PASSWORD, { OPENROUTER_API_KEY: "sk-or-test" }, { filePath: paths.vault });
  await writeSecretVaultExtraSecrets(
    PASSWORD,
    {
      [REFERENCE.vaultCredentialId]: PRIVATE_KEY,
      [`${REFERENCE.vaultCredentialId}/registration-state`]: "key_registered_active",
    },
    { filePath: paths.vault },
  );
  now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  handlers.clear();
  logInfo.mockClear();
  kdf.calls = 0;
  // Seeding runs five real N=2^17 derives; the default 10 s hook timeout is
  // too tight when other suites load the machine.
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(paths.dir, { recursive: true, force: true });
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.JUPITER_API_KEY;
});

interface Harness {
  readonly session: typeof import("../session.js");
  readonly throttle: typeof import("../unlock-throttle.js");
  readonly credential: typeof import("../lighter-trading-credential.js");
  readonly cacheModule: typeof import("../vault-key-cache.js");
  readonly vault: typeof import("@vex-lib/local-secret-vault.js");
  readonly unlock: (password: string) => Promise<unknown>;
  readonly lock: () => Promise<unknown>;
  readonly restore: () => void;
}

/** A fresh main process: new session, throttle, cache and IPC handlers. */
async function loadHarness(cacheOn: boolean): Promise<Harness> {
  vi.resetModules();
  handlers.clear();
  const cacheModule = await import("../vault-key-cache.js");
  const restore = cacheModule.configureVaultDerivedKeyCacheDeps({ derivedKeyCache: cacheOn });
  const session = await import("../session.js");
  const throttle = await import("../unlock-throttle.js");
  const credential = await import("../lighter-trading-credential.js");
  const vault = await import("@vex-lib/local-secret-vault.js");
  const { registerSecretsHandlers } = await import("../../ipc/secrets.js");
  const { CH } = await import("@shared/ipc/channels.js");
  registerSecretsHandlers();
  const unlockHandler = requireValue(handlers.get(CH.secrets.unlock));
  const lockHandler = requireValue(handlers.get(CH.secrets.lock));
  let request = 0;
  return {
    session,
    throttle,
    credential,
    cacheModule,
    vault,
    unlock: (password) => {
      request += 1;
      return unlockHandler(TRUSTED_SENDER, { requestId: `unlock-${request}`, payload: { password } });
    },
    lock: () => {
      request += 1;
      return lockHandler(TRUSTED_SENDER, { requestId: `lock-${request}`, payload: {} });
    },
    restore,
  };
}

/** A comparable outcome: ok + value, or the error code (+ retryAfterMs). */
function outcomeOf(result: unknown): unknown {
  if (typeof result !== "object" || result === null || !("ok" in result)) return { value: result };
  if (result.ok === true) return { ok: true, data: "data" in result ? result.data : undefined };
  const error = "error" in result && typeof result.error === "object" && result.error !== null
    ? result.error
    : {};
  return {
    ok: false,
    code: "code" in error ? error.code : undefined,
    retryAfterMs: "retryAfterMs" in error ? error.retryAfterMs : undefined,
  };
}

interface TraceStep {
  readonly step: string;
  readonly outcome: unknown;
  readonly gate: unknown;
  readonly derives: number;
}

async function runScript(cacheOn: boolean): Promise<{
  readonly trace: readonly TraceStep[];
  readonly entryCounts: Record<string, number>;
}> {
  const h = await loadHarness(cacheOn);
  const trace: TraceStep[] = [];
  const entryCounts: Record<string, number> = {};
  const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    const before = kdf.calls;
    let outcome: unknown;
    try {
      outcome = outcomeOf(await fn());
    } catch (error) {
      outcome = { threw: error instanceof Error ? error.message : String(error) };
    }
    trace.push({ step: name, outcome, gate: h.throttle.checkUnlockAllowed(), derives: kdf.calls - before });
  };
  const reader = h.credential.createUnlockedVaultLighterTradingSecretReader();

  try {
    await step("unlock wrong", () => h.unlock(WRONG_PASSWORD));
    await step("unlock wrong inside backoff", () => h.unlock(WRONG_PASSWORD));
    now += 1_001;
    await step("unlock right", () => h.unlock(PASSWORD));
    await step("read secret", () => h.session.readUnlockedSecret("OPENROUTER_API_KEY"));
    await step("read secret again", () => h.session.readUnlockedSecret("OPENROUTER_API_KEY"));
    await step("lighter key load", () => reader.readTradingApiPrivateKey(REFERENCE));
    await step("presence", async () => (await h.session.getUnlockedSecretPresence()).unlocked);
    await step("write secret", () => h.session.writeUnlockedSecrets({ JUPITER_API_KEY: "jup" }));
    await step("read written secret", () => h.session.readUnlockedSecret("JUPITER_API_KEY"));
    entryCounts.afterWrite = h.cacheModule.vaultDerivedKeyCacheEntryCount();
    // The wallet-export re-auth, exactly as `wallet-export/handler.ts` calls it.
    await step("export re-auth right", () =>
      h.vault.verifySecretVaultPassword(PASSWORD, { filePath: paths.vault }));
    await step("export re-auth wrong", () =>
      h.vault.verifySecretVaultPassword(WRONG_PASSWORD, { filePath: paths.vault }));
    await step("unlock wrong while unlocked", () => h.unlock(WRONG_PASSWORD));
    entryCounts.afterWrongUnlock = h.cacheModule.vaultDerivedKeyCacheEntryCount();
    await step("read after wrong unlock", () => h.session.readUnlockedSecret("OPENROUTER_API_KEY"));
    await step("lock", () => h.lock());
    entryCounts.afterLock = h.cacheModule.vaultDerivedKeyCacheEntryCount();
    await step("read while locked", () => h.session.readUnlockedSecret("OPENROUTER_API_KEY"));
    await step("lighter key load while locked", () => reader.readTradingApiPrivateKey(REFERENCE));
    now += 1_001;
    await step("unlock wrong after lock", () => h.unlock(WRONG_PASSWORD));
    await step("unlock wrong inside second backoff", () => h.unlock(WRONG_PASSWORD));
    now += 2_001;
    await step("unlock right again", () => h.unlock(PASSWORD));
    await step("lighter key load after unlock", () => reader.readTradingApiPrivateKey(REFERENCE));
    await step("lighter key load warm", () => reader.readTradingApiPrivateKey(REFERENCE));
    return { trace, entryCounts };
  } finally {
    await h.session.lockSecretSession();
    h.throttle.resetUnlockThrottle();
    h.restore();
  }
}

describe("VAULT_DERIVED_KEY_CACHE in the secret session", () => {
  it("OFF and ON give identical outcomes and throttle answers; only session reads derive less", async () => {
    const off = await runScript(false);
    const offTimingLines = logInfo.mock.calls.filter((call) => call[0] === "[vault-timing]").length;
    logInfo.mockClear();
    const on = await runScript(true);
    const onTiming = logInfo.mock.calls.filter((call) => call[0] === "[vault-timing]");

    const withoutDerives = (trace: readonly TraceStep[]) =>
      trace.map(({ step, outcome, gate }) => ({ step, outcome, gate }));
    expect(withoutDerives(on.trace)).toEqual(withoutDerives(off.trace));

    // The throttle saw the same wrong passwords at the same moments.
    const byStep = new Map(off.trace.map((entry) => [entry.step, entry]));
    expect(byStep.get("unlock wrong")?.outcome).toMatchObject({ ok: false, code: "wallet.password_invalid" });
    expect(byStep.get("unlock wrong inside backoff")?.outcome).toMatchObject({
      ok: false,
      code: "secrets.unlock_throttled",
      retryAfterMs: 1_000,
    });
    expect(byStep.get("unlock wrong while unlocked")?.outcome).toMatchObject({ code: "wallet.password_invalid" });
    expect(byStep.get("unlock wrong inside second backoff")?.outcome).toMatchObject({
      code: "secrets.unlock_throttled",
      retryAfterMs: 2_000,
    });
    expect(byStep.get("unlock right again")?.outcome).toEqual({ ok: true, data: { unlocked: true } });
    expect(byStep.get("lighter key load warm")?.outcome).toEqual({ value: PRIVATE_KEY });
    expect(byStep.get("read while locked")?.outcome).toMatchObject({ code: "wallet.keystore_locked" });
    expect(byStep.get("export re-auth wrong")?.outcome).toMatchObject({ threw: "Secret vault could not be unlocked." });

    const derives = (trace: readonly TraceStep[]) => trace.map((entry) => entry.derives);
    // OFF is today's path: every vault open derives.
    expect(derives(off.trace)).toEqual([1, 0, 2, 1, 1, 2, 1, 3, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 2, 2, 2]);
    // ON: unlock attempts, re-auth and wrong passwords derive exactly as OFF;
    // session reads hit; a write derives once for its fresh salt.
    expect(derives(on.trace)).toEqual([1, 0, 2, 1, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 2, 1, 0]);
    const AUTHENTICATION_STEPS = [
      "unlock wrong",
      "unlock wrong inside backoff",
      "unlock right",
      "export re-auth right",
      "export re-auth wrong",
      "unlock wrong while unlocked",
      "unlock wrong after lock",
      "unlock wrong inside second backoff",
      "unlock right again",
    ];
    for (const name of AUTHENTICATION_STEPS) {
      const offStep = requireValue(off.trace.find((entry) => entry.step === name));
      const onStep = requireValue(on.trace.find((entry) => entry.step === name));
      expect({ name, derives: onStep.derives }).toEqual({ name, derives: offStep.derives });
    }

    expect(on.entryCounts).toEqual({ afterWrite: 1, afterWrongUnlock: 0, afterLock: 0 });
    expect(off.entryCounts).toEqual({ afterWrite: 0, afterWrongUnlock: 0, afterLock: 0 });

    // `[vault-timing]` only exists for cached operations, and carries no secret.
    expect(offTimingLines).toBe(0);
    expect(onTiming.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(onTiming);
    for (const secret of [PASSWORD, WRONG_PASSWORD, PRIVATE_KEY, "sk-or-test", paths.vault]) {
      expect(serialized).not.toContain(secret);
    }
    const labels = new Set(onTiming.map((call) => (call[1] as { label: string }).label));
    expect([...labels].sort()).toEqual([
      "lighter_key",
      "lighter_registration_state",
      "runtime_env",
      "secret_presence",
      "secret_read",
      "secrets_write",
    ]);
  }, 180_000);

  it("a read in flight when the session locks never puts a key back", async () => {
    const h = await loadHarness(true);
    try {
      await h.unlock(PASSWORD);
      expect(h.cacheModule.vaultDerivedKeyCacheEntryCount()).toBe(0);

      const pending = h.session.readUnlockedSecret("OPENROUTER_API_KEY");
      const lock = h.session.lockSecretSession();
      const result = await pending;
      await lock;

      expect(outcomeOf(result)).toMatchObject({ ok: false, code: "wallet.keystore_locked" });
      expect(h.cacheModule.vaultDerivedKeyCacheEntryCount()).toBe(0);
    } finally {
      await h.session.lockSecretSession();
      h.restore();
    }
  }, 60_000);

  it("every session lifecycle event drops the cache", async () => {
    const h = await loadHarness(true);
    try {
      await h.unlock(PASSWORD);
      await h.session.readUnlockedSecret("OPENROUTER_API_KEY");
      expect(h.cacheModule.vaultDerivedKeyCacheEntryCount()).toBe(1);
      const seen: number[] = [];
      const unsubscribe = h.session.onSecretSessionLifecycle(() => {
        seen.push(h.cacheModule.vaultDerivedKeyCacheEntryCount());
      });

      await h.session.adoptUnlockedPassword(PASSWORD);
      await h.session.readUnlockedSecret("OPENROUTER_API_KEY");
      await h.session.lockSecretSession();
      unsubscribe();

      // Each listener already sees an empty cache: adopt ("unlocked"), lock.
      expect(seen).toEqual([0, 0]);
      expect(h.cacheModule.vaultDerivedKeyCacheEntryCount()).toBe(0);
    } finally {
      await h.session.lockSecretSession();
      h.restore();
    }
  }, 60_000);
});
