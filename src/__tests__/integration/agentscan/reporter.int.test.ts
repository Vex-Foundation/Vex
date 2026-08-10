/**
 * AgentScan reporter lane — end-to-end against real Postgres with scripted
 * in-memory clients (the HTTP layers have their own unit suites; what this
 * suite proves is the LANE's state machine over real SQL).
 *
 * Acceptance criteria pinned here:
 *
 *   AC1 — fresh install: the lane handshakes once (session/start → sign →
 *         session/complete) with a well-formed identity, then sends event
 *         batches with the ROTATED token/hash;
 *   AC2 — the one-time BACKFILL: the first drain after a successful
 *         handshake carries the full eligible history with backfill:true,
 *         and only that once; a second run with an unchanged wallet set does
 *         NOT re-handshake; a wallet-inventory change (different fingerprint)
 *         DOES re-handshake; vault_locked / no_wallets skip with zero
 *         session calls and no backoff burn; a domain mismatch (including a
 *         mixed-case one that should MATCH) never signs and never calls
 *         session/complete;
 *   AC3 — privacy: the serialized batches never contain the seeded wallet /
 *         session / from-address values (the mapper's allowlist, proven at
 *         the lane boundary).
 *
 * Plus the server-answer table: session/complete 409 (wallet_conflict, kept
 * defensive — the current server transfers a proven wallet instead) →
 * permanent stop; events-endpoint 410 → permanent stop; events-endpoint 401
 * → re-handshake the SAME identity next run (`resetForReRegistration`);
 * session/complete 401 → a DIFFERENT recovery — the FakeSessionClient
 * enforces the server's real Bearer rule via a per-agentHash bound-token
 * ledger, so a genuine crash-after-rotation lockout (server holds T_new,
 * this install's stored token is stale) is reproduced and proven recovered:
 * the identity is abandoned entirely (`resetIdentityForRecovery`), and the
 * next run mints a fresh one that binds cleanly, no infinite 401 loop;
 * per-item rejection → terminal rejected row that is never resent;
 * session/start retryable → backoff without touching the outbox; a signer
 * that THROWS a typed error (never one of its own named outcomes) is caught
 * around the call and held the same long invalid-hold as a bad
 * session/complete response, so it can never bypass the backoff into a hot
 * loop of fresh session/starts.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { seedIntent, cleanupSeeded } from "../agent-scan/_fixtures.js";

import type {
  AgentscanClient,
  SendEventsInput,
  SendOutcome,
} from "../../../vex-agent/agentscan/client.js";
import type {
  AgentscanSessionClient,
  SessionStartInput,
  SessionStartOutcome,
  SessionCompleteInput,
  SessionCompleteOutcome,
} from "../../../vex-agent/agentscan/session-client.js";
import type {
  SignAgentscanChallengeInput,
  HandshakeSigningResult,
  HandshakeProof,
} from "../../../vex-agent/agentscan/handshake.js";
import type { AgentscanReporterDeps } from "../../../vex-agent/sync/agentscan-report.js";
import { VexError, ErrorCodes } from "../../../errors.js";

// The handshake gate reads the REAL wallet inventory (`listWallets`) and the
// REAL keystore-password resolver (`getKeystorePassword`) directly — see
// `agentscan-report.ts`'s design note on why that gate is not injected. This
// suite is about the LANE's state machine, not cryptography (every test below
// injects a `FakeSigner` for the actual signing step), so the wallet fixtures
// here only need to make `listWallets` non-empty and the vault "unlocked" —
// isolated to a throwaway CONFIG_DIR exactly like
// `src/__tests__/vex-agent/agentscan/handshake.test.ts` isolates T10's own
// suite, so this integration run never touches the real machine's Vex config.
const { testDir, testConfigFile, testKeystoreFile, testSolanaKeystoreFile, testBackupsDir, testEnvFile, testVaultFile } =
  vi.hoisted(() => {
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const _dir = join(tmpdir(), `vex-agentscan-reporter-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return {
      testDir: _dir,
      testConfigFile: join(_dir, "config.json"),
      testKeystoreFile: join(_dir, "keystore.json"),
      testSolanaKeystoreFile: join(_dir, "solana-keystore.json"),
      testBackupsDir: join(_dir, "backups"),
      testEnvFile: join(_dir, ".env"),
      testVaultFile: join(_dir, "secrets.vault.json"),
    };
  });

const TEST_PASSWORD = "test-password-agentscan-reporter";

vi.mock("@config/paths.js", () => ({
  CONFIG_DIR: testDir,
  CONFIG_FILE: testConfigFile,
  KEYSTORE_FILE: testKeystoreFile,
  SOLANA_KEYSTORE_FILE: testSolanaKeystoreFile,
  BACKUPS_DIR: testBackupsDir,
  ENV_FILE: testEnvFile,
  SECRETS_VAULT_FILE: testVaultFile,
}));

vi.mock("@utils/env.js", () => ({
  requireKeystorePassword: vi.fn(() => TEST_PASSWORD),
  getKeystorePassword: vi.fn(() => TEST_PASSWORD),
}));

vi.mock("@utils/logger-shim.js", () => ({
  minLogger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const envMod = await import("@utils/env.js");

beforeEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });
  vi.mocked(envMod.getKeystorePassword).mockReturnValue(TEST_PASSWORD);
  vi.mocked(envMod.requireKeystorePassword).mockReturnValue(TEST_PASSWORD);
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

/** Seed one EVM wallet entry so `listWallets("evm")` is non-empty (the lane's own gate). */
async function seedWallet(): Promise<void> {
  const { createEvmWalletEntry } = await import("@tools/wallet/inventory-create.js");
  createEvmWalletEntry();
}

