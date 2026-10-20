/**
 * `vexCloud.signIn`: one consent, then main signs one strict EIP-4361
 * message per in-app EVM wallet (at most three) and ends signed in, with
 * every consented wallet linked to one account.
 *
 * WHAT IS SIGNED, AND FOR WHOM. Every message binds the host the app dials
 * (`vexCloudSiweBinding`), never a host the server names: the server's
 * challenge must carry exactly that domain and URI, chain 4663, version 1 and
 * the fixed statement, or nothing is signed. The template signer
 * (`@tools/wallet/siwe-signing.ts`) checks the whole text again before any
 * key is loaded.
 *
 * THE FLOW, against the backend's rules (`VexVirtualsCompute/src/auth/service.ts`):
 *
 * | Step | Intent | Signers | Result |
 * |---|---|---|---|
 * | 1 | `signin` | the consented wallets still candidates | a session; or `wallet_not_linked` naming one wallet, which leaves the candidates and step 1 repeats |
 * | 2 (no wallet was linked) | `create` | all consented wallets = the link set | a new account and a session |
 * | 3 (some were linked) | `link:<account>` with the session | all consented wallets: the new ones plus the linked co-signers | the new wallets join the account |
 *
 * Each step takes a fresh single-use nonce. Signing costs no prompt: the app
 * holds the keys, the consent was the click. A session alone can never add a
 * wallet: the backend requires the co-signature, and this flow always sends
 * it.
 *
 * CANCELLATION. The caller's signal is checked before every step and passed
 * to every call; a session issued after a cancel is NOT stored. A link that
 * fails after the session was issued still ends signed in, and the account's
 * wallet list says which wallets are linked.
 *
 * AUDIT. One `asked` line before anything is signed and exactly one
 * `decided` line with the outcome kind, correlated (the deepseek-harness
 * approval pair, in the main log). Never an address, a nonce, a message or a
 * token.
 */

import type { Hex } from "viem";
import type { WalletInventoryEntry } from "@vex-lib/wallet.js";
import type { VexCloudSiweBinding } from "@vex-lib/vex-cloud-endpoint.js";
import {
  buildVexCloudSiweMessage,
  VEX_CLOUD_SIWE_CHAIN_ID,
  VEX_CLOUD_SIWE_STATEMENT,
  VEX_CLOUD_SIWE_VERSION,
  type VexCloudSiweIntent,
} from "@tools/wallet/siwe-signing.js";
import type { Result, VexError } from "@shared/ipc/result.js";
import { VEX_CLOUD_MAX_LOCAL_WALLETS } from "@shared/schemas/vex-cloud.js";
import { log } from "../logger/index.js";
import type { SignedSiweItem, VexCloudApi, VexCloudCallFailure, VexCloudChallenge } from "./api-client.js";
import {
  CANCELLED_DETAIL,
  INVALID_RESPONSE_DETAIL,
  refused,
  UNAVAILABLE_DETAIL,
  type VexCloudOutcome,
} from "./outcome.js";

/** How long a signed message stays valid, at most; the server's own bound may be shorter. */
const MESSAGE_VALIDITY_MS = 300_000;

export interface SignInDeps {
  readonly api: Pick<VexCloudApi, "issueNonce" | "verify">;
  /** In-app EVM wallets, inventory order. */
  readonly listEvmWallets: () => readonly WalletInventoryEntry[];
  readonly isVaultUnlocked: () => boolean;
  readonly signMessage: (entry: WalletInventoryEntry, message: string) => Promise<Hex>;
  readonly binding: () => VexCloudSiweBinding;
  readonly storeSession: (token: string) => Promise<Result<void>>;
  readonly now: () => Date;
}

export interface SignInSuccess {
  readonly accountId: string;
  readonly created: boolean;
  /** Wallets this sign-in linked to the account, lowercase. */
  readonly linkedNow: readonly string[];
  /** The bearer that was stored. Returned to the caller in main only, for the account read. */
  readonly token: string;
}

type Step<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly outcome: VexCloudOutcome<never> };

function lower(address: string): string {
  return address.toLowerCase();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(lower));
  const right = new Set(b.map(lower));
  return left.size === right.size && a.length === left.size && [...left].every((value) => right.has(value));
}

function transportRefusal(failure: VexCloudCallFailure): VexCloudOutcome<never> {
  switch (failure.kind) {
    case "cancelled":
      return refused("cancelled", CANCELLED_DETAIL);
    case "unavailable":
      return refused("unavailable", UNAVAILABLE_DETAIL);
    case "invalid_response":
      return refused("invalid_response", INVALID_RESPONSE_DETAIL);
    case "unauthorized":
    case "rejected":
      return rejectionRefusal(failure.reason);
  }
}

