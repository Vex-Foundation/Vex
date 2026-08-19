/**
 * `user_submit` — the launch the HUMAN deployed from the dialog, and the only
 * launch path the agent is not in.
 *
 * NOT A TOOL. There is no `ProtocolExecutionContext`, no tool call, no
 * transcript entry, because no model asked for this: the user filled the form,
 * read the consent modal, and clicked Deploy in the main process. Routing it
 * through `trench.launch_execute` would have required inventing an agent
 * dispatch for an action the agent never requested.
 *
 * ── Why this is a separate entry rather than a flag on the agent handler ────
 *
 * The two paths differ in the ONE place that matters — where the authorized
 * record lives:
 *
 *   AGENT PATH   authorize and execute happen in a single invocation. The
 *                authorized binding is in memory; storage is unnecessary and
 *                reading it back would only weaken the gate.
 *   USER SUBMIT  the human consented MINUTES EARLIER, in another process. There
 *                is nothing in memory to compare against. The persisted
 *                snapshot is the only record of what the human actually agreed
 *                to, so it is necessarily gate input here.
 *
 * A flag would have hidden that difference inside a branch. Two entries make it
 * legible: each one states which record authorizes it.
 *
 * ── The stored snapshot is UNTRUSTED INPUT ─────────────────────────────────
 *
 * Reading it back is a real, deliberate narrowing of the doctrine in
 * `./authorization.ts` — see the box there, which now scopes itself to the
 * agent paths and explains this exception rather than being quietly
 * contradicted. The compensating controls are exactly three:
 *
 *   1. the blob is a JSONB value written by another process, so EVERY field is
 *      validated before it is read (`parseStoredBinding`) — a malformed or
 *      partially-written record refuses instead of being destructured;
 *   2. it is never the source of what gets signed. The transaction is built by
 *      a FRESH re-derivation (fee re-read at a new anchored block, image bytes
 *      re-resolved and re-hashed, calldata re-encoded); the stored record only
 *      says what that re-derivation must MATCH;
 *   3. `consumeIfAuthorizedWith` remains the single-use gate, so a snapshot
 *      that was somehow tampered with still cannot be spent twice.
 *
 * What an attacker with write access to that row gains is the ability to make a
 * launch REFUSE (by making the re-derivation disagree) — not the ability to
 * make one happen on different terms, because the terms come from the
 * re-derivation and the money from the user's own signed transaction.
 */

import { getAddress, type Address } from "viem";

import { TRENCH_CHAIN_ID } from "@tools/trench-express/constants.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { acquireSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";
import {
  consumeIfAuthorizedWith,
  getById,
  type TokenLaunchIntent,
} from "@vex-agent/db/repos/token-launch-intents.js";
import { runTrenchFeeLeg } from "../../fee/index.js";
import type { ProtocolExecutionContext } from "../../../types.js";
import type { ToolResult } from "../../../../types.js";
import { fail } from "../../../handler-helpers.js";
import {
  checkLaunchAuthorizationUnchanged,
  type LaunchAuthorizationBinding,
} from "./authorization.js";
import { buildLaunchPlan } from "./plan.js";
import { planTrenchLaunchFeeLeg, type LaunchExecuteDeps } from "./fee-seam.js";
import { validateLaunchRequest } from "./validate.js";
import { settleLaunchFailure } from "./execute/authorize.js";
import { broadcastLaunch } from "./execute/broadcast.js";
import { openLaunchSigningClients } from "../../../shared/launch-signing-clients.js";

const ENTRY_ID = "trench.launch (user submit)";
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * The fee seam, WIRED — deliberately not the agent handler's `DEFAULT_DEPS`.
 *
 * That default plans no fee, which is the right default for a tool whose fee
 * module might not be wired yet, and exactly the wrong one here: a launch that
 * silently skips Vex's fee because a caller forgot an argument is revenue lost
 * with no record. The default on this entry is the real thing, so main imports
 * one symbol and cannot fall into the no-fee trap.
 */
export const USER_SUBMIT_LAUNCH_DEPS: LaunchExecuteDeps = {
  planFeeLeg: planTrenchLaunchFeeLeg,
  runFeeLeg: (input) =>
    runTrenchFeeLeg({
      plan: input.plan as Parameters<typeof runTrenchFeeLeg>[0]["plan"],
      feeRowId: input.feeRowId,
      chainId: TRENCH_CHAIN_ID,
      publicClient: input.publicClient as Parameters<typeof runTrenchFeeLeg>[0]["publicClient"],
      walletClient: input.walletClient as Parameters<typeof runTrenchFeeLeg>[0]["walletClient"],
      priorLeg: input.priorLeg as Parameters<typeof runTrenchFeeLeg>[0]["priorLeg"],
    }),
} satisfies LaunchExecuteDeps;

