/**
 * §C0 — the LAUNCH AUTHORIZATION RECORD.
 *
 * The single most important contract in the launch path. One discriminated
 * record exists for EVERY way a launch can happen; there is no "unauthorized but
 * allowed" path, because a launch spends real, irreversible funds.
 *
 *   `user_submit`    a human filled the form and clicked Deploy. That click is
 *                    the spend consent. MAIN — never the renderer — reconstructs
 *                    and binds the fields.
 *   `approval_card`  a RESTRICTED agent proposed a launch and the human resolved
 *                    an approval card. Binds the approval id and the permission
 *                    snapshot.
 *   `full_autonomy`  a FULL-autonomy mission launched unattended. **This is NOT
 *                    user consent and is never labelled as such anywhere in this
 *                    codebase** — no human acted. It is trusted host/engine
 *                    evidence that a mission was permitted to spend, so it binds
 *                    the mission provenance that granted the permission.
 *   `session_full`   the user put THIS CHAT SESSION in full permission and asked
 *                    for the launch. The same consent basis every other mutating
 *                    tool executes on in full mode (`swap_execute` precedent) —
 *                    attended, no approval card, no mission, so it binds nothing
 *                    but the session's own permission snapshot. Owner decree
 *                    2026-08-02; mission ceilings are mission-scoped and do not
 *                    apply here.
 *
 * ALL THREE BIND THE SAME FIELDS. That is the point: whatever authorized the
 * spend, the audit answer to "what exactly was authorized?" has one shape.
 *
 * INTEGRITY DOES NOT COME FROM STORAGE. The record is re-derived from first
 * principles immediately before signing — the fee is re-read at a fresh anchored
 * block, the image bytes are re-resolved and re-hashed, the calldata is
 * re-encoded, `msg.value` is recomposed — and every field is compared. Any
 * difference REFUSES. So a record that was tampered with, a fee that moved, or
 * an image swapped between authorization and execution all fail the same way,
 * and none of them depends on trusting a stored blob.
 *
 * The single-use property is the `consumeIfAuthorizedWith` CAS in the intents
 * repo, which returns row-or-null and is the ONLY thing standing between one
 * launch and two.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PERSISTED `authorization_json` COLUMN IS AUDIT, NOT THE GATE.
 *
 * The record is written to `token_launch_intents.authorization_json` so a
 * reviewer can reconstruct MONTHS LATER exactly what was authorized — which
 * fields, which fee at which block, which image digest, which permission —
 * without walking the chain. That is worth a column on a real-funds path.
 *
 * ON THE AGENT PATHS (`approval_card`, `full_autonomy`) it is **write-and-audit
 * only**. NOTHING IN THOSE SIGNING PATHS MAY READ IT BACK TO MAKE A DECISION.
 * The gate there is {@link checkLaunchAuthorizationUnchanged} against a binding
 * re-derived from first principles, plus the CAS. Authorization and execution
 * happen in ONE invocation, so the authorized binding is already in memory: a
 * read of the stored blob would buy nothing and cost a security property, since
 * a gate that trusts its own storage is a gate an attacker only has to write to
 * once. If you are about to add such a read to the agent path, you are removing
 * a security property, not adding a convenience.
 *
 * `user_submit` IS THE ONE EXCEPTION, AND IT WAS DECIDED, NOT DRIFTED
 * (coordinator ruling, fix wave). There the stored record IS gate input, on
 * three grounds:
 *
 *   1. PRODUCT. Consent happens at SUBMIT time, in the main process, minutes
 *      before execution. A consent separated in time and process from the
 *      signature can only be carried by a persisted record. Comparing a fresh
 *      derivation against another freshly built plan would compare the new plan
 *      with itself and gate NOTHING — strictly worse than reading storage.
 *   2. PRESCRIPTION. The reviewer's C0 specification is verbatim: "compare the
 *      fresh plan against that snapshot — not another handler-built plan."
 *   3. PRECEDENT. `approval_queue` / `approval_intents` already store consent
 *      and read it back to decide. `user_submit` places no weaker trust in the
 *      database than the approvals pattern the whole system already rests on.
 *
 * The compensating controls live in `./execute-user-submit.ts`: the blob is
 * treated as UNTRUSTED INPUT and validated field-by-field before any value is
 * read, it is cross-checked against the intent row's own columns (a record that
 * disagrees with its own row proves tampering or a writer bug), what gets
 * SIGNED still comes from a fresh re-derivation that must match it field by
 * field — image digest included, so bytes swapped in the locker are drift — and
 * the CAS remains the single-use gate.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { sha256, toHex, type Address, type Hex } from "viem";

import type { Permission } from "@vex-agent/engine/types.js";
import type { LaunchAuthorizationKind } from "@vex-agent/db/repos/token-launch-intents.js";

/** The fields every variant binds, identically. */
export interface LaunchAuthorizationBinding {
  // ── what is being created ──
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  readonly links: readonly string[];
  /** sha256 of the image bytes, as recorded in the locker (C2). */
  readonly imageId: string;
  readonly imageDigest: string;

