/**
 * `bridge-activity-repair.ts` B4 independent on-chain fill/refund
 * verification — split out (Card C5, move-only) once the parent file
 * crossed the repo's 500-line cap. See `bridge-activity-repair.ts`'s own
 * module doc ("INDEPENDENT VERIFICATION BEFORE ANY CONFIRM") for why a
 * provider `filled`/`success` is never trusted on its own.
 */

import type { BridgeChainFamily } from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";
import {
  SOLANA_MAINNET_GENESIS,
  selectVerificationRpcUrls,
  solanaRpcCall,
} from "./solana-rpc-safety.js";
import type { FillVerification, FillVerificationInput } from "./bridge-activity-repair-contracts.js";

/**
 * Production B4 leg verifier (fills AND refunds). EVM: SSRF-controlled RPC
 * selection (curated/local first, provider-registry fallback validated
 * public-HTTPS + non-private) → `eth_chainId` echo (must match the expected
 * chain) → `getTransactionReceipt` (must exist and succeed). Solana:
 * `getGenesisHash` cluster echo → `getSignatureStatuses` (`err == null` + a
 * `confirmed`/`finalized` status).
 *
 * AN UNVERIFIED LEG NAMES WHAT WE ACTUALLY OBSERVED. Every abandoned endpoint
 * used to collapse into one `receipt_unavailable`, so "the chain is unreachable",
 * "no endpoint serves this chain" and "mined in a minute, just not yet" were the
 * same word in the UI and in the agent's view. Each URL now records what it
 * established and the loop returns the most specific one (`resolveEvmProbeReason`
 * / `resolveSolanaProbeReason`, fixed precedence). NEVER decodes executed amounts this phase (they
 * stay NULL and quoted amounts remain estimates — Q2; transfer-log decoding
 * against the stored token + recipient is a named follow-up, and the recipient is
 * not stored anyway — Blocker 7). Any failure → `verified:false` so the row stays
 * pending (fail-closed). All verification fetches pin redirects OFF.
 */
export async function verifyBridgeLegOnChain(input: FillVerificationInput): Promise<FillVerification> {
  if (input.chainFamily === "solana") {
    return verifySolanaLegOnChain(input);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
    return { verified: false, reason: "malformed_fill_hash" };
  }

  const { curated, providerRegistry } = await resolveVerificationRpcs(input.expectedChainId, input.protocol, "eip155");
  const urls = selectVerificationRpcUrls({ curated, providerRegistry });
  if (urls.length === 0) return { verified: false, reason: "no_safe_rpc" };

  const { createPublicClient, http } = await import("viem");
  const observations: EvmProbeObservation[] = [];
  for (const rpcUrl of urls) {
    try {
      const client = createPublicClient({
        // Redirect-off (Blocker 10): a 3xx to a re-pointed (possibly private) host
        // is refused, not followed. The chain-id echo below is the second defense.
        transport: http(rpcUrl, { timeout: 15_000, retryCount: 1, fetchOptions: { redirect: "error" } }),
      });
      const echo = await client.getChainId();
      if (echo !== input.expectedChainId) {
        observations.push("chain_echo_mismatch"); // wrong chain / swapped endpoint — try the next url.
        continue;
      }
      const status: unknown = (await client.getTransactionReceipt({ hash: input.txHash as `0x${string}` })).status;
      // Receipt exists: only the LITERAL statuses are proof. viem's formatter
      // maps `0x1`/`0x0` and yields a nullish value for anything else, so
      // treating "not success" as a revert (F7) would tell the user their fill
      // REVERTED when we merely could not read the status — a claim beyond the
      // evidence, and the same trap the EVM sweep already avoids
      // (`agent-activity-repair.ts`). A revert is definitive NOT-verified; an
      // unreadable status is an inconclusive check. Neither confirms.
      if (status === "success") return { verified: true };
      if (status === "reverted") return { verified: false, reason: "fill_reverted" };
      observations.push("unreadable_receipt_status");
      continue;
    } catch (err) {
      // Not mined yet, or a transport failure. The two are different facts for
      // the user — "wait" versus "we cannot see this chain" — and this loop is
      // the only place that can still tell them apart.
      observations.push(isReceiptNotFound(err) ? "fill_not_mined" : "rpc_unreachable");
      logger.debug("bridge.repair.rpc_probe_miss", { chainId: input.expectedChainId, error: summarizeProtocolError(err).message });
      continue;
    }
  }
  return { verified: false, reason: resolveEvmProbeReason(observations) };
}