function rejectionRefusal(reason: string | null): VexCloudOutcome<never> {
  if (reason === "address_already_linked") {
    return refused(
      "wallet_linked_elsewhere",
      "One of your wallets is already linked to a different Vex Cloud account. Nothing was linked; Vex Cloud never merges accounts on its own.",
    );
  }
  if (reason === "signers_span_accounts") {
    return refused(
      "wallets_span_accounts",
      "Your wallets belong to different Vex Cloud accounts. Vex Cloud never merges accounts on its own, so nothing was changed.",
    );
  }
  return refused(
    "sign_in_rejected",
    `Vex Cloud refused the sign-in${reason === null ? "" : ` (${reason})`}. Nothing was stored; try again.`,
  );
}

/** The challenge must bind exactly what the app dials, or nothing is signed. */
function checkChallenge(challenge: VexCloudChallenge, binding: VexCloudSiweBinding): boolean {
  return (
    challenge.domain === binding.domain &&
    challenge.uri === binding.uri &&
    challenge.chain_id === VEX_CLOUD_SIWE_CHAIN_ID &&
    challenge.version === VEX_CLOUD_SIWE_VERSION &&
    challenge.statement === VEX_CLOUD_SIWE_STATEMENT
  );
}

const CHALLENGE_REFUSED_DETAIL =
  "Vex Cloud sent a sign-in challenge for a different host or in an unexpected form. Nothing was signed.";

/**
 * Fetch a challenge, sign it with every wallet in `signers`, and send the
 * batch. Signing errors are typed: a locked vault, a mismatched key, or a
 * template refusal each end the flow with nothing sent.
 */
async function signedRound(
  deps: SignInDeps,
  signers: readonly WalletInventoryEntry[],
  intent: VexCloudSiweIntent,
  linkSet: readonly string[],
  bearer: string | null,
  signal: AbortSignal,
): Promise<Step<Awaited<ReturnType<VexCloudApi["verify"]>>>> {
  if (signal.aborted) return { ok: false, outcome: refused("cancelled", CANCELLED_DETAIL) };
  const challenge = await deps.api.issueNonce(signal);
  if (!challenge.ok) return { ok: false, outcome: transportRefusal(challenge.failure) };
  const binding = deps.binding();
  if (!checkChallenge(challenge.value, binding)) {
    return { ok: false, outcome: refused("challenge_rejected", CHALLENGE_REFUSED_DETAIL) };
  }
  const issuedAt = deps.now();
  const validityMs = Math.min(MESSAGE_VALIDITY_MS, challenge.value.max_validity_seconds * 1000);
  const expirationTime = new Date(issuedAt.getTime() + validityMs);
  const items: SignedSiweItem[] = [];
  for (const entry of signers) {
    if (signal.aborted) return { ok: false, outcome: refused("cancelled", CANCELLED_DETAIL) };
    let message: string;
    try {
      message = buildVexCloudSiweMessage({
        domain: binding.domain,
        uri: binding.uri,
        address: entry.address,
        nonce: challenge.value.nonce,
        issuedAt,
        expirationTime,
        intent,
        linkSet,
      });
    } catch {
      return { ok: false, outcome: refused("challenge_rejected", CHALLENGE_REFUSED_DETAIL) };
    }
    let signature: Hex;
    try {
      signature = await deps.signMessage(entry, message);
    } catch (cause) {
      return { ok: false, outcome: signingRefusal(cause) };
    }
    items.push({ address: entry.address, message, signature });
  }
  if (signal.aborted) return { ok: false, outcome: refused("cancelled", CANCELLED_DETAIL) };
  return { ok: true, value: await deps.api.verify(items, bearer, signal) };
}

function signingRefusal(cause: unknown): VexCloudOutcome<never> {
  const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  if (code === "KEYSTORE_PASSWORD_NOT_SET") {
    return refused("vault", "Unlock Vex with your master password, then sign in to Vex Cloud.");
  }
  if (code === "SIGNER_MISMATCH") {
    return refused(
      "signer_mismatch",
      "A wallet key does not match its recorded address, so nothing was signed. Re-import that wallet or restore it from a backup.",
    );
  }
  return refused("challenge_rejected", CHALLENGE_REFUSED_DETAIL);
}

/**
 * Run the sign-in. `consented` is the wallet set the user saw; the inventory
 * must equal it. Returns the stored bearer for the caller's account read.
 */