async function resetAgentscanTables(): Promise<void> {
  const { execute } = await import("@vex-agent/db/client.js");
  await execute(`DELETE FROM agentscan_outbox`, []);
  await execute(`DELETE FROM agentscan_reporting_state`, []);
}

/** Index into an array without a non-null assertion: a miss throws, honestly. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an item at index ${index}, got ${items.length} item(s)`);
  return item;
}

afterEach(async () => {
  await resetAgentscanTables();
  await cleanupSeeded();
});

/** Scripted send-only client: records every call, answers from programmable queues. */
class FakeClient implements AgentscanClient {
  readonly sendCalls: SendEventsInput[] = [];
  sendOutcomes: SendOutcome[] = [];

  async sendEvents(input: SendEventsInput): Promise<SendOutcome> {
    this.sendCalls.push(input);
    return (
      this.sendOutcomes.shift() ?? {
        kind: "ok",
        accepted: input.events.length,
        duplicates: 0,
        rejectedIndexes: [],
      }
    );
  }
}

const DEFAULT_DOMAIN = "localhost";

/**
 * Scripted v2 handshake client: defaults to a well-formed happy path unless a
 * test scripts otherwise. The unscripted `sessionComplete` ENFORCES the
 * server's real Bearer rule via a per-agentHash bound-token ledger --
 * "harmless for a new one" (no ledger entry yet: any bearer is accepted, and
 * the ledger is seeded), "required for an existing one" (a ledger entry
 * exists: the presented bearer must match it exactly, else `auth_lost`) --
 * so a test can genuinely reproduce a stale-token lockout by corrupting the
 * LOCALLY stored token out from under an identity this fake already bound,
 * rather than the lane always sailing through on a lenient always-succeeds
 * double.
 */
class FakeSessionClient implements AgentscanSessionClient {
  readonly sessionStartCalls: SessionStartInput[] = [];
  readonly sessionCompleteCalls: Array<{ input: SessionCompleteInput; bearerToken: string | null }> = [];
  sessionStartOutcomes: SessionStartOutcome[] = [];
  sessionCompleteOutcomes: SessionCompleteOutcome[] = [];
  private readonly serverBoundTokens = new Map<string, string>();

  async sessionStart(input: SessionStartInput): Promise<SessionStartOutcome> {
    this.sessionStartCalls.push(input);
    return (
      this.sessionStartOutcomes.shift() ?? {
        kind: "started",
        challengeId: `chal-${this.sessionStartCalls.length}`,
        nonce: "N".repeat(43),
        domain: DEFAULT_DOMAIN,
        expiresAt: "2026-08-08T00:05:00.000Z",
      }
    );
  }

  async sessionComplete(
    input: SessionCompleteInput,
    bearerToken: string | null,
  ): Promise<SessionCompleteOutcome> {
    this.sessionCompleteCalls.push({ input, bearerToken });
    const scripted = this.sessionCompleteOutcomes.shift();
    if (scripted !== undefined) return scripted;

    const boundToken = this.serverBoundTokens.get(input.agentHash);
    if (boundToken !== undefined && boundToken !== bearerToken) {
      return { kind: "auth_lost" };
    }
    // Must satisfy the wire contract's ingest_token shape (43-char base64url).
    const rotated = `rotated-token-${this.sessionCompleteCalls.length}`.padEnd(43, "A");
    this.serverBoundTokens.set(input.agentHash, rotated);
    return { kind: "bound", ingestToken: rotated, agentName: "agent-default", lastAcceptedRowId: null };
  }
}

const DEFAULT_PROOF: HandshakeProof = {
  chainFamily: "eip155",
  address: "0x" + "1".repeat(40),
  signature: "0x" + "ab".repeat(65),
  issuedAt: "2026-08-08T00:00:00.000Z",
};

