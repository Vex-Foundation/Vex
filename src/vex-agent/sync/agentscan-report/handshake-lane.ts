/**
 * The wallet-binding handshake attempt, split out of `../agentscan-report.ts`
 * (550-line facade decree). A different reason to change from the facade: the
 * facade decides WHEN the lane registers, backfills, and drains; this file owns
 * HOW one handshake attempt runs (session/start -> domain check -> sign ->
 * session/complete) and every verdict it can reach. The full design rationale
 * for the binding model lives in the facade's header ("Binding" section).
 */

import { createHash } from "node:crypto";

import * as reportingRepo from "@vex-agent/db/repos/agentscan-reporting.js";
import type { HandshakeSigningResult } from "../../agentscan/handshake.js";
import { listWallets } from "@tools/wallet/inventory.js";
import { getKeystorePassword } from "@utils/env.js";
import type { ChainFamily } from "@tools/khalani/types.js";
import logger from "@utils/logger.js";
import { VexError } from "../../../errors.js";
import type { AgentscanReporterDeps } from "../agentscan-report.js";

/** Handshake attempt backoff: 5 min · 2^n capped at 1 h — reuses the same counters the old register flow did. */
const REGISTER_BACKOFF_BASE_SECONDS = 300;
const REGISTER_BACKOFF_MAX_SECONDS = 3600;

/** session/complete's invalid_signature/validation_failed is a client bug — same long-hold discipline as INVALID_BATCH_HOLD_SECONDS. */
const HANDSHAKE_INVALID_HOLD_SECONDS = 3600;

/** sha256 over the sorted `chainFamily:address` inventory list — changes whenever a wallet is added or removed. */
export function computeWalletsFingerprint(): string {
  const evm = listWallets("evm").map((entry) => `eip155:${entry.address.toLowerCase()}`);
  const solana = listWallets("solana").map((entry) => `solana:${entry.address}`);
  const sorted = [...evm, ...solana].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

/**
 * Localhost stacks answer with a literal `localhost` domain too, so one
 * hostname comparison covers both cases. Both sides are lowercased before
 * comparing: `URL#hostname` is already normalized, but `serverDomain` is raw
 * untrusted JSON text and must not be compared case-sensitively against it —
 * a legitimately-matching domain answered as e.g. `AgentScan.Example` must
 * not be refused as a mismatch.
 */
function domainMatches(baseUrl: string, serverDomain: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === serverDomain.toLowerCase();
  } catch {
    return false;
  }
}

export type HandshakeAttemptOutcome =
  | { readonly kind: "handshaken"; readonly ingestToken: string }
  | { readonly kind: "skip"; readonly reason: "unregistered" | "vault_locked" | "no_wallets" | "stopped" };

/**
 * One handshake attempt: session/start → domain check → sign → session/complete
 * → `markHandshakeComplete`. The wallet-inventory / vault-lock gate runs FIRST,
 * directly (not via `deps.signChallenge`), so a locked vault or an empty
 * inventory costs ZERO session calls and never burns the attempt backoff —
 * `deps.signChallenge` (production: T10's `signAgentscanChallenge`) is reached
 * only once we actually have a real challenge to sign, and still re-checks
 * both as a safety net for a lock that lands mid-flight.
 */