/** What ONE endpoint established about the fill hash, when it did not settle the question. */
export type EvmProbeObservation =
  | "chain_echo_mismatch"
  | "fill_not_mined"
  | "unreadable_receipt_status"
  | "rpc_unreachable";

/**
 * Reduce what several endpoints said into the single most specific fact the loop
 * actually established.
 *
 * This replaces one flat `receipt_unavailable` for every abandoned URL. The
 * string is rendered verbatim to the user (`AgentScanRow.tsx`) and to the agent
 * (`inspect-views/transactions.ts`), where `fill_not_mined` means "wait" and
 * `rpc_unreachable` means "we cannot see this chain" — a difference the old
 * single word erased.
 *
 * PRECEDENCE IS FIXED, most-specific-wins, so the answer does not depend on the
 * order the URLs happened to be tried: a receipt we could not READ beats
 * "no receipt yet" beats "no endpoint served this chain" beats "no endpoint
 * answered at all". (A receipt we COULD read never reaches here — the loop
 * returns on it.)
 */
export function resolveEvmProbeReason(observations: readonly EvmProbeObservation[]): EvmProbeObservation | "no_safe_rpc" {
  for (const candidate of ["unreadable_receipt_status", "fill_not_mined", "chain_echo_mismatch", "rpc_unreachable"] as const) {
    if (observations.includes(candidate)) return candidate;
  }
  // Unreachable while `urls.length > 0` — every path above records exactly one
  // observation per URL. Named rather than defaulted to a fill-specific reason.
  return "no_safe_rpc";
}

/**
 * viem's `TransactionReceiptNotFoundError` by its stable `name`, never by its
 * message — the message embeds the RPC URL, so matching on it would both be
 * fragile and put a provider URL into a comparison it does not belong in.
 */
function isReceiptNotFound(err: unknown): boolean {
  return err instanceof Error && err.name === "TransactionReceiptNotFoundError";
}

/**
 * Solana destination-leg verification (Blocker 10): a signature-status lookup
 * over an SSRF-safe registry RPC. `getGenesisHash` confirms the endpoint serves
 * mainnet-beta (the Solana analog of the EVM `eth_chainId` echo), then
 * `getSignatureStatuses` with `searchTransactionHistory` proves the signature —
 * `err == null` + a `confirmed`/`finalized` status ⇒ verified; a present `err` ⇒
 * definitively NOT verified (the fill tx failed). Any transient/unavailable case
 * ⇒ not verified, row stays pending. Redirects are pinned OFF.
 */
async function verifySolanaLegOnChain(input: FillVerificationInput): Promise<FillVerification> {
  // Base58 Solana signatures are ~87–88 chars; reject an EVM-shaped hash outright.
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(input.txHash)) {
    return { verified: false, reason: "malformed_fill_signature" };
  }
  const { providerRegistry } = await resolveVerificationRpcs(input.expectedChainId, input.protocol, "solana");
  // Solana has no curated/local EVM RPC — only the SSRF-validated provider registry.
  const urls = selectVerificationRpcUrls({ curated: [], providerRegistry });
  if (urls.length === 0) return { verified: false, reason: "no_safe_rpc" };

  const observations: SolanaProbeObservation[] = [];
  for (const rpcUrl of urls) {
    try {
      const genesis = await solanaRpcCall(rpcUrl, "getGenesisHash", []);
      if (typeof genesis !== "string" || genesis !== SOLANA_MAINNET_GENESIS) {
        observations.push("chain_echo_mismatch"); // wrong cluster — try next.
        continue;
      }
      const result = await solanaRpcCall(rpcUrl, "getSignatureStatuses", [
        [input.txHash],
        { searchTransactionHistory: true },
      ]);
      const value = typeof result === "object" && result !== null ? (result as Record<string, unknown>).value : undefined;
      const entry = Array.isArray(value) ? value[0] : null;
      if (entry === null || entry === undefined || typeof entry !== "object") {
        observations.push("signature_status_unavailable"); // unknown on this node — try next.
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (record.err !== null && record.err !== undefined) {
        return { verified: false, reason: "fill_failed" }; // definitive: the tx errored.
      }
      const confirmationStatus = record.confirmationStatus;
      if (confirmationStatus === "confirmed" || confirmationStatus === "finalized") {
        return { verified: true };
      }
      return { verified: false, reason: "not_yet_confirmed" };
    } catch (err) {
      observations.push("rpc_unreachable");
      logger.debug("bridge.repair.solana_probe_miss", {
        chainId: input.expectedChainId,
        error: summarizeProtocolError(err).message,
      });
      continue;
    }
  }
  return { verified: false, reason: resolveSolanaProbeReason(observations) };
}