/** Scripted signer: bypasses real cryptography (the lane's job here is orchestration, not signing). */
class FakeSigner {
  readonly calls: SignAgentscanChallengeInput[] = [];
  outcomes: HandshakeSigningResult[] = [];
  /** Scripted THROW for the next call — proves a typed signer error never escapes `handshakeOnce`. */
  throwsOnNextCall: unknown = null;

  sign = async (input: SignAgentscanChallengeInput): Promise<HandshakeSigningResult> => {
    this.calls.push(input);
    if (this.throwsOnNextCall !== null) {
      const err = this.throwsOnNextCall;
      this.throwsOnNextCall = null;
      throw err;
    }
    return this.outcomes.shift() ?? { kind: "signed", proofs: [DEFAULT_PROOF] };
  };
}

function depsWith(
  client: FakeClient,
  baseUrl: string | null = "http://localhost",
  session: FakeSessionClient = new FakeSessionClient(),
  signer: FakeSigner = new FakeSigner(),
): AgentscanReporterDeps {
  return {
    baseUrl: () => baseUrl,
    buildClient: () => client,
    buildSessionClient: () => session,
    signChallenge: signer.sign,
    appVersion: () => "0.0.0-test",
  };
}

interface SeededRow {
  readonly activityId: number;
  readonly walletAddress: string;
  readonly sessionId: string;
}

async function seedEligibleSwap(): Promise<SeededRow> {
  const repo = await import("@vex-agent/db/repos/agent-activity.js");
  const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
  const event = await repo.createPendingActivityEvent({
    protocolExecutionId,
    eventIndex: 0,
    eventRole: "swap",
    kind: "swap",
    protocol: "kyberswap",
    chainId: 8453,
    walletAddress,
    sessionId,
    tokenIn: { tokenAddress: "0x" + "1".repeat(40), tokenSymbol: "ETH", tokenDecimals: 18, amountRaw: "1000000000000000000" },
    tokenOut: { tokenAddress: "0x" + "2".repeat(40), tokenSymbol: "VEX", tokenDecimals: 18, amountRaw: "5" },
  });
  return { activityId: event.id, walletAddress, sessionId };
}

/**
 * The INELIGIBLE control: an `allowance` row. The predicate reports every kind
 * and status but deliberately holds the two approval roles back, because
 * AgentScan's never-recomputed `daily_aggregates.tx_count` would count them
 * forever (see `DELIBERATELY_UNREPORTED_ROLES`).
 */
async function seedIneligibleAllowance(): Promise<void> {
  const repo = await import("@vex-agent/db/repos/agent-activity.js");
  const { protocolExecutionId, sessionId, walletAddress } = await seedIntent();
  await repo.createPendingActivityEvent({
    protocolExecutionId, eventIndex: 0, eventRole: "allowance", kind: "swap",
    protocol: "kyberswap", chainId: 8453, walletAddress, sessionId,
  });
}

async function confirmRow(activityId: number): Promise<void> {
  const repo = await import("@vex-agent/db/repos/agent-activity.js");
  await repo.markActivityBroadcast(activityId, {
    txHash: `0x${activityId.toString(16).padStart(64, "0")}`,
    fromAddress: "0x" + "3".repeat(40),
    nonce: 1,
  });
  const confirmed = await repo.confirmActivityEvent(activityId, {
    executedAmountInRaw: "1000000000000000000",
    executedAmountOutRaw: "5",
  });
  expect(confirmed.applied).toBe(true);
}

describe("reporter lane — gating", () => {
  it("disabled base URL: a full no-op, no identity is ever generated", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    const client = new FakeClient();
    const session = new FakeSessionClient();

    const result = await lane.runAgentscanReport(depsWith(client, null, session));

    expect(result.skipped).toBe("disabled");
    expect(session.sessionStartCalls).toHaveLength(0);
    expect(client.sendCalls).toHaveLength(0);
    expect((await stateRepo.getReportingState()).agentHash).toBeNull();
  });

  it("a stopped lane stays stopped and never calls the network", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await stateRepo.markStopped("consent_revoked");
    const client = new FakeClient();
    const session = new FakeSessionClient();

    const result = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));

    expect(result.skipped).toBe("stopped");
    expect(session.sessionStartCalls).toHaveLength(0);
    expect(client.sendCalls).toHaveLength(0);
  });
});

