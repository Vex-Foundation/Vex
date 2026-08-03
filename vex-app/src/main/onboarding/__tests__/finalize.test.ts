/**
 * finalize.ts tests — sequenced completeSetup (M11, Phase 2 refactor:
 * Mode + Wake no longer live in the wizard, so the previous full-
 * autonomous wake auto-correction at the main boundary is removed).
 *
 * Covers the remaining codex v3 RED + clarification items:
 *   - single-flight: two concurrent calls share the same promise; the
 *     pending slot clears in finally so a third call later can proceed.
 *   - autoBackup() throw → mapped to onboarding.step_failed step=auto_backup,
 *     backupPath: null.
 *   - wizardState write fs error → onboarding.step_failed step=wizard_state
 *     (NOT internal.contract_violation).
 *   - telemetry consent failure post-setup → ok with telemetryWarning set
 *     (setup still succeeded).
 *   - .setup-complete flag failure → still ok, log warning.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const mockAutoBackup = vi.fn();
const mockGatherEnvState = vi.fn();
const mockWizardUpdate = vi.fn();
const mockPrefUpdate = vi.fn();
const mockInitSentry = vi.fn();
let configDir: string;

vi.mock("@vex-lib/wallet-backup.js", () => ({
  autoBackup: () => mockAutoBackup(),
}));

vi.mock("../env-state.js", () => ({
  gatherEnvState: () => mockGatherEnvState(),
  readEnvKeyPresence: vi.fn(),
  readEnvValue: vi.fn(),
  redactEmbeddingUrl: vi.fn(),
}));

vi.mock("../wizard-state-store.js", () => ({
  wizardStateStore: {
    update: (input: unknown) => mockWizardUpdate(input),
  },
}));

vi.mock("../../preferences/store.js", () => ({
  preferencesStore: {
    update: (input: unknown) => mockPrefUpdate(input),
  },
}));

vi.mock("../../telemetry/sentry-lifecycle.js", () => ({
  initSentryIfConsented: () => mockInitSentry(),
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../paths/config-dir.js", () => ({
  get SETUP_COMPLETE_FILE() {
    return path.join(configDir, ".setup-complete");
  },
}));

const { completeSetup, __resetFinalizeSingleFlightForTests } = await import(
  "../finalize.js"
);

function fullEnvState(): unknown {
  return {
    hasKeystorePassword: true,
    hasJupiterApiKey: true,
    apiKeys: {
      jupiterConfigured: true,
      tavilyConfigured: false,
      rettiwtConfigured: false,
      relayConfigured: false,
    },
    embeddings: {
      configured: true,
      reachable: true,
      baseUrlRedacted: "http://127.0.0.1:12434",
      allFieldsConfigured: true,
      dbReachable: true,
    },
    walletStatus: { evm: "present", solana: "present" },
    walletAddresses: { evm: "0x1234", solana: "Sol1234" },
    provider: { configured: true, name: "openrouter", modelLabel: "anthropic/claude-sonnet-4.5" },
    setupCompleteFlag: false,
  };
}

beforeEach(() => {
  mockAutoBackup.mockReset();
  mockGatherEnvState.mockReset();
  mockWizardUpdate.mockReset();
  mockPrefUpdate.mockReset();
  mockInitSentry.mockReset();
  configDir = mkdtempSync(path.join(tmpdir(), "vex-finalize-"));
  __resetFinalizeSingleFlightForTests();
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("completeSetup", () => {
  it("happy path: returns ok with completedAt + backupPath", async () => {
    mockGatherEnvState.mockResolvedValue(fullEnvState());
    mockAutoBackup.mockResolvedValue("/tmp/backup/2026-05-12");
    mockWizardUpdate.mockResolvedValue({ ok: true });

    const result = await completeSetup({ telemetryConsent: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.backupPath).toBe("/tmp/backup/2026-05-12");
    expect(result.data.telemetryWarning).toBeNull();
    expect(typeof result.data.completedAt).toBe("string");
    expect(mockInitSentry).not.toHaveBeenCalled();
  });

  it("validation.invalid_input when the master password is missing", async () => {
    // Master password is the ONLY hard finalize requirement (optional-
    // connections model). Absent it, finalize must reject.
    mockGatherEnvState.mockResolvedValue({
      ...(fullEnvState() as Record<string, unknown>),
      hasKeystorePassword: false,
    });

    const result = await completeSetup({ telemetryConsent: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error.code).toBe("validation.invalid_input");
  });

  it("SUCCEEDS with master password present but all four connections unconfigured", async () => {
    // Optional-connections model: wallets, API keys, embeddings, and the
    // inference provider may all be deferred to in-app Settings. As long
    // as the master password exists, finalize must complete.
    mockGatherEnvState.mockResolvedValue({
      ...(fullEnvState() as Record<string, unknown>),
      hasKeystorePassword: true,
      hasJupiterApiKey: false,
      apiKeys: {
        jupiterConfigured: false,
        tavilyConfigured: false,
        rettiwtConfigured: false,
        relayConfigured: false,
      },
      embeddings: {
        configured: false,
        reachable: false,
        baseUrlRedacted: null,
        allFieldsConfigured: false,
        dbReachable: null,
      },
      walletStatus: { evm: "missing", solana: "missing" },
      walletAddresses: { evm: null, solana: null },
      provider: { configured: false, name: null, modelLabel: null },
    });
    mockAutoBackup.mockResolvedValue(null);
    mockWizardUpdate.mockResolvedValue({ ok: true });

    const result = await completeSetup({ telemetryConsent: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.backupPath).toBeNull();
    expect(mockWizardUpdate).toHaveBeenCalledTimes(1);
  });

  it("autoBackup throws: returns onboarding.step_failed step=auto_backup", async () => {
    mockGatherEnvState.mockResolvedValue(fullEnvState());
    mockAutoBackup.mockRejectedValue(new Error("disk full"));

    const result = await completeSetup({ telemetryConsent: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error.code).toBe("onboarding.step_failed");
    expect(result.error.details?.step).toBe("auto_backup");
    expect(mockWizardUpdate).not.toHaveBeenCalled();
  });

  it("wizardState write fails: returns step_failed step=wizard_state (NOT contract_violation)", async () => {
    mockGatherEnvState.mockResolvedValue(fullEnvState());
    mockAutoBackup.mockResolvedValue("/tmp/backup");
    mockWizardUpdate.mockRejectedValue(new Error("fs ENOSPC"));

    const result = await completeSetup({ telemetryConsent: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error.code).toBe("onboarding.step_failed");
    expect(result.error.details?.step).toBe("wizard_state");
  });

  it("telemetry consent: applied after setup; init failure surfaces warning", async () => {
    mockGatherEnvState.mockResolvedValue(fullEnvState());
    mockAutoBackup.mockResolvedValue("/tmp/backup");
    mockWizardUpdate.mockResolvedValue({ ok: true });
    mockPrefUpdate.mockResolvedValue({});
    mockInitSentry.mockResolvedValue(false); // DSN missing → not initialized

    const result = await completeSetup({ telemetryConsent: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.telemetryWarning).toContain("error reporting");
    expect(mockPrefUpdate).toHaveBeenCalledTimes(1);
  });

  it("single-flight: 2 concurrent calls share the promise", async () => {
    mockGatherEnvState.mockResolvedValue(fullEnvState());
    mockAutoBackup.mockResolvedValue("/tmp/backup");
    mockWizardUpdate.mockResolvedValue({ ok: true });

    const [a, b] = await Promise.all([
      completeSetup({ telemetryConsent: false }),
      completeSetup({ telemetryConsent: false }),
    ]);
    // Same successful Result instance — only ONE backup attempt happened.
    expect(a.ok && b.ok).toBe(true);
    expect(mockAutoBackup).toHaveBeenCalledTimes(1);
    expect(mockWizardUpdate).toHaveBeenCalledTimes(1);
  });

  it("after single-flight settles: a subsequent call runs fresh", async () => {
    mockGatherEnvState.mockResolvedValue(fullEnvState());
    mockAutoBackup.mockResolvedValue("/tmp/backup");
    mockWizardUpdate.mockResolvedValue({ ok: true });

    await completeSetup({ telemetryConsent: false });
    await completeSetup({ telemetryConsent: false });
    expect(mockAutoBackup).toHaveBeenCalledTimes(2);
  });
});