/** What ONE Solana endpoint established, when it did not settle the question. */
export type SolanaProbeObservation = "chain_echo_mismatch" | "signature_status_unavailable" | "rpc_unreachable";

/**
 * Same rule as the EVM reducer: "a node answered and did not know this
 * signature" is a different fact from "no node answered at all", and reporting
 * both as `signature_status_unavailable` told the user we had looked when we had
 * not. Most-specific-wins, fixed order.
 */
export function resolveSolanaProbeReason(
  observations: readonly SolanaProbeObservation[],
): SolanaProbeObservation | "no_safe_rpc" {
  for (const candidate of ["signature_status_unavailable", "chain_echo_mismatch", "rpc_unreachable"] as const) {
    if (observations.includes(candidate)) return candidate;
  }
  return "no_safe_rpc";
}

/**
 * Curated/local RPCs (EVM only, trusted) + PROVIDER-registry RPCs from the RIGHT
 * registry for the owning protocol (Blocker 10): Relay `/chains` (`httpRpcUrl`)
 * for relay bridges, Khalani `/v1/chains` (`rpcUrls.default.http[0]`) for khalani
 * — never always Khalani. All provider-registry URLs are SSRF-validated downstream.
 */
async function resolveVerificationRpcs(
  chainId: number,
  protocol: string,
  family: BridgeChainFamily,
): Promise<{ curated: string[]; providerRegistry: string[] }> {
  const curated: string[] = [];
  const providerRegistry: string[] = [];

  if (family === "eip155") {
    try {
      const { getLocalChain, getLocalChainRpcUrl } = await import("@tools/evm-chains/registry.js");
      const local = getLocalChain(chainId);
      if (local) curated.push(getLocalChainRpcUrl(local));
    } catch (err) {
      logger.debug("bridge.repair.local_rpc_lookup_failed", { chainId, error: summarizeProtocolError(err).message });
    }
  }

  if (protocol === "relay") {
    try {
      const { getCachedRelayChains } = await import("@tools/relay/client.js");
      const chains = await getCachedRelayChains();
      const match = chains.find((c) => c.id === chainId);
      // Relay `/chains` exposes the RPC as `httpRpcUrl` (passthrough on RelayChain).
      const url = match ? readHttpRpcUrl(match) : null;
      if (url) providerRegistry.push(url);
    } catch (err) {
      logger.debug("bridge.repair.provider_rpc_lookup_failed", { chainId, protocol, error: summarizeProtocolError(err).message });
    }
  } else {
    try {
      const { getCachedKhalaniChains } = await import("@tools/khalani/chains.js");
      const chains = await getCachedKhalaniChains();
      const match = chains.find((c) => c.id === chainId);
      const url = match?.rpcUrls?.default?.http?.[0];
      if (url) providerRegistry.push(url);
    } catch (err) {
      logger.debug("bridge.repair.provider_rpc_lookup_failed", { chainId, protocol, error: summarizeProtocolError(err).message });
    }
  }

  return { curated, providerRegistry };
}

/** Read the passthrough `httpRpcUrl` string from a Relay chain record (not in the typed schema). */
function readHttpRpcUrl(chain: object): string | null {
  const value = (chain as Record<string, unknown>).httpRpcUrl;
  return typeof value === "string" && value.length > 0 ? value : null;
}