describe("reporter lane — handshake gate (AC2)", () => {
  it("vault_locked: zero session calls, no backoff burn, next tick retries", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedWallet();
    vi.mocked(envMod.getKeystorePassword).mockReturnValue(null);
    const client = new FakeClient();
    const session = new FakeSessionClient();

    const result = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));

    expect(result.skipped).toBe("vault_locked");
    expect(session.sessionStartCalls).toHaveLength(0);
    const state = await stateRepo.getReportingState();
    expect(state.registerAttemptCount).toBe(0);
    expect(new Date(state.nextRegisterAttemptAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("no_wallets: zero session calls, no backoff burn", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    // No seedWallet() call — the inventory is empty.
    const client = new FakeClient();
    const session = new FakeSessionClient();

    const result = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));

    expect(result.skipped).toBe("no_wallets");
    expect(session.sessionStartCalls).toHaveLength(0);
    const state = await stateRepo.getReportingState();
    expect(state.registerAttemptCount).toBe(0);
  });

  it("an inventory change (different wallet set) re-handshakes on the next run", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedWallet();
    const client = new FakeClient();
    const session = new FakeSessionClient();

    const first = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));
    expect(first.skipped).toBeNull();
    expect(session.sessionStartCalls).toHaveLength(1);
    const fingerprintAfterFirst = (await stateRepo.getReportingState()).boundWalletsFingerprint;

    const second = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));
    expect(second.skipped).toBeNull();
    expect(session.sessionStartCalls).toHaveLength(1); // unchanged inventory: no re-handshake

    await seedWallet(); // a second wallet: the fingerprint changes
    const third = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));
    expect(third.skipped).toBeNull();
    expect(session.sessionStartCalls).toHaveLength(2); // re-handshaked

    const fingerprintAfterThird = (await stateRepo.getReportingState()).boundWalletsFingerprint;
    expect(fingerprintAfterThird).not.toBe(fingerprintAfterFirst);
  });
});

describe("reporter lane — handshake + one-time backfill (AC1/AC2)", () => {
  it("first run: handshakes (session/start -> sign -> session/complete), rotates the token, stores name/cursor/fingerprint, then backfills the full eligible history", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedWallet();
    const seededA = await seedEligibleSwap();
    const seededB = await seedEligibleSwap();
    await seedIneligibleAllowance();
    const client = new FakeClient();
    const session = new FakeSessionClient();
    const ROTATED_TOKEN = "server-rotated-token".padEnd(43, "A");
    session.sessionCompleteOutcomes = [
      { kind: "bound", ingestToken: ROTATED_TOKEN, agentName: "agent-007", lastAcceptedRowId: 99 },
    ];
    const signer = new FakeSigner();

    const result = await lane.runAgentscanReport(depsWith(client, "http://localhost", session, signer));

    // session/start: once, well-formed agentHash, addresses from the seeded wallet inventory
    expect(session.sessionStartCalls).toHaveLength(1);
    const started = at(session.sessionStartCalls, 0);
    expect(started.agentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(started.addresses.length).toBeGreaterThan(0);
    expect(started.addresses.every((a) => a.chainFamily === "eip155")).toBe(true);

    // sign: called with the challenge session/start returned
    expect(signer.calls).toHaveLength(1);
    expect(at(signer.calls, 0).nonce).toBe("N".repeat(43));
    expect(at(signer.calls, 0).domain).toBe(DEFAULT_DOMAIN);
    expect(at(signer.calls, 0).agentHash).toBe(started.agentHash);

    // session/complete: once, current (self-generated) token sent, proofs passed through
    expect(session.sessionCompleteCalls).toHaveLength(1);
    const completed = at(session.sessionCompleteCalls, 0);
    expect(completed.bearerToken).not.toBeNull();
    expect(completed.input.proofs).toEqual([DEFAULT_PROOF]);
    expect(completed.input.consentVersion).toBe(1);
    expect(completed.input.appVersion).toBe("0.0.0-test");

    // state: token rotated, name/cursor/fingerprint stored
    const state = await stateRepo.getReportingState();
    expect(state.ingestToken).toBe(ROTATED_TOKEN);
    expect(state.agentName).toBe("agent-007");
    expect(state.serverCursorRowId).toBe(99);
    expect(state.boundWalletsFingerprint).not.toBeNull();
    expect(state.registeredAt).not.toBeNull();
    expect(state.lastHandshakeAt).not.toBeNull();

    // backfill batch: flag true, exactly the two eligible rows (the allowance
    // leg is held back by the predicate), correct envelope identity
    expect(client.sendCalls).toHaveLength(1);
    const batch = at(client.sendCalls, 0);
    expect(batch.backfill).toBe(true);
    expect(batch.agentHash).toBe(started.agentHash);
    expect(batch.ingestToken).toBe(ROTATED_TOKEN);
    expect(batch.events.map((e) => e.sourceRowId).sort()).toEqual(
      [String(seededA.activityId), String(seededB.activityId)].sort(),
    );

    expect(result.backfillEnqueued).toBe(true);
    expect(result.enqueued).toBe(2);
    expect(result.sent).toBe(2);
    expect(result.skipped).toBeNull();
  });

  it("privacy at the lane boundary: serialized batches never carry wallet/session/from values (AC3)", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    await seedWallet();
    const seeded = await seedEligibleSwap();
    await confirmRow(seeded.activityId);
    const client = new FakeClient();

    await lane.runAgentscanReport(depsWith(client));

    expect(client.sendCalls.length).toBeGreaterThan(0);
    const wire = JSON.stringify(client.sendCalls);
    expect(wire).not.toContain(seeded.walletAddress);
    expect(wire).not.toContain(seeded.sessionId);
    expect(wire).not.toContain("0x" + "3".repeat(40)); // from_address
  });

  it("second run with an unchanged wallet set does NOT re-handshake; a status flip goes out incrementally with backfill:false", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    await seedWallet();
    const seeded = await seedEligibleSwap();
    const client = new FakeClient();
    const session = new FakeSessionClient();

    await lane.runAgentscanReport(depsWith(client, "http://localhost", session)); // run 1: handshake + backfill(pending)
    const second = await lane.runAgentscanReport(depsWith(client, "http://localhost", session)); // run 2: quiet
    expect(second.sent).toBe(0);
    expect(second.enqueued).toBe(0);
    expect(client.sendCalls).toHaveLength(1);
    expect(session.sessionStartCalls).toHaveLength(1); // no re-handshake

    await confirmRow(seeded.activityId);
    const third = await lane.runAgentscanReport(depsWith(client, "http://localhost", session)); // run 3: the confirmed pair
    expect(third.sent).toBe(1);
    expect(client.sendCalls).toHaveLength(2);
    const incremental = at(client.sendCalls, 1);
    expect(incremental.backfill).toBe(false);
    expect(incremental.events).toHaveLength(1);
    expect(at(incremental.events, 0).status).toBe("confirmed");
    expect(at(incremental.events, 0).executedInRaw).not.toBeNull();
    expect(session.sessionStartCalls).toHaveLength(1); // still no re-handshake
  });
});