export interface UserSubmittedLaunchInput {
  readonly intentId: string;
  /**
   * Required, not derived from the intent: `getById` is session-scoped BY
   * CONTRACT, so another session's intent must MISS even when its id is known.
   * Reading the row first and then trusting its own `session_id` would answer
   * the ownership question with the very row whose ownership is in question.
   */
  readonly sessionId: string;
  readonly walletResolution: ProtocolExecutionContext["walletResolution"];
  readonly walletPolicy: ProtocolExecutionContext["walletPolicy"];
}

/**
 * Execute a launch the user authorized in the dialog.
 *
 * ORDER: load → eligibility → CAS-consume → re-derive → compare against the
 * STORED snapshot → broadcast. The consume comes BEFORE the expensive
 * re-derivation on purpose: it is what makes a second Deploy click refuse
 * instead of racing, and a losing racer should spend nothing proving it lost.
 */
export async function executeUserSubmittedLaunch(
  input: UserSubmittedLaunchInput,
  deps: LaunchExecuteDeps = USER_SUBMIT_LAUNCH_DEPS,
): Promise<ToolResult> {
  const intent = await getById(input.intentId, input.sessionId);
  if (intent === null) {
    return fail(
      `${ENTRY_ID}: no launch with id ${input.intentId} belongs to this session. Nothing was signed.`,
    );
  }

  const eligibility = checkEligibleForUserSubmit(intent);
  if (!eligibility.ok) return fail(eligibility.reason);

  // `authorizationJson` is typed `unknown` by the read model precisely because
  // the database guarantees nothing about a JSONB blob's shape — so it goes
  // straight to the validator, never destructured on the way.
  const stored = parseStoredBinding(intent.authorizationJson);
  if (!stored.ok) {
    return fail(
      `${ENTRY_ID}: the authorization recorded when you submitted this launch is incomplete `
        + `(${stored.reason}), so there is nothing to check this deployment against. Nothing was `
        + "signed — please fill the form again.",
    );
  }

  // THE RECORD MUST AGREE WITH ITS OWN ROW. The blob and the intent's ordinary
  // columns were written by the same submit; a disagreement between them means
  // tampering or a writer bug, and neither is a thing to sign through.
  const consistent = checkRecordAgreesWithRow(intent, stored.binding);
  if (!consistent.ok) {
    return fail(
      `${ENTRY_ID}: the stored authorization disagrees with the launch it belongs to `
        + `(${consistent.reason}). Nothing was signed.`,
    );
  }

  // THE EXACTLY-ONCE GATE, before anything expensive. A second Deploy click, a
  // double-submitted form, or a concurrent executor all lose here and refuse by
  // name rather than reaching a signature.
  const claimed = await withTransaction(async (client) => {
    await acquireSessionControlLock(client, input.sessionId);
    return consumeIfAuthorizedWith(client, input.intentId, input.sessionId);
  });
  if (claimed === null) {
    return fail(
      `${ENTRY_ID}: this launch was already deployed, or its form window lapsed before you `
        + "confirmed. Nothing was signed a second time.",
    );
  }

  const validated = validateLaunchRequest(requestParamsFrom(stored.binding));
  if (!validated.ok) {
    await settleLaunchFailure(input.intentId, input.sessionId, "StoredRequestInvalid");
    return fail(`${ENTRY_ID}: ${validated.reason}`);
  }

  const chainConfig = getLocalChain(TRENCH_CHAIN_ID);
  if (!chainConfig) {
    await settleLaunchFailure(input.intentId, input.sessionId, "ChainUnregistered");
    return fail(`Robinhood Chain (${TRENCH_CHAIN_ID}) is not in the local chain registry.`);
  }

  let walletAddress: Address;
  try {
    walletAddress = getAddress(stored.binding.walletAddress);
  } catch {
    await settleLaunchFailure(input.intentId, input.sessionId, "StoredWalletInvalid");
    return fail(`${ENTRY_ID}: the authorized wallet address is unreadable. Nothing was signed.`);
  }

  const clients = openLaunchSigningClients(
    { walletResolution: input.walletResolution, walletPolicy: input.walletPolicy } as ProtocolExecutionContext,
    chainConfig,
  );
  if (!clients.ok) {
    await settleLaunchFailure(input.intentId, input.sessionId, "WalletUnavailable");
    return clients.result;
  }

  // RE-DERIVE FROM FIRST PRINCIPLES. Fresh anchored block, fee re-read there,
  // image bytes re-resolved and re-hashed, calldata re-encoded. This — not the
  // stored blob — is what will actually be signed.
  const rederived = await buildLaunchPlan({
    request: validated.value,
    sessionId: input.sessionId,
    walletAddress,
    permission: stored.binding.permission,
    publicClient: clients.clients.publicClient,
    planFeeLeg: deps.planFeeLeg,
    nativeAddress: NATIVE_ADDRESS,
  });
  if (!rederived.ok) {
    await settleLaunchFailure(input.intentId, input.sessionId, `PlanRefused:${rederived.code}`);
    return fail(rederived.reason);
  }

  // THE LAST GATE: the fresh derivation must match what the human consented to.
  // A creation fee that moved, an image swapped in the locker, a permission
  // downgraded, or substituted calldata all refuse here — and the comparison is
  // against the SNAPSHOT, never against another plan built in this same call,
  // which would compare the new plan with itself and gate nothing.
  const unchanged = checkLaunchAuthorizationUnchanged(stored.binding, rederived.plan.binding);
  if (!unchanged.ok) {
    await settleLaunchFailure(input.intentId, input.sessionId, "AuthorizationDrift:user_submit");
    return fail(unchanged.reason);
  }

  return broadcastLaunch({
    intentId: input.intentId,
    sessionId: input.sessionId,
    walletAddress,
    plan: rederived.plan,
    request: validated.value,
    params: { intentId: input.intentId, origin: intent.origin },
    publicClient: clients.clients.publicClient,
    walletClient: clients.clients.walletClient,
    deps,
  });
}

