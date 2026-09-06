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
import { createPinnedPublicEgressDispatcher, isEgressRefusal } from "./rpc-egress-policy.js";
import type { DispatchableRequestInit } from "./rpc-egress-policy.js";
import {
  BRIDGE_LEG_VERIFICATION_DEADLINE_MS,
  BRIDGE_RPC_CANDIDATE_TIMEOUT_MS,
} from "./bridge-activity-repair-contracts.js";
import type {
  FillVerification,
  FillVerificationInput,
  VerificationReason,
} from "./bridge-activity-repair-contracts.js";
import type { Dispatcher } from "undici";

/**
 * Production B4 leg verifier (fills AND refunds). EVM: SSRF-controlled RPC
 * selection over EVERY endpoint source the app trusts for the destination chain
 * (`resolveVerificationRpcs`: user overrides and the local registry first, then
 * the Khalani, Relay and viem-bundled registries, each validated public-HTTPS +
 * non-private) → `eth_chainId` echo (must match the expected
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
 *
 * TWO BOUNDS THIS VERIFIER OWNS, added after external review of PR #142:
 *
 *   EGRESS. A provider-registry URL is fetched through the pinning dispatcher
 *   from `rpc-egress-policy.js`: its hostname is resolved before any socket
 *   exists, refused if ANY address is non-public, and pinned to the checked
 *   address so a rebinding has no second resolution to win. A CURATED URL (the
 *   user's overrides, the local registry) is fetched as configured, because a
 *   self-hosted node on a private address is supported. A refusal is recorded as
 *   `no_safe_rpc`, not as "the chain is unreachable".
 *
 *   TIME. One leg gets {@link BRIDGE_LEG_VERIFICATION_DEADLINE_MS} in total,
 *   propagated as ONE AbortSignal through the registry reads and every RPC call,
 *   with {@link BRIDGE_RPC_CANDIDATE_TIMEOUT_MS} per candidate and NO transport
 *   retry (the candidate list is the fallback). Exhaustion reports the most
 *   specific thing the endpoints established and terminalizes nothing.
 */
export async function verifyBridgeLegOnChain(input: FillVerificationInput): Promise<FillVerification> {
  const budget = startLegVerificationBudget(BRIDGE_LEG_VERIFICATION_DEADLINE_MS);
  // ONE dispatcher per leg verification, owned here and closed below: it is the
  // egress decision for every PROVIDER-REGISTRY candidate this leg touches, and
  // it holds keep-alive sockets, so it has exactly one lifecycle owner.
  const egress = createPinnedPublicEgressDispatcher();
  try {
    return input.chainFamily === "solana"
      ? await verifySolanaLegOnChain(input, budget, egress)
      : await verifyEvmLegOnChain(input, budget, egress);
  } finally {
    budget.dispose();
    await egress.close();
  }
}