describe("reporter lane — server-answer table", () => {
  it("session/complete 409 wallet_conflict -> permanent stop (defensive path)", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedWallet();
    const client = new FakeClient();
    const session = new FakeSessionClient();
    session.sessionCompleteOutcomes = [{ kind: "wallet_conflict" }];

    const result = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));

    expect(result.skipped).toBe("stopped");
    expect((await stateRepo.getReportingState()).stoppedReason).toBe("wallet_conflict");
    expect(client.sendCalls).toHaveLength(0);
  });

  it("session/start retryable -> backoff stamped, outbox untouched, next-run-too-early skips", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedWallet();
    await seedEligibleSwap();
    const client = new FakeClient();
    const session = new FakeSessionClient();
    session.sessionStartOutcomes = [
      { kind: "retryable", status: 500, retryAfterSeconds: null, detail: "HTTP 500 internal" },
    ];

    const first = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));
    expect(first.skipped).toBe("unregistered");
    expect((await stateRepo.getReportingState()).registerAttemptCount).toBe(1);
    expect(client.sendCalls).toHaveLength(0);

    // Backoff holds: the immediate next run does not even attempt to handshake.
    const second = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));
    expect(second.skipped).toBe("unregistered");
    expect(session.sessionStartCalls).toHaveLength(1);
  });

  it("a domain mismatch never signs and never calls session/complete", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedWallet();
    const client = new FakeClient();
    const session = new FakeSessionClient();
    session.sessionStartOutcomes = [
      { kind: "started", challengeId: "chal-x", nonce: "N".repeat(43), domain: "attacker.example", expiresAt: "2026-08-08T00:05:00.000Z" },
    ];
    const signer = new FakeSigner();

    const result = await lane.runAgentscanReport(depsWith(client, "http://localhost", session, signer));

    expect(result.skipped).toBe("unregistered");
    expect(signer.calls).toHaveLength(0);
    expect(session.sessionCompleteCalls).toHaveLength(0);
    expect((await stateRepo.getReportingState()).registeredAt).toBeNull();
  });

  it("a mixed-case server domain matches the lowercase configured host (case-insensitive comparison)", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    await seedWallet();
    const client = new FakeClient();
    const session = new FakeSessionClient();
    session.sessionStartOutcomes = [
      { kind: "started", challengeId: "chal-y", nonce: "N".repeat(43), domain: "LocalHost", expiresAt: "2026-08-08T00:05:00.000Z" },
    ];
    const signer = new FakeSigner();

    const result = await lane.runAgentscanReport(depsWith(client, "http://localhost", session, signer));

    expect(result.skipped).toBeNull();
    expect(signer.calls).toHaveLength(1);
    expect(session.sessionCompleteCalls).toHaveLength(1);
  });

  it("a signer that THROWS (typed error, not a HandshakeSigningResult outcome) is caught: backoff stamped, exactly one session/start, no throw escapes", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedWallet();
    const client = new FakeClient();
    const session = new FakeSessionClient();
    const signer = new FakeSigner();
    signer.throwsOnNextCall = new VexError(ErrorCodes.SIGNER_MISMATCH, "signer mismatch");

    const result = await lane.runAgentscanReport(depsWith(client, "http://localhost", session, signer));

    expect(result.skipped).toBe("unregistered");
    expect(session.sessionStartCalls).toHaveLength(1);
    expect(session.sessionCompleteCalls).toHaveLength(0);
    expect(client.sendCalls).toHaveLength(0);

    const state = await stateRepo.getReportingState();
    expect(state.registeredAt).toBeNull();
    // HANDSHAKE_INVALID_HOLD_SECONDS discipline (1h), not the short register backoff.
    const heldUntil = new Date(state.nextRegisterAttemptAt).getTime();
    expect(heldUntil).toBeGreaterThan(Date.now() + 3500 * 1000);
    expect(heldUntil).toBeLessThanOrEqual(Date.now() + 3700 * 1000);

    // The 30s tick never hot-loops fresh session/starts against a held lane.
    const second = await lane.runAgentscanReport(depsWith(client, "http://localhost", session, signer));
    expect(second.skipped).toBe("unregistered");
    expect(session.sessionStartCalls).toHaveLength(1);
  });

  it("send 410 -> permanent stop; the following run is a stopped no-op", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedWallet();
    await seedEligibleSwap();
    const client = new FakeClient();
    client.sendOutcomes = [{ kind: "stopped", reason: "consent_revoked" }];

    await lane.runAgentscanReport(depsWith(client));
    expect((await stateRepo.getReportingState()).stoppedReason).toBe("consent_revoked");

    const next = await lane.runAgentscanReport(depsWith(client));
    expect(next.skipped).toBe("stopped");
    expect(client.sendCalls).toHaveLength(1);
  });

  it("send 401 -> registration cleared, SAME identity re-handshaked next run, rows resent", async () => {
    const { execute } = await import("@vex-agent/db/client.js");
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedWallet();
    await seedEligibleSwap();
    const client = new FakeClient();
    const session = new FakeSessionClient();
    client.sendOutcomes = [{ kind: "auth_lost" }];

    const first = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));
    expect(first.deferred).toBe(1);
    expect((await stateRepo.getReportingState()).registeredAt).toBeNull();

    // Clear the claim-stamped backoff so the retry is due NOW (test shortcut).
    await execute(`UPDATE agentscan_outbox SET next_attempt_at = NOW()`, []);

    const second = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));
    expect(session.sessionStartCalls).toHaveLength(2);
    expect(at(session.sessionStartCalls, 1).agentHash).toBe(at(session.sessionStartCalls, 0).agentHash);
    expect(second.sent).toBe(1);
  });

  it("session/complete auth_lost after a crash-after-rotation abandons the identity; the next run mints a fresh one and recovers (no infinite 401 loop)", async () => {
    const { execute } = await import("@vex-agent/db/client.js");
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedWallet();
    const client = new FakeClient();
    const session = new FakeSessionClient();

    // Run 1: a normal first-ever handshake. The FakeSessionClient's
    // bearer-enforcing ledger now binds this agentHash to whatever token this
    // run persisted.
    const first = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));
    expect(first.skipped).toBeNull();
    const stateAfterFirst = await stateRepo.getReportingState();
    const originalAgentHash = stateAfterFirst.agentHash;
    expect(originalAgentHash).not.toBeNull();

    // Simulate a crash AFTER the (fake) server committed a rotation but
    // BEFORE this install persisted it via markHandshakeComplete: corrupt the
    // locally-stored token directly so it no longer matches what the fake
    // server's ledger holds for this agentHash -- in effect identical to a
    // real crash between session/complete's 200 and our own write.
    await execute(
      `UPDATE agentscan_reporting_state SET ingest_token = $1 WHERE id = 1`,
      ["stale-pre-crash-token".padEnd(43, "A")],
    );

    // A second wallet forces a re-handshake attempt on the next run.
    await seedWallet();
    const second = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));
    expect(second.skipped).toBe("unregistered");
    expect(session.sessionCompleteCalls).toHaveLength(2); // the failed attempt landed here
    expect(at(session.sessionCompleteCalls, 1).bearerToken).toBe("stale-pre-crash-token".padEnd(43, "A"));

    // The FULL identity is abandoned, not just registration.
    const stateAfterSecond = await stateRepo.getReportingState();
    expect(stateAfterSecond.agentHash).toBeNull();
    expect(stateAfterSecond.ingestToken).toBeNull();
    expect(stateAfterSecond.agentName).toBeNull();
    expect(stateAfterSecond.boundWalletsFingerprint).toBeNull();
    expect(stateAfterSecond.registeredAt).toBeNull();

    // Run 3: ensureIdentity mints a FRESH identity; the fake server's ledger
    // has no entry for it yet ("harmless for a new one"), so it binds cleanly
    // -- no infinite 401 loop.
    const third = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));
    expect(third.skipped).toBeNull();
    const stateAfterThird = await stateRepo.getReportingState();
    expect(stateAfterThird.agentHash).not.toBeNull();
    expect(stateAfterThird.agentHash).not.toBe(originalAgentHash);
    expect(stateAfterThird.registeredAt).not.toBeNull();
    expect(session.sessionCompleteCalls).toHaveLength(3); // 1 bound + 1 failed + 1 recovered, never more
  });

  it("auth_lost triggers a FULL idempotent resend: previously-sent rows come back backfill:true; a previously-rejected row is never resent (AC1)", async () => {
    const { execute, queryOne } = await import("@vex-agent/db/client.js");
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    await seedWallet();
    const seededA = await seedEligibleSwap();
    const seededB = await seedEligibleSwap();
    const client = new FakeClient();
    const session = new FakeSessionClient();

    // Run 1: handshake + backfill both rows; one accepted, one rejected.
    client.sendOutcomes = [{ kind: "ok", accepted: 1, duplicates: 0, rejectedIndexes: [1] }];
    const first = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));
    expect(first.sent).toBe(1);
    expect(first.rejected).toBe(1);
    const registeredHash = at(session.sessionStartCalls, 0).agentHash;

    // Ordering of the backfill batch is not guaranteed, so read the DB to
    // find out which seeded activity landed sent vs. rejected.
    async function pendingRow(activityId: number) {
      return queryOne<{ sent_at: Date | null; rejected_at: Date | null }>(
        `SELECT sent_at, rejected_at FROM agentscan_outbox WHERE activity_id = $1 AND status = 'pending'`,
        [activityId],
      );
    }
    const aRow = await pendingRow(seededA.activityId);
    const sentActivityId = aRow?.sent_at != null ? seededA.activityId : seededB.activityId;
    const rejectedActivityId = aRow?.sent_at != null ? seededB.activityId : seededA.activityId;

    // Run 2: a fresh incremental row (the confirm transition) arrives, but
    // the server has forgotten the token (simulated server-side DB reset).
    await confirmRow(sentActivityId);
    client.sendOutcomes = [{ kind: "auth_lost" }];
    const second = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));
    expect(second.deferred).toBe(1);
    expect((await stateRepo.getReportingState()).registeredAt).toBeNull();

    // Force everything due (test shortcut) and let run 3 re-handshake + resend.
    await execute(`UPDATE agentscan_outbox SET next_attempt_at = NOW()`, []);
    client.sendOutcomes = [];

    const third = await lane.runAgentscanReport(depsWith(client, "http://localhost", session));

    expect(session.sessionStartCalls).toHaveLength(2);
    expect(at(session.sessionStartCalls, 1).agentHash).toBe(registeredHash);
    expect(third.sent).toBe(2);

    const resentRow = await pendingRow(sentActivityId);
    expect(resentRow?.sent_at).not.toBeNull();
    const resentBackfillRow = await queryOne<{ backfill: boolean }>(
      `SELECT backfill FROM agentscan_outbox WHERE activity_id = $1 AND status = 'pending'`,
      [sentActivityId],
    );
    expect(resentBackfillRow?.backfill).toBe(true);

    const stillRejected = await pendingRow(rejectedActivityId);
    expect(stillRejected?.rejected_at).not.toBeNull();
    expect(stillRejected?.sent_at).toBeNull();
  });

  it("per-item rejection -> that row is terminal-rejected and never resent", async () => {
    const { execute } = await import("@vex-agent/db/client.js");
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    await seedWallet();
    await seedEligibleSwap();
    await seedEligibleSwap();
    const client = new FakeClient();
    client.sendOutcomes = [{ kind: "ok", accepted: 1, duplicates: 0, rejectedIndexes: [1] }];

    const first = await lane.runAgentscanReport(depsWith(client));
    expect(first.sent).toBe(1);
    expect(first.rejected).toBe(1);

    await execute(`UPDATE agentscan_outbox SET next_attempt_at = NOW() WHERE sent_at IS NULL AND rejected_at IS NULL`, []);
    const second = await lane.runAgentscanReport(depsWith(client));
    expect(second.sent).toBe(0);
    expect(client.sendCalls).toHaveLength(1);
  });
});