export async function signInToVexCloud(
  deps: SignInDeps,
  consented: readonly string[],
  signal: AbortSignal,
  correlationId: string,
): Promise<VexCloudOutcome<SignInSuccess>> {
  const wallets = deps.listEvmWallets().slice(0, VEX_CLOUD_MAX_LOCAL_WALLETS);
  log.info(`[vex-cloud] signin.asked wallets=${wallets.length} correlationId=${correlationId}`);
  let outcome: VexCloudOutcome<SignInSuccess>;
  try {
    outcome = await runSignIn(deps, wallets, consented, signal);
  } catch (cause) {
    log.info(
      `[vex-cloud] signin.decided outcome=threw type=${cause instanceof Error ? cause.name : typeof cause} correlationId=${correlationId}`,
    );
    throw cause;
  }
  log.info(
    `[vex-cloud] signin.decided outcome=${outcome.ok ? (outcome.value.created ? "created" : "signed_in") : outcome.refusal.kind}`
      + `${outcome.ok ? ` linkedNow=${outcome.value.linkedNow.length}` : ""} correlationId=${correlationId}`,
  );
  return outcome;
}

async function runSignIn(
  deps: SignInDeps,
  wallets: readonly WalletInventoryEntry[],
  consented: readonly string[],
  signal: AbortSignal,
): Promise<VexCloudOutcome<SignInSuccess>> {
  if (!deps.isVaultUnlocked()) {
    return refused("vault", "Unlock Vex with your master password, then sign in to Vex Cloud.");
  }
  if (wallets.length === 0) {
    return refused("no_wallets", "Vex Cloud signs in with your in-app EVM wallets, and none exists yet. Add one in Wallets first.");
  }
  if (!sameSet(wallets.map((entry) => entry.address), consented)) {
    return refused(
      "wallet_set_changed",
      "Your wallets changed since this screen opened. Review the list and sign in again; nothing was signed.",
    );
  }

  // Step 1: sign in with the wallets that may already be linked.
  let candidates = [...wallets];
  let session: { accountId: string; token: string } | null = null;
  while (candidates.length > 0 && session === null) {
    const round = await signedRound(deps, candidates, { kind: "signin" }, [], null, signal);
    if (!round.ok) return round.outcome;
    const verified = round.value;
    if (verified.ok) {
      if (verified.value.kind !== "session") {
        return refused("invalid_response", INVALID_RESPONSE_DETAIL);
      }
      session = { accountId: verified.value.accountId, token: verified.value.token };
      break;
    }
    const failure = verified.failure;
    if (failure.kind === "unauthorized" && failure.reason === "wallet_not_linked" && failure.address !== null) {
      const unlinked = lower(failure.address);
      const next = candidates.filter((entry) => lower(entry.address) !== unlinked);
      // A reported address that is not one of ours is off contract.
      if (next.length === candidates.length) return refused("invalid_response", INVALID_RESPONSE_DETAIL);
      candidates = next;
      continue;
    }
    return transportRefusal(failure);
  }

  // Step 2: nothing was linked anywhere, so create the account with all of them.
  if (session === null) {
    const linkSet = wallets.map((entry) => entry.address);
    const round = await signedRound(deps, wallets, { kind: "create" }, linkSet, null, signal);
    if (!round.ok) return round.outcome;
    if (!round.value.ok) return transportRefusal(round.value.failure);
    if (round.value.value.kind !== "session") return refused("invalid_response", INVALID_RESPONSE_DETAIL);
    const created = round.value.value;
    if (signal.aborted) return refused("cancelled", CANCELLED_DETAIL);
    const stored = await deps.storeSession(created.token);
    if (!stored.ok) return refused("vault", stored.error.message, stored.error as VexError);
    return {
      ok: true,
      value: { accountId: created.accountId, created: true, linkedNow: linkSet.map(lower), token: created.token },
    };
  }

  if (signal.aborted) return refused("cancelled", CANCELLED_DETAIL);
  const stored = await deps.storeSession(session.token);
  if (!stored.ok) return refused("vault", stored.error.message, stored.error as VexError);

  // Step 3: link the wallets that are not linked yet, co-signed by the linked ones.
  const linkedSet = new Set(candidates.map((entry) => lower(entry.address)));
  const unlinked = wallets.filter((entry) => !linkedSet.has(lower(entry.address)));
  if (unlinked.length === 0) {
    return { ok: true, value: { accountId: session.accountId, created: false, linkedNow: [], token: session.token } };
  }
  const linkRound = await signedRound(
    deps,
    wallets,
    { kind: "link", accountId: session.accountId },
    unlinked.map((entry) => entry.address),
    session.token,
    signal,
  );
  let linkedNow: readonly string[] = [];
  if (linkRound.ok && linkRound.value.ok && linkRound.value.value.kind === "linked") {
    linkedNow = linkRound.value.value.linked;
  } else {
    // Signed in, not linked: the account read shows which wallets are linked.
    const kind = !linkRound.ok
      ? linkRound.outcome.ok
        ? "unknown"
        : linkRound.outcome.refusal.kind
      : linkRound.value.ok
        ? "off_contract"
        : linkRound.value.failure.kind;
    log.warn(`[vex-cloud] signin.link_failed kind=${kind} unlinked=${unlinked.length}`);
  }
  return { ok: true, value: { accountId: session.accountId, created: false, linkedNow, token: session.token } };
}