async function verifyEvmLegOnChain(
  input: FillVerificationInput,
  budget: LegVerificationBudget,
  egress: Dispatcher,
): Promise<FillVerification> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
    return { verified: false, reason: "malformed_fill_hash" };
  }

  // The registry reads are inside the budget too: a hung provider registry used
  // to be able to consume the whole sweep before a single RPC was tried. The
  // registry clients own their own timeouts and keep running if abandoned; what
  // this race owns is that WE stop waiting.
  const resolved = await raceBudget(
    resolveVerificationRpcs(input.expectedChainId, input.protocol, "eip155"),
    budget,
  );
  if (!resolved.settled) return { verified: false, reason: reportLegDeadline(input, [], null) };
  const { curated, providerRegistry } = resolved.value;
  const urls = selectVerificationRpcUrls({ curated, providerRegistry });
  if (urls.length === 0) return { verified: false, reason: "no_safe_rpc" };
  const trustedAsConfigured = new Set(curated.map((url) => url.trim()));

  const { createPublicClient, http } = await import("viem");
  const observations: EvmProbeOutcome[] = [];
  for (const rpcUrl of urls) {
    if (budget.expired()) break;
    try {
      const probe = await withinCandidateBudget(budget, async (signal) => {
        const fetchOptions: DispatchableRequestInit = {
          redirect: "error",
          signal,
          dispatcher: trustedAsConfigured.has(rpcUrl) ? undefined : egress,
        };
        const client = createPublicClient({
          // Redirect-off: a 3xx to a re-pointed (possibly private)
          // host is refused, not followed. `dispatcher` is the connect-time
          // egress decision for a PROVIDER-supplied URL - resolve, refuse
          // non-public, pin the checked address - and is deliberately absent for
          // a curated URL, because the user's own archive node on a private
          // address is a supported setup. `signal` is the leg budget reaching
          // the socket; `retryCount: 0` because the candidate list is the
          // fallback, not the same endpoint twice.
          transport: http(rpcUrl, { timeout: BRIDGE_RPC_CANDIDATE_TIMEOUT_MS, retryCount: 0, fetchOptions }),
        });
        const echo = await client.getChainId();
        if (echo !== input.expectedChainId) {
          return { kind: "observed", observation: "chain_echo_mismatch" } as const;
        }
        const status: unknown = (await client.getTransactionReceipt({ hash: input.txHash as `0x${string}` })).status;
        // Receipt exists: only the LITERAL statuses are proof. viem's formatter
        // maps `0x1`/`0x0` and yields a nullish value for anything else, so
        // treating "not success" as a revert (F7) would tell the user their fill
        // REVERTED when we merely could not read the status - a claim beyond the
        // evidence, and the same trap the EVM sweep already avoids
        // (`agent-activity-repair.ts`). A revert is definitive NOT-verified; an
        // unreadable status is an inconclusive check. Neither confirms.
        if (status === "success") return { kind: "verified" } as const;
        if (status === "reverted") return { kind: "reverted" } as const;
        return { kind: "observed", observation: "unreadable_receipt_status" } as const;
      });
      if (!probe.settled) {
        // The candidate ran out of its own time, or the leg did. Either way this
        // endpoint told us nothing: no answer is `rpc_unreachable`, exactly as a
        // socket failure is.
        observations.push("rpc_unreachable");
        continue;
      }
      if (probe.value.kind === "verified") return { verified: true };
      if (probe.value.kind === "reverted") return { verified: false, reason: "fill_reverted" };
      observations.push(probe.value.observation);
      continue;
    } catch (err) {
      // Not mined yet, an endpoint that ANSWERED and refused, a transport
      // failure, or OUR OWN egress policy refusing a provider URL that resolves
      // into private space. Four different facts for the user - "wait", "this
      // endpoint will not serve us", "we cannot see this chain", "that endpoint
      // is not one we may reach" - and this loop is the only place that can
      // still tell them apart. Each continues to the next URL.
      const observation = classifyEvmProbeError(err);
      observations.push(observation);
      logger.debug("bridge.repair.rpc_probe_miss", {
        chainId: input.expectedChainId,
        observation,
        error: summarizeProtocolError(err).message,
      });
      continue;
    }
  }
  if (budget.expired()) {
    const reduced = observations.length > 0 ? resolveEvmProbeReason(observations) : null;
    return { verified: false, reason: reportLegDeadline(input, observations, reduced) };
  }
  return { verified: false, reason: resolveEvmProbeReason(observations) };
}

/**
 * THE LEG BUDGET: one owner-created signal, propagated through the registry
 * reads and every RPC call of one leg verification, and disposed by its owner.
 *
 * The shape follows VS Code's `createCancelablePromise`/`raceCancellation`
 * (`src/vs/base/common/async.ts`): the owner mints ONE signal, every await gets
 * it, and abandonment never leaves a timer behind. `setTimeout` rather than
 * `AbortSignal.timeout` deliberately - the former is what a fake-timer test can
 * drive, and this deadline has to be provable without waiting 20 real seconds.
 */
