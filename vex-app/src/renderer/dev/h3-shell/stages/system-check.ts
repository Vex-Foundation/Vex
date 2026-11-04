/**
 * The real system check on the stage, beside the plates `stage-system-check`
 * and `stage-system-check-blocked`: a first run on a machine that passes
 * every check, and one whose disk cannot take the first run, so Continue is
 * held. Every answer is typed by the real contract and registered under the
 * harness mark (`fixture`).
 */

import type { EnvState } from "@shared/schemas/onboarding.js";
import type { HealthReport, LocalRuntimeCheck, RuntimeInfo } from "@shared/schemas/system.js";
import type { RuntimeMigrationStatus } from "@shared/schemas/runtime-migration.js";
import { SystemCheck } from "../../../features/systemCheck/SystemCheck.js";
import { stageVexEnd } from "../../../components/onboarding/stage-vex.js";
import { ok, type BridgeAnswers } from "../bridge.js";
import { isoAt, MINUTE } from "../clock.js";
import { fixture } from "../mark.js";
import type { HarnessStage } from "./types.js";

const GB = 1e9;
const GiB = 1024 ** 3;

export const FIRST_RUN_HEALTH: HealthReport = fixture("stage.health", {
  os: {
    platform: "darwin",
    arch: "arm64",
    release: "25.3.0",
    distro: null,
    homedir: "/Users/h3-fixture",
    userDataDir: "/Users/h3-fixture/Library/Application Support/Vex",
    appVersion: "h3-shell-harness",
    electronVersion: "38.2.1",
    nodeVersion: "24.0.0",
  },
  network: { online: true, latencyMs: 42, probedAt: isoAt(-MINUTE) },
  translocated: false,
  setupComplete: false,
  overall: "ok",
});

/** A first run: nothing set up yet. */
export const FIRST_RUN_ENV: EnvState = fixture("stage.env", {
  hasKeystorePassword: false,
  hasJupiterApiKey: false,
  apiKeys: {
    jupiterConfigured: false,
    tavilyConfigured: false,
    rettiwtConfigured: false,
    relayConfigured: false,
  },
  secrets: { vaultConfigured: false, unlocked: false },
  embeddings: {
    configured: false,
    reachable: false,
    baseUrlRedacted: null,
    allFieldsConfigured: false,
    dbReachable: false,
  },
  walletStatus: { evm: "missing", solana: "missing" },
  walletAddresses: { evm: null, solana: null },
  provider: { configured: false, name: null, modelLabel: null, endpointTag: null },
  setupCompleteFlag: false,
});

const NATIVE: RuntimeInfo = { native: true };
const NOT_NEEDED: RuntimeMigrationStatus = { kind: "not_needed" };

function localCheck(freeBytes: number, totalBytes: number): LocalRuntimeCheck {
  return fixture("stage.localRuntimeCheck", {
    bundle: { kind: "present", platform: "darwin", arch: "arm64" },
    disk: { kind: "measured", freeBytes, totalBytes, modelVerified: false, modelBytesToWrite: 333_590_944 },
    memory: { totalBytes: 16 * GiB, freeBytes: 9.4 * GiB },
  });
}

function answers(check: LocalRuntimeCheck): BridgeAnswers {
  return {
    system: {
      health: () => ok(FIRST_RUN_HEALTH),
      runtime: () => ok(NATIVE),
      runtimeMigrationStatus: () => ok(NOT_NEEDED),
      localRuntimeCheck: () => ok(check),
    },
    onboarding: { getEnvState: () => ok(FIRST_RUN_ENV) },
  };
}

/** The first run is not the launch: the gate has handed over, so the stage store has ended it. */
function afterTheGate(): void {
  stageVexEnd();
}

export const systemCheckReady: HarnessStage = {
  id: "system-check",
  title: "System check: six checks passed, setup to do",
  view: "systemCheck",
  Screen: SystemCheck,
  answers: () => answers(localCheck(212 * GB, 494 * GB)),
  setup: afterTheGate,
  ready: '[data-vex-screen="systemCheck"] [data-step-status="warn"]',
};

export const systemCheckBlocked: HarnessStage = {
  id: "system-check-blocked",
  title: "System check: no disk space for setup, Continue held",
  view: "systemCheck",
  Screen: SystemCheck,
  answers: () => answers(localCheck(300_000_000, 494 * GB)),
  setup: afterTheGate,
  ready: '[data-vex-screen="systemCheck"] [data-step-status="fail"]',
};