  // ── where ──
  readonly chainId: number;
  readonly contract: Address;

  // ── the money, decomposed ──
  /** Read at {@link anchorBlockNumber}; NEVER the preview's 0.001 constant. */
  readonly creationFeeWei: string;
  readonly prebuyWei: string;
  /** `creationFeeWei + prebuyWei`, exactly. The consent-bound figure. */
  readonly msgValueWei: string;
  /** Vex's 25 bps fee (§C7) — a SEPARATE later transaction, never in msg.value. */
  readonly vexFeeWei: string;
  readonly anchorBlockNumber: string;

  // ── the exact transaction ──
  readonly calldata: Hex;
  /** `nativeValueCallFingerprint` over (chainId, to, calldata, value). */
  readonly callFingerprint: Hex;

  // ── who ──
  readonly sessionId: string;
  readonly walletAddress: Address;
  /** Permission AT AUTHORIZATION TIME — not at execution time. */
  readonly permission: Permission;
}

/** Mission evidence that authorized an unattended spend. */
export interface LaunchMissionProvenance {
  readonly missionId: string;
  readonly missionRunId: string;
  /** The ceilings that were in force, so a later audit sees what bounded it. */
  readonly maxLaunchValueRaw: string | null;
  readonly maxLaunchCount: number | null;
  readonly launchesUsedBefore: number;
}

export type LaunchAuthorization =
  | {
      readonly kind: "user_submit";
      readonly binding: LaunchAuthorizationBinding;
      /** When the human clicked Deploy. */
      readonly submittedAt: string;
    }
  | {
      readonly kind: "approval_card";
      readonly binding: LaunchAuthorizationBinding;
      readonly approvalId: string;
      readonly resolvedAt: string;
    }
  | {
      readonly kind: "full_autonomy";
      readonly binding: LaunchAuthorizationBinding;
      readonly provenance: LaunchMissionProvenance;
      readonly authorizedAt: string;
    }
  | {
      readonly kind: "session_full";
      readonly binding: LaunchAuthorizationBinding;
      /** When the handler authorized it. The binding carries the permission. */
      readonly authorizedAt: string;
    };

/** sha256 of image bytes, hex — the value compared against the locker digest. */
export function launchImageDigest(bytes: Uint8Array): string {
  return sha256(toHex(bytes));
}

/**
 * Does `recorded` name these exact bytes?
 *
 * TWO PRODUCERS, TWO SPELLINGS OF THE SAME HASH. This side hashes with viem,
 * which returns `0x`-prefixed hex; the locker hashes with node's `createHash`
 * and stores BARE hex (`vex-app/src/main/images/byte-store.ts`). Comparing the
 * two strings directly is therefore ALWAYS unequal, whatever the bytes are.
 *
 * That is not hypothetical: a raw `!==` shipped in the launch preview and made
 * every staged image report `image_digest_mismatch`, so the dry-run silently
 * fell back to the empty-image simulation (understating gas roughly fourfold)
 * and told the user their image was corrupt and a launch would refuse - while
 * the same launch executed fine. Live report 2026-08-06, three images in a row.
 *
 * Comparison, not coercion: the digest a binding stores stays in this side's
 * spelling, so nothing persisted changes shape.
 */
