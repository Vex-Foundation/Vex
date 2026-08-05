/**
 * Relay bridge execution PRIMITIVES — origin-only staged-broadcast building
 * blocks (Wave-3 W3b).
 *
 * The agent_activity staged discipline (planned row → sign → persist hash CAS →
 * broadcast → mark accepted, R4) lives in the HANDLER
 * (`vex-agent/tools/protocols/relay/handlers/bridge.ts`), because that is the
 * layer where the `agent_activity` repo lives — `src/tools/**` must NOT import
 * `src/vex-agent/**` (one-way layering). This tools-layer module therefore
 * exposes only the KEYLESS EVM primitives the handler composes with the shared
 * `signStageBroadcast` primitive:
 *   - `resolveRelayStepClients` — per-chain viem public + wallet clients;
 *   - `planRelayStepTx` — per-step, fail-closed tx extraction (ORIGIN-ONLY, B3)
 *     AND the native-value authorization gate (`./native-value.ts`): the last
 *     point before `signStageBroadcast`, so a `tx.value` Vex cannot attribute to
 *     a proven cost is refused rather than signed verbatim;
 *   - `pollRelayIntentStatus` — the bounded, INFORMATIONAL in-turn status poll;
 *   - `parseRequestIdFromCheckEndpoint` — the poll-source trust parser.
 *
 * ORIGIN-ONLY (B3): Vex signs ONLY origin-chain steps (approve + deposit). The
 * destination fill is solver-signed and externally observed — Vex NEVER
 * broadcasts a destination-chain step. The old two-chain `executeRelayBridge`
 * (which accepted `chainId ∈ {origin, destination}` and broadcast a monolithic
 * plan without any durable staging) is REMOVED: `planRelayStepTx` rejects any
 * item whose `chainId` is not the origin chain. The closed step policy
 * (`./step-policy`) is the first gate; this per-tx check is fail-closed
 * belt-and-suspenders before any signing.
 */

