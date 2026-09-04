/**
 * Solana RPC safety primitives — SSRF-safe URL selection + genesis-hash
 * cluster verification + a minimal raw JSON-RPC POST helper.
 *
 * EXTRACTED from `bridge-activity-repair.ts` (Phase-2 W4) so the W5 Solana
 * activity sweep (`solana-activity-repair.ts`, design `w5-design.md` §4/R3)
 * can reuse the SAME genesis-verified, SSRF-hardened RPC access pattern
 * instead of duplicating it (R3: "reuse/extract bridge-activity-repair's
 * genesis-check + SSRF-safe RPC module"). `bridge-activity-repair.ts`
 * re-exports every name below unchanged so its own existing tests
 * (`bridge-activity-repair-verification.test.ts`) keep importing from the
 * same module path — this is a MOVE, not a behavior change.
 *
 * SSRF (Blocker 10, Phase-2 W4): a provider-supplied RPC URL is untrusted
 * input. The classifiers that decide it now live in `rpc-egress-policy.js`
 * (re-exported below, unchanged) beside the connect-time DNS pin that closes
 * the rebinding window a syntactic check never could. This module keeps the
 * SELECTION order (`selectVerificationRpcUrls`) and the raw POST, which pins
 * `redirect: "error"` and takes the caller's dispatcher and deadline.
 *
 * GENESIS VERIFICATION: the Solana analog of an EVM `eth_chainId` echo —
 * before trusting an RPC's answer (a signature status, a transaction, a
 * block height) for anything that can TERMINALIZE an `agent_activity` row,
 * confirm the endpoint actually serves mainnet-beta. A misconfigured or
 * re-pointed endpoint cannot fake this echo.
 */

import type { Dispatcher } from "undici";

import logger from "@utils/logger.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";

import { isSsrfSafeRpcUrl } from "./rpc-egress-policy.js";
import type { DispatchableRequestInit } from "./rpc-egress-policy.js";

/**
 * Solana mainnet-beta genesis hash — an immutable cluster identity constant.
 */
export const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/**
 * THE SSRF CLASSIFIERS LIVE IN `rpc-egress-policy.ts` NOW, beside the connect-time
 * pin that closes the DNS-rebinding hole they could never close on their own
 * (external review of PR #142, blocker 1). They are re-exported here unchanged
 * so every existing import path - this module, `bridge-activity-repair.ts`'s own
 * re-export, and their tests - keeps working: this is a MOVE, not a behavior
 * change.
 */
export { isSsrfSafeRpcUrl, isPrivateOrLoopbackHost } from "./rpc-egress-policy.js";

/**
 * Choose the ordered RPC endpoints to verify against: curated/local
 * registry URLs FIRST (trusted, never SSRF-filtered), then provider-registry URLs
 * that pass {@link isSsrfSafeRpcUrl}. De-duplicated, order preserved. An empty
 * result means "no safe RPC" — the caller reports unverifiable and the row
 * stays pending (fail-closed).
 *
 * THE ONE ORDERING OWNER. Callers grow the CANDIDATE SET, never add a second
 * selector: the bridge verifier's `resolveVerificationRpcs` puts the user's own
 * RPC overrides and the local chain registry in `curated` (the app's own
 * configuration, used as configured) and the Khalani, Relay and viem-bundled
 * chain registries in `providerRegistry` (untrusted, SSRF-filtered here), and
 * each bucket keeps its internal order. Two registries naming the same endpoint
 * cost one probe, not two.
 */
export function selectVerificationRpcUrls(input: {
  readonly curated: readonly string[];
  readonly providerRegistry: readonly string[];
}): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (url: string): void => {
    const trimmed = url.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };
  for (const url of input.curated) push(url);
  for (const url of input.providerRegistry) if (isSsrfSafeRpcUrl(url)) push(url);
  return ordered;
}

/**
 * Minimal JSON-RPC POST for Solana verification: redirect OFF (SSRF), no auth
 * headers, a bounded per-call timeout. Returns `result`.
 *
 * `egress` is the CALLER's decision, because the two callers stand on different
 * ground: the Solana activity sweep uses the app's own configured endpoint
 * (`cfg.solana.rpcUrl`, the same one that signs and broadcasts) and must keep
 * working when that endpoint is a self-hosted node, while the bridge verifier
 * reads a PROVIDER REGISTRY and passes the pinning dispatcher from
 * `rpc-egress-policy.js`. Default: no dispatcher, i.e. as configured.
 *
 * `signal` lets the caller's own deadline cut the request; it is combined with
 * the per-call timeout rather than replacing it.
 */
export async function solanaRpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
  options?: { readonly signal?: AbortSignal; readonly dispatcher?: Dispatcher; readonly timeoutMs?: number },
): Promise<unknown> {
  const timeout = AbortSignal.timeout(options?.timeoutMs ?? SOLANA_RPC_CALL_TIMEOUT_MS);
  const init: DispatchableRequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    redirect: "error",
    signal: options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    dispatcher: options?.dispatcher,
  };
  const res = await fetch(rpcUrl, init);
  if (!res.ok) throw new Error(`solana rpc ${method}: http ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error !== null && body.error !== undefined) throw new Error(`solana rpc ${method}: rpc error`);
  return body.result;
}

/** Per-call bound for a Solana JSON-RPC read. Unchanged from the value this helper shipped with. */
const SOLANA_RPC_CALL_TIMEOUT_MS = 15_000;

/**
 * The genesis-hash cluster echo (the Solana analog of an EVM `eth_chainId`
 * check): `true` only when `rpcUrl` actually serves mainnet-beta. `false` on
 * any mismatch, transient error, or malformed response — callers must treat
 * `false` as "cannot trust this endpoint" (fail-closed), never as evidence
 * about the thing being verified.
 */
export async function confirmSolanaMainnetGenesis(rpcUrl: string): Promise<boolean> {
  try {
    const genesis = await solanaRpcCall(rpcUrl, "getGenesisHash", []);
    return typeof genesis === "string" && genesis === SOLANA_MAINNET_GENESIS;
  } catch (err) {
    logger.debug("solana.rpc_safety.genesis_check_failed", {
      error: summarizeProtocolError(err).message,
    });
    return false;
  }
}