describe("runAgentscanIncremental — push-lane drain-only entry (AC2)", () => {
  it("every precondition miss is a zero-touch 'unregistered' skip: no enqueue, no handshake, no send", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");

    const disabledClient = new FakeClient();
    const disabledSession = new FakeSessionClient();
    const disabled = await lane.runAgentscanIncremental(depsWith(disabledClient, null, disabledSession));
    expect(disabled.skipped).toBe("unregistered");
    expect(disabled.enqueued).toBe(0);
    expect(disabledSession.sessionStartCalls).toHaveLength(0);
    expect(disabledClient.sendCalls).toHaveLength(0);

    await seedWallet();
    await seedEligibleSwap();
    const neverRegisteredClient = new FakeClient();
    const neverRegisteredSession = new FakeSessionClient();
    const neverRegistered = await lane.runAgentscanIncremental(
      depsWith(neverRegisteredClient, "http://localhost", neverRegisteredSession),
    );
    expect(neverRegistered.skipped).toBe("unregistered");
    expect(neverRegistered.enqueued).toBe(0);
    expect(neverRegisteredSession.sessionStartCalls).toHaveLength(0);
    expect(neverRegisteredClient.sendCalls).toHaveLength(0);
    expect((await stateRepo.getReportingState()).registeredAt).toBeNull();

    await stateRepo.markStopped("consent_revoked");
    const stoppedClient = new FakeClient();
    const stoppedSession = new FakeSessionClient();
    const stopped = await lane.runAgentscanIncremental(depsWith(stoppedClient, "http://localhost", stoppedSession));
    expect(stopped.skipped).toBe("unregistered");
    expect(stoppedSession.sessionStartCalls).toHaveLength(0);
    expect(stoppedClient.sendCalls).toHaveLength(0);
  });

  it("registered but backfill not yet enqueued: a push-lane fire in the handshake->backfill window is a zero-touch no-op", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");
    const { queryOne, execute } = await import("@vex-agent/db/client.js");

    await seedEligibleSwap();
    await stateRepo.ensureIdentity(lane.generateAgentscanIdentity);
    // Direct SQL state-setter (markRegistered no longer exists -- production
    // now stamps registered_at via markHandshakeComplete): fast-forward past
    // the handshake without needing session/complete's fuller contract.
    await execute(
      `UPDATE agentscan_reporting_state SET registered_at = NOW() WHERE id = 1`,
      [],
    );

    const stateBefore = await stateRepo.getReportingState();
    expect(stateBefore.registeredAt).not.toBeNull();
    expect(stateBefore.backfillEnqueuedAt).toBeNull();

    const client = new FakeClient();
    const result = await lane.runAgentscanIncremental(depsWith(client));

    expect(result.skipped).toBe("unregistered");
    expect(result.enqueued).toBe(0);
    expect(result.sent).toBe(0);
    expect(client.sendCalls).toHaveLength(0);

    const stateAfter = await stateRepo.getReportingState();
    expect(stateAfter.backfillEnqueuedAt).toBeNull();

    const outboxCount = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM agentscan_outbox`,
    );
    expect(outboxCount?.count).toBe("0");
  });

  it("registered state enqueues the incremental scan and drains, touching neither the handshake nor the backfill flag", async () => {
    const lane = await import("../../../vex-agent/sync/agentscan-report.js");
    const stateRepo = await import("../../../vex-agent/db/repos/agentscan-reporting.js");

    await seedWallet();
    await seedEligibleSwap();
    const bootstrapClient = new FakeClient();
    const bootstrapSession = new FakeSessionClient();
    await lane.runAgentscanReport(depsWith(bootstrapClient, "http://localhost", bootstrapSession));
    expect(bootstrapSession.sessionStartCalls).toHaveLength(1);

    const stateBefore = await stateRepo.getReportingState();
    expect(stateBefore.registeredAt).not.toBeNull();
    expect(stateBefore.backfillEnqueuedAt).not.toBeNull();

    const seededB = await seedEligibleSwap();
    const pushClient = new FakeClient();
    const result = await lane.runAgentscanIncremental(depsWith(pushClient));

    expect(result.skipped).toBeNull();
    expect(result.backfillEnqueued).toBe(false);
    expect(result.enqueued).toBe(1);
    expect(pushClient.sendCalls).toHaveLength(1);
    const batch = at(pushClient.sendCalls, 0);
    expect(batch.backfill).toBe(false);
    expect(batch.events.map((e) => e.sourceRowId)).toEqual([String(seededB.activityId)]);
    expect(result.sent).toBe(1);

    const stateAfter = await stateRepo.getReportingState();
    expect(stateAfter.backfillEnqueuedAt).toEqual(stateBefore.backfillEnqueuedAt);
    expect(stateAfter.registeredAt).toEqual(stateBefore.registeredAt);
  });
});
