/**
 * BASE FIXTURES - the install every harness state stands in: set up,
 * unlocked, one EVM and one Solana wallet, Vex Cloud as the provider, an
 * empty watchlist and nothing waiting.
 *
 * FIXTURE DATA, NEVER SHOWN AS REAL. Every value here is typed by the real
 * DTO (`shared/schemas/*`), so a contract change that would make the product
 * render something else breaks this file at compile time instead of leaving a
 * harness that silently draws a shell the product cannot. The addresses are
 * well-formed and plainly made up (`0x7e57...`, "test"); the model is a real
 * catalog shape with no live price behind it.
 *
 * These are the reads the shell makes on every mount, found by mounting it
 * on an empty bridge and reading `window.__vexH3Harness.unanswered()`:
 * the profile, capabilities, health, environment, models, wallets, the
 * watchlist, the app-wide pending approvals, the Vex Cloud withdrawal
 * notices and the activity feed Vex's console lists (`fixtures/activity.ts`).
 * A state overrides any of them through its own answers.
 */

import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import type { Capabilities } from "@shared/schemas/capabilities.js";
import type { ModelOptionDto, ModelsListAvailableResult } from "@shared/schemas/models.js";
import type { EnvState } from "@shared/schemas/onboarding.js";
import type { SessionList } from "@shared/schemas/sessions.js";
import type { HealthReport } from "@shared/schemas/system.js";
import type { UserProfile } from "@shared/schemas/user-profile.js";
import type { VexCloudWithdrawalNoticesResult } from "@shared/schemas/vex-cloud-funding.js";
import type { AvailableWalletsDto } from "@shared/schemas/wallets/session-available.js";
import type { WatchlistSnapshotDto } from "@shared/schemas/alerts.js";
import { ok, type BridgeAnswers } from "../bridge.js";
import { isoAt, MINUTE } from "../clock.js";
import { fixture } from "../mark.js";
import { ACTIVITY_FEED } from "./activity.js";

export const EVM_WALLET = fixture("wallet.evm", {
  id: "h3-fixture-evm-1",
  family: "evm" as const,
  address: "0x7e57a11e7000000000000000000000000000b45e",
  label: "Main wallet",
});

export const SOLANA_WALLET = fixture("wallet.solana", {
  id: "h3-fixture-sol-1",
  family: "solana" as const,
  address: "H3FixtureWa11etSo1anaxxxxxxxxxxxxxxxxxxxxxx",
  label: "Solana wallet",
});

export const MODEL: ModelOptionDto = fixture("model", {
  providerId: "vexcloud",
  modelId: "openai/gpt-5.2",
  displayName: "GPT-5.2",
  brand: "OpenAI",
  contextLength: 400_000,
  pricingInputPerMillion: "1.75",
  pricingOutputPerMillion: "14",
  reasoning: {
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    defaultEnabled: true,
    mandatory: false,
  },
  isDefault: true,
});

const PROFILE: UserProfile = { displayName: null, instructionsMd: null, workDescription: null };

const CAPABILITIES: Capabilities = {
  phase: "phase2",
  appVersion: "h3-shell-harness",
  onboardingComplete: true,
  telemetryAvailable: false,
  features: {
    splash: true,
    systemCheck: true,
    wizard: true,
    wallets: true,
    chat: true,
    missions: true,
    portfolio: true,
    memory: true,
    tools: true,
  },
};

const HEALTH: HealthReport = {
  os: {
    platform: "darwin",
    arch: "arm64",
    release: "25.3.0",
    distro: null,
    homedir: "/Users/h3-fixture",
    userDataDir: "/Users/h3-fixture/Library/Application Support/Vex",
    appVersion: "h3-shell-harness",
    electronVersion: "42.0.0",
    nodeVersion: "24.0.0",
  },
  network: { online: true, latencyMs: 42, probedAt: isoAt(-MINUTE) },
  translocated: false,
  setupComplete: true,
  overall: "ok",
};

const ENV: EnvState = {
  hasKeystorePassword: true,
  hasJupiterApiKey: false,
  apiKeys: {
    jupiterConfigured: false,
    tavilyConfigured: true,
    rettiwtConfigured: false,
    relayConfigured: true,
  },
  secrets: { vaultConfigured: true, unlocked: true },
  embeddings: {
    configured: true,
    reachable: true,
    baseUrlRedacted: null,
    allFieldsConfigured: true,
    dbReachable: true,
  },
  walletStatus: { evm: "present", solana: "present" },
  walletAddresses: { evm: EVM_WALLET.address, solana: SOLANA_WALLET.address },
  provider: { configured: true, name: "vexcloud", modelLabel: MODEL.displayName, endpointTag: null },
  setupCompleteFlag: true,
};

const MODELS: ModelsListAvailableResult = { source: "catalog", models: [MODEL], fetchedAt: isoAt(-5 * MINUTE) };

const WALLETS: AvailableWalletsDto = { evm: [EVM_WALLET], solana: [SOLANA_WALLET] };

const WATCHLIST: WatchlistSnapshotDto = {
  items: [],
  activeAlerts: [],
  firedAlerts: [],
  limits: { watchlist: 50, activeAlerts: 20 },
  pricedAt: isoAt(-MINUTE),
};

const SIGNED_OUT: VexCloudWithdrawalNoticesResult = { state: "signed_out" };

export interface BaseInputs {
  readonly sessions: SessionList;
  readonly pendingAll: readonly ApprovalPendingGlobalDto[];
}

/** The answers every state shares, over the state's own chat list and pending approvals. */
export function baseAnswers({ sessions, pendingAll }: BaseInputs): BridgeAnswers {
  return {
    settings: { getUserProfile: () => ok(PROFILE) },
    capabilities: { get: () => ok(CAPABILITIES) },
    system: { health: () => ok(HEALTH) },
    onboarding: { getEnvState: () => ok(ENV) },
    models: { listAvailable: () => ok(MODELS) },
    wallets: { listAvailable: () => ok(WALLETS) },
    alerts: { getWatchlist: () => ok(WATCHLIST) },
    sessions: { list: () => ok(sessions) },
    approvals: { listPendingAll: () => ok(pendingAll) },
    // Vex's plate reads the user's own image: none set. Every state's shell
    // has her column now, the welcome's included (S2-10).
    shellBackdrop: { read: () => ok({ backdrop: null }) },
    // Her console's recent activity reads the activity feed (S3-07).
    portfolio: { listAgentScan: () => ok(ACTIVITY_FEED) },
    vexCloud: {
      withdrawalNotices: () => ({ promise: ok(SIGNED_OUT), cancel: () => undefined }),
    },
  };
}