/**
 * The persisted authorization record, read as `unknown`.
 *
 * Widened rather than typed: the value is a JSONB blob validated field-by-field
 * by {@link parseStoredBinding} before anything reads it, so a structural type
 * here would assert a guarantee the database does not make. The read model's
 * typed `authorizationJson` field lands with the intents repo's own exposure;
 * this reader is the single place that changes when it does.
 */
function storedAuthorizationOf(intent: TokenLaunchIntent): unknown {
  // Direct typed read — the read-model exposure landed with the writer support,
  // so the interim widening accessor collapsed to the field it promised.
  return intent.authorizationJson ?? null;
}

type Eligibility = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Cross-check the consent record against the intent row's own columns.
 *
 * Both were written by the same submit, so they cannot legitimately disagree.
 * When they do, the record is not describing the launch it is attached to —
 * evidence of tampering or of a writer bug — and either one is refusal-worthy
 * on a path where the record is the gate.
 *
 * Only fields the row actually carries are checked; the row has no first-class
 * columns for the money decomposition or the calldata, which is why the blob is
 * the comparison source at all.
 */
function checkRecordAgreesWithRow(
  intent: TokenLaunchIntent,
  binding: LaunchAuthorizationBinding,
): Eligibility {
  const mismatches: string[] = [];
  const disagrees = (field: string, row: string | null, stored: string): void => {
    if (row !== null && row !== stored) mismatches.push(`${field}: row ${row}, record ${stored}`);
  };

  disagrees("name", intent.name, binding.name);
  disagrees("symbol", intent.symbol, binding.symbol);
  disagrees("imageId", intent.imageId, binding.imageId);
  disagrees("prebuyWei", intent.prebuyRaw, binding.prebuyWei);
  disagrees("sessionId", intent.sessionId, binding.sessionId);
  if (intent.walletAddress.toLowerCase() !== binding.walletAddress.toLowerCase()) {
    mismatches.push(`walletAddress: row ${intent.walletAddress}, record ${binding.walletAddress}`);
  }
  if (intent.chainId !== binding.chainId) {
    mismatches.push(`chainId: row ${intent.chainId}, record ${binding.chainId}`);
  }

  return mismatches.length === 0
    ? { ok: true }
    : { ok: false, reason: mismatches.join("; ") };
}

/**
 * Which intents this entry may execute.
 *
 * `user_submit` is the ONLY kind this entry executes. It covers both origins
 * that put a human in front of the form — `user` (they opened the dialog) and
 * `agent_requested_form` (the agent asked, the human filled it and clicked
 * Deploy) — because the authorizing act is identical in both: a person read the
 * consent modal and confirmed.
 *
 * `full_autonomy` and `approval_card` are deliberately excluded: those belong to
 * the agent handler, and executing one here would run a mission-gated launch
 * without the mission gates.
 */
function checkEligibleForUserSubmit(intent: TokenLaunchIntent): Eligibility {
  if (intent.status !== "authorized") {
    return {
      ok: false,
      reason:
        `${ENTRY_ID}: this launch is ${intent.status}, not awaiting deployment — `
        + "it was already deployed, cancelled, or it expired. Nothing was signed.",
    };
  }
  if (intent.authorizationKind !== "user_submit") {
    return {
      ok: false,
      reason:
        `${ENTRY_ID}: this launch was authorized as `
        + `${intent.authorizationKind ?? "nothing"}, which only the agent path may execute. `
        + "Nothing was signed.",
    };
  }
  return { ok: true };
}