interface LegVerificationBudget {
  readonly signal: AbortSignal;
  /** True once the leg deadline has fired. Checked before starting more work, never assumed from a rejection. */
  expired(): boolean;
  dispose(): void;
}

function startLegVerificationBudget(ms: number): LegVerificationBudget {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(new Error("bridge leg verification deadline")), ms);
  return {
    signal: controller.signal,
    expired: () => controller.signal.aborted,
    dispose: () => clearTimeout(handle),
  };
}

/** Settled by the work, or abandoned because a deadline fired first. */
type BudgetedOutcome<T> = { readonly settled: true; readonly value: T } | { readonly settled: false };

/**
 * Race owned work against an abort signal. Abandoning does NOT prove the work
 * stopped (rule 05: abort requests cancellation, it does not prove quiescence);
 * it proves this owner stopped waiting. The rejection handler stays attached so
 * a late failure of abandoned work is swallowed rather than surfacing as an
 * unhandled rejection.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<BudgetedOutcome<T>> {
  return new Promise<BudgetedOutcome<T>>((resolve, reject) => {
    if (signal.aborted) {
      void work.catch(() => undefined);
      resolve({ settled: false });
      return;
    }
    const onAbort = (): void => resolve({ settled: false });
    signal.addEventListener("abort", onAbort, { once: true });
    work
      .then(
        (value) => resolve({ settled: true, value }),
        (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
      )
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function raceBudget<T>(work: Promise<T>, budget: LegVerificationBudget): Promise<BudgetedOutcome<T>> {
  return raceAbort(work, budget.signal);
}

/**
 * Run ONE candidate under its own timeout, linked to the leg budget: whichever
 * fires first aborts the transport and returns the loop its turn. The
 * per-candidate timer is always cleared and the link always removed, so an
 * abandoned candidate leaves no timer and no listener behind.
 */
async function withinCandidateBudget<T>(
  budget: LegVerificationBudget,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<BudgetedOutcome<T>> {
  if (budget.expired()) return { settled: false };
  const controller = new AbortController();
  const onLegDeadline = (): void => controller.abort(budget.signal.reason);
  budget.signal.addEventListener("abort", onLegDeadline, { once: true });
  const handle = setTimeout(() => controller.abort(new Error("bridge rpc candidate timeout")), BRIDGE_RPC_CANDIDATE_TIMEOUT_MS);
  try {
    return await raceAbort(run(controller.signal), controller.signal);
  } finally {
    clearTimeout(handle);
    budget.signal.removeEventListener("abort", onLegDeadline);
  }
}

/**
 * What a leg that ran out of time reports. It TERMINALIZES NOTHING: the row
 * stays pending and is retried on the next tick.
 *
 * Whatever the endpoints did manage to establish still wins (`reduced`),
 * because "an endpoint refused us" remains the more specific fact even when the
 * clock ended the search. A leg that learned nothing at all - a registry read
 * that outlasted the budget - falls back to the vocabulary's generic
 * `verification_failed`: the 065 vocabulary has no member for "we ran out of
 * budget", and that column's owner is another module
 * (`db/repos/agent-activity/types/verification.ts`).
 */
function reportLegDeadline(
  input: FillVerificationInput,
  observations: readonly string[],
  reduced: VerificationReason | null,
): VerificationReason {
  logger.debug("bridge.repair.leg_deadline_exceeded", {
    chainId: input.expectedChainId,
    chainFamily: input.chainFamily,
    observations: [...observations],
  });
  return reduced ?? "verification_failed";
}

/** What ONE endpoint established about the fill hash, when it did not settle the question. */
export type EvmProbeObservation =
  | "chain_echo_mismatch"
  | "fill_not_mined"
  | "unreadable_receipt_status"
  | "rpc_refused_request"
  | "rpc_unreachable";

/**
 * What one endpoint established, PLUS the one outcome that is about us rather
 * than about the endpoint: `no_safe_rpc`, recorded when our own egress policy
 * refused to open the socket because the provider's hostname resolved into
 * private space.
 *
 * It is deliberately the 065 vocabulary's EXISTING member rather than a new
 * one: the column means "why the last check could not conclude", and "we had no
 * endpoint we were allowed to reach" is exactly what `no_safe_rpc` already says
 * for the syntactic refusals. The vocabulary itself is owned by
 * `db/repos/agent-activity/types/verification.ts`, not by this family.
 */
export type EvmProbeOutcome = EvmProbeObservation | "no_safe_rpc";

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
 * "no receipt yet" beats "no endpoint served this chain" beats "an endpoint
 * refused the request" beats "no endpoint answered at all". (A receipt we COULD
 * read never reaches here: the loop returns on it.)
 *
 * `rpc_refused_request` outranks `rpc_unreachable` because it is the strictly
 * stronger statement: an endpoint was reached, understood us, and declined -
 * measured live on 2026-09-04, where `arbitrum-one.publicnode.com` answered
 * `eth_chainId` for chain 42161 and then returned JSON-RPC `-32602` for a
 * month-old receipt (an "archive" request there). Reporting that as "we cannot
 * see this chain" is what let one row re-probe the same refusing endpoint 1227
 * times over 31 days.
 */