export async function handshakeOnce(
  deps: AgentscanReporterDeps,
  baseUrl: string,
  state: reportingRepo.AgentscanReportingState,
  agentHash: string,
  ingestToken: string,
  fingerprint: string,
): Promise<HandshakeAttemptOutcome> {
  if (new Date(state.nextRegisterAttemptAt).getTime() > Date.now()) {
    return { kind: "skip", reason: "unregistered" };
  }

  const evmEntries = listWallets("evm");
  const solanaEntries = listWallets("solana");
  if (evmEntries.length === 0 && solanaEntries.length === 0) {
    return { kind: "skip", reason: "no_wallets" };
  }
  if (getKeystorePassword() === null) {
    return { kind: "skip", reason: "vault_locked" };
  }

  const addresses: ReadonlyArray<{ chainFamily: ChainFamily; address: string }> = [
    ...evmEntries.map((entry) => ({ chainFamily: "eip155" as const, address: entry.address })),
    ...solanaEntries.map((entry) => ({ chainFamily: "solana" as const, address: entry.address })),
  ];

  const session = deps.buildSessionClient(baseUrl);
  const appVersion = deps.appVersion();

  const started = await session.sessionStart({ agentHash, addresses });
  if (started.kind !== "started") {
    const delay =
      started.kind === "retryable" && started.retryAfterSeconds !== null
        ? started.retryAfterSeconds
        : registerBackoffSeconds(state.registerAttemptCount);
    await reportingRepo.noteRegisterAttemptFailed(delay);
    logger.warn("agentscan.report.handshake_start_failed", { detail: started.detail, retryInSeconds: delay });
    return { kind: "skip", reason: "unregistered" };
  }

  if (!domainMatches(baseUrl, started.domain)) {
    // A hostile or misbehaving server answering with a domain that doesn't
    // match what we dialed — treated as a retryable transport anomaly.
    // NEVER signs.
    await reportingRepo.noteRegisterAttemptFailed(registerBackoffSeconds(state.registerAttemptCount));
    logger.warn("agentscan.report.handshake_domain_mismatch");
    return { kind: "skip", reason: "unregistered" };
  }

  let signed: HandshakeSigningResult;
  try {
    signed = await deps.signChallenge({ domain: started.domain, agentHash, nonce: started.nonce });
  } catch (err) {
    // A typed throw out of the signer (SIGNER_MISMATCH, a corrupt keystore, a
    // rejected handshake template, …) is a client bug, not weather — same
    // long-hold discipline as an invalid session/complete response, so it
    // never bypasses the lane's backoff into a hot loop of fresh
    // session/starts.
    await reportingRepo.noteRegisterAttemptFailed(HANDSHAKE_INVALID_HOLD_SECONDS);
    logger.error("agentscan.report.handshake_sign_failed", { detail: signFailureDetail(err) });
    return { kind: "skip", reason: "unregistered" };
  }
  if (signed.kind === "vault_locked") return { kind: "skip", reason: "vault_locked" };
  if (signed.kind === "no_wallets") return { kind: "skip", reason: "no_wallets" };

  const completed = await session.sessionComplete(
    {
      challengeId: started.challengeId,
      agentHash,
      consentVersion: state.consentVersion,
      ...(appVersion !== null ? { appVersion: appVersion.slice(0, 32) } : {}),
      proofs: signed.proofs,
    },
    ingestToken,
  );

  if (completed.kind === "bound") {
    await reportingRepo.markHandshakeComplete({
      agentName: completed.agentName,
      ingestToken: completed.ingestToken,
      serverCursorRowId: completed.lastAcceptedRowId,
      walletsFingerprint: fingerprint,
    });
    logger.info("agentscan.report.handshake_bound");
    return { kind: "handshaken", ingestToken: completed.ingestToken };
  }
  if (completed.kind === "challenge_expired") {
    // Not a failure worth punishing — just restart the flow next run.
    logger.warn("agentscan.report.handshake_challenge_expired");
    return { kind: "skip", reason: "unregistered" };
  }
  if (completed.kind === "auth_lost") {
    // Token mismatch on an EXISTING binding is NOT the events endpoint's
    // recovery: the server holds SOME current token for this agent_hash that
    // we don't know (canonically a crash between the server's rotation and
    // our own markHandshakeComplete persist), so retrying the SAME identity
    // would keep presenting the same stale bearer forever. Abandon the
    // identity; ensureIdentity mints a fresh one next run, and the server's
    // transfer-on-proof re-binds the same proven wallets to it.
    await reportingRepo.resetIdentityForRecovery();
    logger.warn("agentscan.report.handshake_auth_lost_identity_reset");
    return { kind: "skip", reason: "unregistered" };
  }
  if (completed.kind === "wallet_conflict") {
    // Defensive: the current server transfers a proven wallet instead of
    // refusing with 409 in ordinary operation, but the reserved code path
    // stays honored in case a future policy reintroduces the refusal.
    await reportingRepo.markStopped("wallet_conflict");
    logger.error("agentscan.report.handshake_wallet_conflict_stopped");
    return { kind: "skip", reason: "stopped" };
  }
  if (completed.kind === "invalid") {
    // Our own signed envelope failed the server's validation — a client bug,
    // not weather. Held long and logged loud, same discipline as an
    // envelope-level 400 on the events endpoint.
    await reportingRepo.noteRegisterAttemptFailed(HANDSHAKE_INVALID_HOLD_SECONDS);
    logger.error("agentscan.report.handshake_invalid", { detail: completed.detail });
    return { kind: "skip", reason: "unregistered" };
  }
  // retryable — 429/5xx/network.
  const delay = completed.retryAfterSeconds ?? registerBackoffSeconds(state.registerAttemptCount);
  await reportingRepo.noteRegisterAttemptFailed(delay);
  logger.warn("agentscan.report.handshake_complete_failed", { detail: completed.detail, retryInSeconds: delay });
  return { kind: "skip", reason: "unregistered" };
}

function registerBackoffSeconds(attemptCount: number): number {
  return Math.min(
    REGISTER_BACKOFF_BASE_SECONDS * 2 ** Math.min(attemptCount, 20),
    REGISTER_BACKOFF_MAX_SECONDS,
  );
}

/** The signer's error CODE for a `VexError`, else the error's NAME only — never a message that could carry key material. */
function signFailureDetail(err: unknown): string {
  if (err instanceof VexError) return err.code;
  if (err instanceof Error) return err.name;
  return "unknown";
}