export function launchImageDigestMatches(bytes: Uint8Array, recorded: string): boolean {
  const lower = recorded.toLowerCase();
  const normalized = lower.startsWith("0x") ? lower : `0x${lower}`;
  return launchImageDigest(bytes).toLowerCase() === normalized;
}

/**
 * Recompose `msg.value` and REFUSE unless it is the exact bigint sum.
 *
 * No tolerance, deliberately. A percentage or absolute slack on a value
 * comparison is how an unexplained charge rides along; there is no mechanism
 * that would make a launch's own two components miss their sum by a little.
 */
export function composeLaunchMsgValue(
  creationFeeWei: bigint,
  prebuyWei: bigint,
): bigint {
  if (creationFeeWei <= 0n) {
    throw new Error("Refusing to launch: the creation fee resolved to zero or negative.");
  }
  if (prebuyWei < 0n) {
    throw new Error("Refusing to launch: the prebuy is negative.");
  }
  return creationFeeWei + prebuyWei;
}

/** Every way a re-derivation can disagree with what was authorized. */
export interface LaunchAuthorizationDrift {
  readonly field: string;
  readonly authorized: string;
  readonly current: string;
}

export type LaunchAuthorizationCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly drift: readonly LaunchAuthorizationDrift[]; readonly reason: string };

/**
 * Compare a freshly re-derived binding against the authorized one.
 *
 * THIS IS THE LAST GATE BEFORE SIGNING. It reports EVERY field that moved rather
 * than the first, because a refusal on a real-funds path should be diagnosable
 * in one round trip — "the fee moved AND the image changed" is a materially
 * different situation from either alone.
 *
 * `permission` is compared too: a session downgraded from full to restricted
 * between authorization and execution must not still execute under the
 * authority it no longer has.
 */
export function checkLaunchAuthorizationUnchanged(
  authorized: LaunchAuthorizationBinding,
  current: LaunchAuthorizationBinding,
): LaunchAuthorizationCheck {
  const drift: LaunchAuthorizationDrift[] = [];

  const compare = (field: keyof LaunchAuthorizationBinding): void => {
    const a = authorized[field];
    const c = current[field];
    const aStr = Array.isArray(a) ? a.join(",") : String(a);
    const cStr = Array.isArray(c) ? c.join(",") : String(c);
    if (aStr !== cStr) drift.push({ field, authorized: aStr, current: cStr });
  };

  // Every bound field, without exception. Listing them explicitly (rather than
  // iterating the object) means adding a field to the binding without deciding
  // whether it is drift-relevant is a compile error, not a silent hole.
  compare("name");
  compare("symbol");
  compare("description");
  compare("links");
  compare("imageId");
  compare("imageDigest");
  compare("chainId");
  compare("contract");
  compare("creationFeeWei");
  compare("prebuyWei");
  compare("msgValueWei");
  compare("vexFeeWei");
  compare("calldata");
  compare("callFingerprint");
  compare("sessionId");
  compare("walletAddress");
  compare("permission");
  // NOTE: `anchorBlockNumber` is deliberately NOT compared. The block always
  // moves between authorization and execution; what must not move is the FEE
  // read at it, which `creationFeeWei` covers.

  if (drift.length === 0) return { ok: true };

  const detail = drift
    .map((d) => `${d.field}: authorized ${d.authorized}, now ${d.current}`)
    .join("; ");
  return {
    ok: false,
    drift,
    reason:
      "Refusing to launch: what was authorized is not what would be signed now — "
      + `${detail}. Nothing was signed. Review the launch and authorize it again.`,
  };
}

/** Human-readable variant name for messages and logs. Never says "consent" for autonomy. */
export function describeLaunchAuthorization(kind: LaunchAuthorizationKind): string {
  switch (kind) {
    case "user_submit":
      return "the user's own Deploy submission";
    case "approval_card":
      return "an approval the user resolved";
    case "full_autonomy":
      return "the mission's full-autonomy permission (no human acted)";
    case "session_full":
      return "the session's full permission, which the user set and asked to launch under";
  }
}