export function resolveEvmProbeReason(observations: readonly EvmProbeOutcome[]): EvmProbeOutcome {
  for (const candidate of [
    "unreadable_receipt_status",
    "fill_not_mined",
    "chain_echo_mismatch",
    "rpc_refused_request",
    "rpc_unreachable",
    "no_safe_rpc",
  ] as const) {
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

/** How far down an error's `cause` chain the classifier looks. viem nests two levels; five is slack. */
const ERROR_CAUSE_MAX_DEPTH = 5;

/**
 * viem's placeholder code for "an error with no JSON-RPC code of its own"
 * (`UnknownRpcError`, `errors/rpc.js` `unknownErrorCode`). It is NOT evidence
 * that an endpoint answered, so it never counts as a refusal.
 */
const VIEM_UNKNOWN_RPC_CODE = -1;

/**
 * What ONE failed probe of a single endpoint established.
 *
 * OUR OWN REFUSAL IS CHECKED FIRST. An egress refusal never reached a socket, so
 * reporting it as `rpc_unreachable` ("no endpoint answered") would describe the
 * chain when the fact is about the endpoint we declined to reach.
 */
function classifyEvmProbeError(err: unknown): EvmProbeOutcome {
  if (isEgressRefusal(err)) return "no_safe_rpc";
  if (isReceiptNotFound(err)) return "fill_not_mined";
  return isJsonRpcErrorResponse(err) ? "rpc_refused_request" : "rpc_unreachable";
}

/**
 * Did the endpoint ANSWER with a JSON-RPC `error` object, as opposed to never
 * answering at all?
 *
 * MATCHED BY CLASS AND CODE, NEVER BY MESSAGE TEXT. The message is the
 * provider's own prose (`arbitrum-one.publicnode.com` says "Archive requests
 * require a personal token"), it changes without notice, and it embeds the RPC
 * URL - none of which belongs in a comparison that decides what we tell the
 * user.
 *
 * MEASURED against viem 2.54.3 on 2026-09-04, both branches, one call each:
 *
 * - JSON-RPC error response: `InvalidParamsRpcError` (`code` -32602, a NUMBER)
 *   whose `cause` is `RpcRequestError` (`code` -32602). Every `RpcError`
 *   subclass carries the numeric code from its `RpcRequestError` cause
 *   (`errors/rpc.js`), and `buildRequest` mints them from the response body's
 *   `error.code`, so the pair (name, numeric code) is the stable artifact.
 * - Transport failure: `HttpRequestError` (no `code`) -> `TypeError` (no
 *   `code`) -> a Node error whose `code` is the STRING "ENOTFOUND". Requiring
 *   a NUMBER is what keeps a socket error out of this branch.
 */
function isJsonRpcErrorResponse(err: unknown): boolean {
  let node: unknown = err;
  for (let depth = 0; depth < ERROR_CAUSE_MAX_DEPTH && node instanceof Error; depth += 1) {
    if (node.name === "RpcRequestError") return true;
    const code = (node as Error & { code?: unknown }).code;
    if (typeof code === "number" && code !== VIEM_UNKNOWN_RPC_CODE) return true;
    node = node.cause;
  }
  return false;
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
async function verifySolanaLegOnChain(
  input: FillVerificationInput,
  budget: LegVerificationBudget,
  egress: Dispatcher,
): Promise<FillVerification> {
  // Base58 Solana signatures are ~87-88 chars; reject an EVM-shaped hash outright.
  if (!/^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(input.txHash)) {
    return { verified: false, reason: "malformed_fill_signature" };
  }
  const resolved = await raceBudget(
    resolveVerificationRpcs(input.expectedChainId, input.protocol, "solana"),
    budget,
  );
  if (!resolved.settled) return { verified: false, reason: reportLegDeadline(input, [], null) };
  // Solana has no curated/local EVM RPC - only the SSRF-validated provider
  // registry, which means EVERY candidate here goes through the pinning
  // dispatcher, with no as-configured bucket to exempt.
  const urls = selectVerificationRpcUrls({ curated: [], providerRegistry: resolved.value.providerRegistry });
  if (urls.length === 0) return { verified: false, reason: "no_safe_rpc" };

  const observations: SolanaProbeOutcome[] = [];
  for (const rpcUrl of urls) {
    if (budget.expired()) break;
    try {
      const probe = await withinCandidateBudget(budget, async (signal) => {
        const call = (method: string, params: unknown[]): Promise<unknown> =>
          solanaRpcCall(rpcUrl, method, params, {
            signal,
            dispatcher: egress,
            timeoutMs: BRIDGE_RPC_CANDIDATE_TIMEOUT_MS,
          });
        const genesis = await call("getGenesisHash", []);
        if (typeof genesis !== "string" || genesis !== SOLANA_MAINNET_GENESIS) {
          return { kind: "observed", observation: "chain_echo_mismatch" } as const;
        }
        return {
          kind: "statuses",
          result: await call("getSignatureStatuses", [[input.txHash], { searchTransactionHistory: true }]),
        } as const;
      });
      if (!probe.settled) {
        observations.push("rpc_unreachable");
        continue;
      }
      if (probe.value.kind === "observed") {
        observations.push(probe.value.observation); // wrong cluster - try next.
        continue;
      }
      const result = probe.value.result;
      const value = typeof result === "object" && result !== null ? (result as Record<string, unknown>).value : undefined;
      const entry = Array.isArray(value) ? value[0] : null;
      if (entry === null || entry === undefined || typeof entry !== "object") {
        observations.push("signature_status_unavailable"); // unknown on this node - try next.
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
      const observation: SolanaProbeOutcome = isEgressRefusal(err) ? "no_safe_rpc" : "rpc_unreachable";
      observations.push(observation);
      logger.debug("bridge.repair.solana_probe_miss", {
        chainId: input.expectedChainId,
        observation,
        error: summarizeProtocolError(err).message,
      });
      continue;
    }
  }
  if (budget.expired()) {
    const reduced = observations.length > 0 ? resolveSolanaProbeReason(observations) : null;
    return { verified: false, reason: reportLegDeadline(input, observations, reduced) };
  }
  return { verified: false, reason: resolveSolanaProbeReason(observations) };
}

/** What ONE Solana endpoint established, when it did not settle the question. */
export type SolanaProbeObservation = "chain_echo_mismatch" | "signature_status_unavailable" | "rpc_unreachable";

/** The Solana analog of {@link EvmProbeOutcome}: what an endpoint said, plus our own egress refusal. */
export type SolanaProbeOutcome = SolanaProbeObservation | "no_safe_rpc";

/**
 * Same rule as the EVM reducer: "a node answered and did not know this
 * signature" is a different fact from "no node answered at all", and reporting
 * both as `signature_status_unavailable` told the user we had looked when we had
 * not. Most-specific-wins, fixed order.
 */
export function resolveSolanaProbeReason(observations: readonly SolanaProbeOutcome[]): SolanaProbeOutcome {
  for (const candidate of [
    "signature_status_unavailable",
    "chain_echo_mismatch",
    "rpc_unreachable",
    "no_safe_rpc",
  ] as const) {
    if (observations.includes(candidate)) return candidate;
  }
  return "no_safe_rpc";
}

/**
 * EVERY endpoint this app already trusts for a destination chain, in one fixed
 * order, split by whether the URL is OURS (curated, used as configured) or a
 * provider's (SSRF-validated by `selectVerificationRpcUrls`).
 *
 * WHY EVERY SOURCE, NOT THE ROW'S OWN PROTOCOL. This used to consult exactly one
 * provider registry - Relay's for a Relay row, Khalani's for everything else -
 * on the reasoning that a bridge's own registry is the authority for its chains.
 * Measured consequence, owner's install, 2026-09-04: a Relay row expecting a
 * fill on Arbitrum One (42161) had ONE candidate URL for 31 days, Relay's
 * `arbitrum-one.publicnode.com`, which answers `eth_chainId` and then refuses a
 * month-old receipt as an archive request. The local registry does not know
 * 42161, so nothing else was ever tried and the row could not conclude through
 * 1227 attempts. WHOSE registry lists an endpoint says nothing about whether the
 * endpoint can answer for the chain: the chain id is the key, and the
 * `eth_chainId` echo below is what makes consulting a wider set safe. Khalani's
 * registry and viem's bundled definition both serve 42161 as
 * `https://arb1.arbitrum.io/rpc`, which returns the receipt (live-probed, same
 * date).
 *
 * ORDER (deduplicated downstream, first occurrence wins the slot):
 *   (a) the user's own overrides for this chain id (`@config/chain-rpc-overrides.js`);
 *   (b) the local chain registry (`@tools/evm-chains/registry.js`);
 *   (c) the Khalani chain registry, whatever this row's protocol is;
 *   (d) the Relay chain registry, whatever this row's protocol is;
 *   (e) viem's bundled canonical default for the chain - shipped data from a
 *       pinned dependency, no network call and no key, skipped when viem has
 *       never heard of the chain.
 *
 * (a) and (b) are the app's own configuration and are NOT SSRF-filtered (a user
 * pointing Vex at their own local archive node is a supported setup). (c), (d)
 * and (e) go through `isSsrfSafeRpcUrl`.
 *
 * SOLANA IS UNCHANGED: its destination lookup stays protocol-scoped, since the
 * defect and the widening above are about EVM chain registries.
 */
async function resolveVerificationRpcs(
  chainId: number,
  protocol: string,
  family: BridgeChainFamily,
): Promise<{ curated: string[]; providerRegistry: string[] }> {
  if (family !== "eip155") {
    return { curated: [], providerRegistry: await readProtocolRegistryRpcs(chainId, protocol) };
  }

  const curated: string[] = [];
  try {
    const { getUserRpcOverridesForChain } = await import("@config/chain-rpc-overrides.js");
    curated.push(...getUserRpcOverridesForChain(chainId));
  } catch (err) {
    logger.debug("bridge.repair.user_rpc_lookup_failed", { chainId, error: summarizeProtocolError(err).message });
  }
  try {
    const { getLocalChain, getLocalChainRpcUrl } = await import("@tools/evm-chains/registry.js");
    const local = getLocalChain(chainId);
    if (local) curated.push(getLocalChainRpcUrl(local));
  } catch (err) {
    logger.debug("bridge.repair.local_rpc_lookup_failed", { chainId, error: summarizeProtocolError(err).message });
  }

  const providerRegistry: string[] = [];
  const khalani = await readKhalaniRegistryRpc(chainId);
  if (khalani) providerRegistry.push(khalani);
  const relay = await readRelayRegistryRpc(chainId);
  if (relay) providerRegistry.push(relay);
  const bundled = await readViemBundledRpc(chainId);
  if (bundled) providerRegistry.push(bundled);

  return { curated, providerRegistry };
}

/** The non-EVM path's registry lookup: the owning protocol's registry only (unchanged behavior). */
async function readProtocolRegistryRpcs(chainId: number, protocol: string): Promise<string[]> {
  const url = protocol === "relay" ? await readRelayRegistryRpc(chainId) : await readKhalaniRegistryRpc(chainId);
  return url ? [url] : [];
}

/** Khalani `/v1/chains` (`rpcUrls.default.http[0]`), cached 24h by its own client. */
async function readKhalaniRegistryRpc(chainId: number): Promise<string | null> {
  try {
    const { getCachedKhalaniChains } = await import("@tools/khalani/chains.js");
    const chains = await getCachedKhalaniChains();
    return chains.find((c) => c.id === chainId)?.rpcUrls?.default?.http?.[0] ?? null;
  } catch (err) {
    logger.debug("bridge.repair.provider_rpc_lookup_failed", {
      chainId,
      registry: "khalani",
      error: summarizeProtocolError(err).message,
    });
    return null;
  }
}

/** Relay `/chains`, which exposes the RPC as `httpRpcUrl` (passthrough on RelayChain), cached 1h. */
async function readRelayRegistryRpc(chainId: number): Promise<string | null> {
  try {
    const { getCachedRelayChains } = await import("@tools/relay/client.js");
    const chains = await getCachedRelayChains();
    const match = chains.find((c) => c.id === chainId);
    return match ? readHttpRpcUrl(match) : null;
  } catch (err) {
    logger.debug("bridge.repair.provider_rpc_lookup_failed", {
      chainId,
      registry: "relay",
      error: summarizeProtocolError(err).message,
    });
    return null;
  }
}

/**
 * viem's own chain definition for this id, by scanning the bundled `viem/chains`
 * export map. Shipped data from a dependency we already pin: no network call, no
 * API key, no provider trust. `null` when viem has no definition for the chain,
 * which is the normal answer for an app-local chain like 4663.
 */
async function readViemBundledRpc(chainId: number): Promise<string | null> {
  try {
    // The namespace is walked as plain data: every export is checked for the
    // chain shape before a field is read, so no cast stands in for the check.
    const chains: Record<string, unknown> = await import("viem/chains");
    for (const value of Object.values(chains)) {
      if (!isBundledChainRecord(value) || value.id !== chainId) continue;
      const url = value.rpcUrls.default.http[0];
      if (typeof url === "string" && url.length > 0) return url;
    }
    return null;
  } catch (err) {
    logger.debug("bridge.repair.bundled_rpc_lookup_failed", { chainId, error: summarizeProtocolError(err).message });
    return null;
  }
}

/** The two fields the bundled lookup reads, established by inspection rather than assumed. */
function isBundledChainRecord(
  value: unknown,
): value is { readonly id: number; readonly rpcUrls: { readonly default: { readonly http: readonly unknown[] } } } {
  if (typeof value !== "object" || value === null) return false;
  const record: { id?: unknown; rpcUrls?: unknown } = value;
  if (typeof record.id !== "number") return false;
  if (typeof record.rpcUrls !== "object" || record.rpcUrls === null) return false;
  const rpc: { default?: unknown } = record.rpcUrls;
  if (typeof rpc.default !== "object" || rpc.default === null) return false;
  const dflt: { http?: unknown } = rpc.default;
  return Array.isArray(dflt.http);
}

/** Read the passthrough `httpRpcUrl` string from a Relay chain record (not in the typed schema). */
function readHttpRpcUrl(chain: object): string | null {
  const value = (chain as Record<string, unknown>).httpRpcUrl;
  return typeof value === "string" && value.length > 0 ? value : null;
}