type StoredBindingResult =
  | { readonly ok: true; readonly binding: LaunchAuthorizationBinding }
  | { readonly ok: false; readonly reason: string };

const REQUIRED_STRING_FIELDS = [
  "name", "symbol", "description", "imageId", "imageDigest",
  "creationFeeWei", "prebuyWei", "msgValueWei", "vexFeeWei", "anchorBlockNumber",
  "calldata", "callFingerprint", "sessionId", "walletAddress", "permission",
] as const;

/**
 * Validate the persisted authorization record before ANY field is read.
 *
 * It is a JSONB blob written by a different process, so it is untrusted input
 * in exactly the sense rule 03 means: validated at the boundary, then passed
 * inward as a trusted typed value. A missing or wrong-typed field REFUSES —
 * silently defaulting one would let a half-written record authorize a launch
 * whose terms nobody ever agreed to.
 */
export function parseStoredBinding(value: unknown): StoredBindingResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "no authorization record was stored" };
  }
  const record = value as Record<string, unknown>;

  const missing = REQUIRED_STRING_FIELDS.filter((field) => typeof record[field] !== "string");
  if (missing.length > 0) {
    return { ok: false, reason: `missing or malformed: ${missing.join(", ")}` };
  }
  if (typeof record.chainId !== "number") {
    return { ok: false, reason: "missing or malformed: chainId" };
  }
  if (typeof record.contract !== "string") {
    return { ok: false, reason: "missing or malformed: contract" };
  }
  if (!Array.isArray(record.links) || record.links.some((link) => typeof link !== "string")) {
    return { ok: false, reason: "missing or malformed: links" };
  }
  // The chain is the venue's fixed identity, not a stored preference: a record
  // naming another chain is not a launch this entry may execute.
  if (record.chainId !== TRENCH_CHAIN_ID) {
    return { ok: false, reason: `it names chain ${String(record.chainId)}, not Robinhood Chain` };
  }

  // Explicit construction from the fields verified above — each `as` below is
  // backed by a typeof/shape check earlier in this function, so no unchecked
  // shape assertion survives (no-any policy: `as unknown as` is banned here).
  return {
    ok: true,
    binding: {
      name: record.name as string,
      symbol: record.symbol as string,
      description: record.description as string,
      links: [...(record.links as string[])],
      imageId: record.imageId as string,
      imageDigest: record.imageDigest as string,
      chainId: record.chainId as number,
      contract: record.contract as LaunchAuthorizationBinding["contract"],
      creationFeeWei: record.creationFeeWei as string,
      prebuyWei: record.prebuyWei as string,
      msgValueWei: record.msgValueWei as string,
      vexFeeWei: record.vexFeeWei as string,
      anchorBlockNumber: record.anchorBlockNumber as string,
      calldata: record.calldata as LaunchAuthorizationBinding["calldata"],
      callFingerprint: record.callFingerprint as LaunchAuthorizationBinding["callFingerprint"],
      sessionId: record.sessionId as string,
      walletAddress: record.walletAddress as LaunchAuthorizationBinding["walletAddress"],
      permission: record.permission as LaunchAuthorizationBinding["permission"],
    },
  };
}

/**
 * The launch request, rebuilt from the intent row and the validated snapshot,
 * then passed through the SAME boundary validator the agent path uses — so the
 * two paths cannot disagree about what a legal launch request is.
 */
function requestParamsFrom(binding: LaunchAuthorizationBinding): Record<string, unknown> {
  return {
    name: binding.name,
    symbol: binding.symbol,
    description: binding.description,
    // The boundary validator's contract is "omit the parameter or supply
    // values" — an empty array is refused BY NAME there (it cannot mean both
    // 'none' and 'no filter'). The binding stores `[]` to mean none, so a
    // link-less consent must rebuild as ABSENCE, not as an empty list —
    // otherwise every launch without links refuses (proven by the funded
    // UI-path probe, 2026-08-02).
    ...(binding.links.length > 0 ? { links: [...binding.links] } : {}),
    imageId: binding.imageId,
    // The validator's parameter is `prebuy`, a decimal ETH string — the same
    // one a user or the agent supplies. Naming it anything else here would let
    // the re-derivation silently plan a ZERO prebuy and refuse as "drift",
    // blaming the user's consent for a bug in this adapter.
    prebuy: formatPrebuyEth(binding.prebuyWei),
  };
}

/** Wei → the decimal ETH string the boundary validator accepts. Exact, never rounded. */
function formatPrebuyEth(prebuyWei: string): string {
  const wei = BigInt(prebuyWei);
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}