import {
  getAddress,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";

import { resolveInclusiveEvmChain, type InclusiveEvmChain } from "@tools/evm-chains/resolver.js";
import { getLocalEvmClients } from "@tools/evm-chains/evm-client.js";
import {
  createDynamicPublicClient,
  createDynamicWalletClient,
} from "@tools/khalani/evm-client.js";
import { checkNativeValueAuthorizedForCall } from "@tools/evm-chains/native-value-authorization/index.js";
import { VexError, ErrorCodes } from "../../errors.js";
import logger from "../../utils/logger.js";
import { getRelayClient, RELAY_INTENT_STATUS_PATH } from "./client.js";
import { resolveRelayOnlyStepClients } from "./chain-client.js";
import {
  classifyRelayStepNativeValue,
  relayNativeValueRefusal,
  relayStepNativeValueCall,
  type RelayStepNativeValueContext,
} from "./native-value.js";
import { RELAY_TERMINAL_STATUSES, type RelayChain, type RelayStep } from "./types.js";

/** Origin-chain viem clients for a signable Relay step. */
export interface RelayStepClients {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
}

/**
 * Resolve the viem public + wallet clients for a Relay step's chain. Robinhood
 * 4663 uses the local-registry client (honours the user RPC override +
 * Multicall3); a chain in the Khalani dynamic registry uses the Khalani client.
 * A RELAY-ONLY chain — present in Relay's `/chains` but in neither local nor
 * Khalani registries (R9 reveals Relay for exactly these) — builds a
 * credential-free, SSRF-validated client from the Relay registry entry
 * (`resolveRelayOnlyStepClients`, blocker 5) instead of deterministically failing
 * before signing. A non-EVM chain, or a Relay-only chain with no safe public RPC,
 * is rejected fail-closed. `relayChains` is the SAME live `/chains` list the
 * handler already fetched (passed in to avoid a redundant fetch + a version skew).
 */
export async function resolveRelayStepClients(
  chainId: number,
  privateKey: Hex,
  relayChains: readonly RelayChain[],
): Promise<RelayStepClients> {
  let resolved: InclusiveEvmChain;
  try {
    resolved = await resolveInclusiveEvmChain(String(chainId));
  } catch {
    // Absent from BOTH local and Khalani registries → Relay-only origin (R9).
    // Build from the Relay registry, fail-closed on a non-EVM / unsafe RPC.
    return resolveRelayOnlyStepClients(chainId, relayChains, privateKey);
  }
  if (resolved.family !== "eip155") {
    throw new VexError(ErrorCodes.RELAY_UNSUPPORTED_CHAIN, `Relay step chain ${chainId} is not an EVM chain.`);
  }
  if (resolved.source === "local") {
    return getLocalEvmClients(resolved.config, privateKey);
  }
  return {
    publicClient: createDynamicPublicClient(resolved.khalaniChain, resolved.khalaniChains),
    walletClient: createDynamicWalletClient(resolved.khalaniChain, resolved.khalaniChains, privateKey),
  };
}

/**
 * A single origin-chain transaction, pre-validated and canonicalized, ready for
 * the handler to hand to `signStageBroadcast`. `to`/`value` are already
 * `getAddress`/`BigInt`-canonical so a malformed field throws HERE (before any
 * signing/broadcast), never mid-bridge.
 */
export interface PlannedRelayStepTx {
  readonly to: `0x${string}`;
  readonly data: Hex;
  readonly value: bigint;
}

/**
 * Extract and canonicalize the SINGLE origin-chain transaction a signable step
 * carries, fail-closed (B3 / R4). The closed step policy (`./step-policy`) has
 * already classified the step's role and asserted every item is origin-chain +
 * `kind:"transaction"`; this is the per-tx canonicalization + belt-and-suspenders
 * ORIGIN-ONLY re-check run BEFORE the step is signed:
 *   - the step is `kind:"transaction"`;
 *   - EXACTLY one item carries `data` (a plain bridge's approve/deposit step is
 *     one tx — zero or many is an unexpected shape → reject rather than guess);
 *   - the tx `chainId` === originChainId (Vex never signs a destination step);
 *   - `data.from`, when present, equals the selected wallet;
 *   - `to`/`value` canonicalize — a malformed field throws here, pre-broadcast;
 *   - every wei of `tx.value` is attributed to a proven cost component
 *     (`./native-value.ts` + the shared classifier) — an unattributable native
 *     charge refuses HERE, which is the LAST point before the tx reaches
 *     `signStageBroadcast`. Nothing else stands between this function and a
 *     signature, so the gate is a property of the planner rather than a
 *     convention every caller has to remember (Khalani puts the same check
 *     inside its own signer, `signStageEvmLeg`).
 *
 * `nativeValue` is REQUIRED: what Vex derived about this step's outflow cannot
 * be inferred from the step, and a caller who omits it must not compile.
 */
export function planRelayStepTx(
  step: RelayStep,
  originChainId: number,
  expectedFrom: `0x${string}`,
  nativeValue: RelayStepNativeValueContext,
): PlannedRelayStepTx {
  if (step.kind !== "transaction") {
    throw new VexError(
      ErrorCodes.RELAY_UNSUPPORTED_STEP,
      `Relay step "${step.id}" (${step.kind}) is not signable — only transaction steps are signed.`,
    );
  }
  const dataItems = step.items.filter((item) => item.data);
  if (dataItems.length !== 1) {
    throw new VexError(
      ErrorCodes.RELAY_BRIDGE_FAILED,
      `Relay step "${step.id}" must carry exactly one origin transaction (found ${dataItems.length}).`,
    );
  }
  const data = dataItems[0]!.data!;
  if (data.chainId !== originChainId) {
    throw new VexError(
      ErrorCodes.RELAY_STEP_CHAIN_MISMATCH,
      `Relay step "${step.id}" targets chain ${data.chainId}, not the origin chain ${originChainId}. Vex signs only origin-chain steps; the fill is solver-signed on the destination.`,
    );
  }
  if (data.from && getAddress(data.from) !== expectedFrom) {
    throw new VexError(
      ErrorCodes.RELAY_BRIDGE_FAILED,
      `Relay step "${step.id}" sender does not match the selected wallet.`,
    );
  }
  let to: `0x${string}`;
  try {
    to = getAddress(data.to);
  } catch {
    throw new VexError(ErrorCodes.RELAY_BRIDGE_FAILED, `Relay step "${step.id}" has a malformed recipient address.`);
  }
  let value: bigint;
  try {
    value = BigInt(data.value);
  } catch {
    throw new VexError(ErrorCodes.RELAY_BRIDGE_FAILED, `Relay step "${step.id}" has a malformed transaction value.`);
  }

  // THE LAST GATE. Classify every wei the provider asked Vex to send, then
  // re-validate the authorization against the exact call about to be signed —
  // the fingerprint binds `(chain, to, calldata, value)`, so an authorization
  // can never be read as covering a different transaction. A zero-value step
  // (every ERC-20 approve and ERC-20 deposit) authorizes with no components and
  // costs nothing.
  const call = relayStepNativeValueCall(originChainId, { to, data: data.data as Hex, value });
  const authorized = checkNativeValueAuthorizedForCall(
    classifyRelayStepNativeValue(call, nativeValue),
    call,
  );
  if (!authorized.ok) {
    // The message stays short on purpose — `summarizeProtocolError` caps a
    // surfaced error at 200 characters, and the unattributed amount plus
    // "nothing was signed" must never be the parts that get truncated. The
    // handler composes `relayNativeValueGuidance` alongside it.
    throw new VexError(
      ErrorCodes.NATIVE_VALUE_UNAUTHORIZED,
      relayNativeValueRefusal(nativeValue.role, authorized.reason),
    );
  }

  return { to, data: data.data as Hex, value };
}

// ── Bounded, informational in-turn status poll ─────────────────────────────────
//
// Relay recommends ~1 poll/second, so the CADENCE stays at 1 s (vendor
// guidance). The BUDGET is 10 s, cut from 60 s: this poll is INFORMATIONAL ONLY
// — it never confirms or terminalizes the logical row (the background sweep owns
// the verified pending→confirmed and the reveal-clear), so a longer window buys
// a nicer last-seen status at the cost of blocking the whole turn. The live
// probe's Base→Robinhood `timeEstimate` is 2-3 s, and anything slower is
// recovered by the sweep, so nothing is lost that was not already owned
// elsewhere. When the budget expires the caller returns the pending result
// IMMEDIATELY and tells the agent not to re-poll in a loop.
const POLL_MAX_MS = 10_000;
const POLL_INTERVAL_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Result of the bounded in-turn poll. `observed` is true iff at least one status
 * call returned — it distinguishes a real last-seen status from a window where
 * EVERY request threw (status API unreachable). `destinationTxHashes` are the
 * provider-reported destination fill hashes on the last observed status —
 * UNTRUSTED, informational only (never a confirmation; W4 verifies).
 */
export interface RelayPollResult {
  readonly status: string;
  readonly observed: boolean;
  readonly destinationTxHashes: readonly string[];
  /**
   * WHY Relay reports this intent as failed / why its refund failed, from
   * Relay's documented closed vocabulary. Accepted ONLY in that vocabulary's
   * SCREAMING_SNAKE shape — this crosses into agent-facing output and
   * `src/tools/**` cannot reach the protocol runtime's scrubber (one-way
   * layering), so free provider text is dropped rather than forwarded unscrubbed.
   */
  readonly failReason: string | null;
  readonly refundFailReason: string | null;
  /**
   * The last status-call failure, when one happened. Bounded, non-sensitive
   * fields only, for the same layering reason as above: our own error code, the
   * provider's own closed code, and the HTTP status. Present so the handler can
   * say "the status API was unreachable" instead of silently reporting `null`
   * — the poll used to log a code and surface nothing at all.
   */
  readonly lastError: RelayPollError | null;
}

export interface RelayPollError {
  readonly code: string;
  readonly providerCode?: string;
  readonly httpStatus?: number;
}

/** Relay's closed vocabularies are SCREAMING_SNAKE; anything else is free text we do not forward. */
const RELAY_CLOSED_CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;

function closedCodeOrNull(raw: unknown): string | null {
  return typeof raw === "string" && RELAY_CLOSED_CODE_SHAPE.test(raw) ? raw : null;
}

function pollErrorFrom(err: unknown): RelayPollError {
  if (!(err instanceof VexError)) return { code: "unknown" };
  const providerCode = closedCodeOrNull(err.externalName);
  return {
    code: err.code,
    ...(providerCode !== null ? { providerCode } : {}),
    ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
  };
}

export async function pollRelayIntentStatus(requestId: string): Promise<RelayPollResult> {
  const client = getRelayClient();
  const started = Date.now();
  let status = "pending";
  let observed = false;
  let destinationTxHashes: readonly string[] = [];
  let failReason: string | null = null;
  let refundFailReason: string | null = null;
  let lastError: RelayPollError | null = null;
  while (Date.now() - started < POLL_MAX_MS) {
    await delay(POLL_INTERVAL_MS);
    try {
      const res = await client.getIntentStatus(requestId);
      status = res.status;
      observed = true;
      destinationTxHashes = res.txHashes ?? res.destinationTxHashes ?? [];
      failReason = closedCodeOrNull(res.failReason);
      refundFailReason = closedCodeOrNull(res.refundFailReason);
      if (RELAY_TERMINAL_STATUSES.has(status)) {
        return { status, observed, destinationTxHashes, failReason, refundFailReason, lastError };
      }
    } catch (err) {
      // The failure is RETAINED, not just logged: a window where every status
      // call threw is agent-relevant and used to be indistinguishable from
      // "polled fine, still pending".
      lastError = pollErrorFrom(err);
      logger.warn("relay.bridge.status_poll_failed", { reason: lastError.code });
    }
  }
  return { status, observed, destinationTxHashes, failReason, refundFailReason, lastError };
}

/**
 * Parse the `requestId` from a status `check.endpoint`, accepting it ONLY when
 * the endpoint is genuinely the Relay status endpoint: the pathname must equal
 * the documented status path EXACTLY (`RELAY_INTENT_STATUS_PATH`, shared with
 * the client so a version bump updates both) and — for absolute URLs — the host
 * must equal the configured Relay API host (`allowedBaseUrl`, the SAME value the
 * client polls; never a hardcoded second copy). A relative endpoint resolves
 * against that host so the exact-path check still applies. Anything else (wrong
 * host, wrong path, empty/absent id, malformed URL) → null.
 *
 * This is the poll-SOURCE TRUST parser (host + path pinned), distinct from the
 * correlation contract's looser consistency check (`./correlation`) which flags
 * a divergent id on ANY host. Retained + exported as the canonical trust parser.
 */
export function parseRequestIdFromCheckEndpoint(endpoint: string, allowedBaseUrl: string): string | null {
  let base: URL;
  try {
    base = new URL(allowedBaseUrl);
  } catch {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint, base);
  } catch {
    return null;
  }
  if (parsed.host !== base.host) return null;
  if (parsed.pathname !== RELAY_INTENT_STATUS_PATH) return null;
  const requestId = parsed.searchParams.get("requestId");
  return requestId && requestId.length > 0 ? requestId : null;
}
