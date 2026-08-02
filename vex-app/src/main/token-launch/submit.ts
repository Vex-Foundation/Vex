/**
 * The Deploy click, main-side — everything up to (and not including) the
 * signature.
 *
 * THE DIVISION OF LABOUR. This module re-derives the money, proves the user is
 * consenting to figures that still hold, and writes ONE authorized intent row.
 * It does not sign, broadcast, or decide anything about a receipt. Signing is
 * reached through exactly one named seam — `SubmittedLaunchExecutor` — because a
 * spend leg with two entry points is a spend leg with two places to get the
 * exactly-once gate wrong.
 *
 * WHY THE ROW IS WRITTEN BEFORE THE EXECUTOR RUNS. `authorized` is the state the
 * executor CAS-consumes (`consumeIfAuthorizedWith`), and that CAS is the only
 * thing standing between a double click and a double spend. Writing the row
 * afterwards would leave the claim with nothing to claim.
 *
 * WHAT THE STALENESS CHECK CAN AND CANNOT SEE, stated plainly because the gap is
 * load-bearing: `previewId` binds the anchored block AND the creation fee read
 * there, so a moved fee or a moved anchor is caught here. Everything else in the
 * binding is derived from the SAME form object this submit carries, so it cannot
 * drift between the two derivations. The one thing that CAN drift and is not
 * caught is the image DIGEST behind an unchanged `imageId` — catching that needs
 * the previewed binding to have been persisted, which is what the
 * `authorizationJson` consent snapshot is for. Until that snapshot is read back
 * as a gate input, this is a previewId CAS and is described as nothing more.
 */

import { randomUUID } from "node:crypto";
import type { LaunchPlan } from "@vex-agent/tools/protocols/trench/handlers/launch/plan.js";
import type { CreateTokenLaunchIntentInput } from "@vex-agent/db/repos/token-launch-intents.js";
import type { TokenLaunchForm, TokenLaunchSubmitResult } from "@shared/schemas/token-launch.js";
import { log } from "../logger/index.js";
import { wakeParkedAgent as wake } from "./execute-seam.js";
import {
  buildLaunchPlan,
  planLaunchContext,
  refusalFromPlanCode,
  type TokenLaunchRefusal,
} from "./plan-context.js";

/**
 * How long an authorized-but-unconsumed intent stays claimable.
 *
 * Short on purpose: the row is created and consumed inside one user action, so
 * this window exists only to bound a crash between the two. A long window would
 * leave a signable authorization lying around after the user walked away.
 */
const AUTHORIZED_WINDOW_MS = 5 * 60_000;

/**
 * THE SEAM. The signing leg, injected.
 *
 * Its shape is Hokusai's `executeUserSubmittedLaunch` narrowed to what this
 * module can honestly supply: an intent id and its session. The wallet
 * resolution and policy that the real executor also needs are assembled by the
 * WIRING layer, not here — this module deliberately never holds anything that
 * can decrypt a key, so that "main-side submit" cannot quietly become a second
 * place where signing authority lives.
 */
export type SubmittedLaunchExecutor = (input: {
  readonly intentId: string;
  readonly sessionId: string;
}) => Promise<SubmittedLaunchOutcome>;

/**
 * What the executor reports back.
 *
 * The two arms are NOT cosmetic. `broadcast` means a transaction reached the
 * network and the user's gas is at stake; `refused` means nothing was signed at
 * all. Collapsing a refusal into `status: "reverted"` would tell someone their
 * launch failed on-chain when it never left the process — the difference
 * decides whether they should worry about funds.
 */
export type SubmittedLaunchOutcome =
  | {
      readonly kind: "broadcast";
      readonly status: TokenLaunchSubmitResult["status"];
      readonly txHash: string | null;
      readonly tokenAddress: string | null;
      readonly message: string;
    }
  | { readonly kind: "refused"; readonly message: string };

export type TokenLaunchSubmitOutcome =
  | { readonly ok: true; readonly result: TokenLaunchSubmitResult }
  | { readonly ok: false; readonly refusal: TokenLaunchRefusal };

/**
 * The C0 consent snapshot, persisted as `authorization_json`.
 *
 * AUDIT RECORD FIRST (migration 063): nothing on today's signing path reads it
 * to decide whether to sign — the gate is re-derivation plus the single-use CAS
 * on `authorization_id`. It exists so a reviewer can reconstruct months later
 * exactly what the user was shown and agreed to, in the same row as the outcome.
 *
 * It records the PREVIEWED figures, not a recomputation of them, because the
 * question it answers is "what did the human consent to", and a value re-derived
 * at audit time cannot answer that.
 */
function buildConsentSnapshot(
  plan: LaunchPlan,
  form: TokenLaunchForm,
  previewId: string,
): Record<string, unknown> {
  return {
    // THE BINDING IS SPREAD AT THE TOP LEVEL, not nested. `parseStoredBinding`
    // validates this object field-by-field AS a LaunchAuthorizationBinding and
    // refuses anything incomplete, so a nested copy would read as "no
    // authorization record was stored" and every launch would refuse. The audit
    // extras below sit alongside it; the validator ignores unknown keys.
    ...plan.binding,
    links: [...plan.binding.links],
    version: 1,
    kind: "user_submit",
    previewId,
    consentedAt: new Date().toISOString(),
    consentedForm: {
      name: form.name,
      symbol: form.symbol,
      // JSONB rejects `undefined` outright — a launch with no links (the
      // common case) must serialize as null, not explode at the write.
      description: form.description ?? null,
      links: form.links ?? null,
      imageId: form.imageId,
      prebuy: form.prebuy,
    },
    shown: {
      msgValueWei: plan.preview.msgValueWei,
      creationFeeWei: plan.preview.creationFeeWei,
      prebuyWei: plan.preview.prebuyWei,
      vexFeeWei: plan.preview.vexFeeWei,
      vexFeeCharged: plan.preview.vexFeeCharged,
      estimatedNetworkFeeWei: plan.preview.estimatedNetworkFeeWei,
      anchorBlockNumber: plan.preview.anchorBlockNumber,
      imageDigest: plan.binding.imageDigest,
    },
  };
}

/**
 * `CreateTokenLaunchIntentInput` plus the audit blob.
 *
 * Declared as a type rather than passed as an object literal on purpose: the
 * repo writer's `authorizationJson` parameter is landing in its own lane, and
 * this shape means the snapshot is CARRIED from the day this code ships and
 * starts being PERSISTED the moment that parameter exists — with no edit here
 * and no window in which submit silently drops the consent record.
 */
type CreateIntentWithConsent = CreateTokenLaunchIntentInput & {
  readonly authorizationJson?: unknown;
};

/**
 * The outcome of getting an intent to `authorized`, whichever path got it there.
 *
 * It CARRIES THE ID rather than letting the caller keep its own copy: the two
 * paths mint it differently (one generates, one was given it by the agent), and
 * a caller that re-derived it would be free to execute against a different row
 * from the one it just authorized.
 */
type PersistedAuthorization =
  | { readonly ok: true; readonly intentId: string }
  | { readonly ok: false; readonly refusal: TokenLaunchRefusal };

export async function submitLaunch(
  input: {
    readonly sessionId: string;
    readonly intentId: string | null;
    readonly previewId: string;
    readonly form: TokenLaunchForm;
  },
  executeLaunch: SubmittedLaunchExecutor,
): Promise<TokenLaunchSubmitOutcome> {
  const context = await planLaunchContext(input.sessionId, input.form);
  if (!context.ok) return { ok: false, refusal: context.refusal };

  const planned = await buildLaunchPlan({
    request: context.request,
    sessionId: input.sessionId,
    walletAddress: context.walletAddress as `0x${string}`,
    permission: context.permission,
    publicClient: context.publicClient,
    planFeeLeg: context.planFeeLeg,
    nativeAddress: context.nativeAddress,
  });
  if (!planned.ok) {
    return { ok: false, refusal: refusalFromPlanCode(planned.code, planned.reason) };
  }

  // THE PREVIEW CAS — VALUE-anchored, not block-anchored. `previewId` is
  // `lp_<anchorBlock>_<msgValueWei>`, and the anchor block advances roughly
  // every second on Robinhood Chain, so literal id equality refused every
  // honest Deploy (proven by the funded UI-path probe, 2026-08-02: two reads
  // five blocks apart with an IDENTICAL creation fee were called "changed").
  // The user consents to the FIGURE they were shown — msgValue = creation fee
  // + prebuy, exactly — so that is what must still hold; the block is
  // provenance. The prebuy comes from the same form on both derivations, so a
  // moved msgValue can only mean a moved creation fee. The full field-by-field
  // gate (fee, image digest, calldata fingerprint) runs AGAIN in the executor
  // against the persisted consent snapshot; this check exists to catch the
  // moved fee before an intent row is ever written.
  const previewIdShape = /^lp_\d+_(\d+)$/.exec(input.previewId);
  const shownMsgValueWei = previewIdShape?.[1] ?? null;
  if (shownMsgValueWei === null || shownMsgValueWei !== planned.plan.preview.msgValueWei) {
    return {
      ok: false,
      refusal: {
        kind: "preview_stale",
        detail:
          `The launch cost changed since you were shown it: the total to send now reads `
          + `${planned.plan.preview.msgValueWei} wei (creation fee `
          + `${planned.plan.preview.creationFeeWei} at block `
          + `${planned.plan.preview.anchorBlockNumber}), while you were shown `
          + `${shownMsgValueWei ?? "an unreadable preview id"}. Nothing was signed — preview the `
          + `launch again and review the new figures before deploying.`,
      },
    };
  }

  const consent = buildConsentSnapshot(planned.plan, input.form, input.previewId);

  // TWO PATHS INTO `authorized`, AND THEY ARE NOT INTERCHANGEABLE.
  //
  // When the AGENT asked for this form (§C3b), a row ALREADY EXISTS at
  // `awaiting_user_form` carrying `origin = 'agent_requested_form'`, the parked
  // `tool_call_id` and the mission run. `createWith` here would insert a SECOND,
  // `user`-origin row: the agent's turn would stay parked against the original
  // intent id forever, the wake would answer nothing, and the DB would hold two
  // live intents for one launch. So the existing row is AUTHORIZED IN PLACE —
  // `authorizeWith` sets status, authorization id/kind and the consent snapshot
  // while leaving `origin` and `tool_call_id` untouched, which is exactly what
  // lets `resumeAgentAfterUserForm` find the parked call afterwards.
  //
  // A user-origin launch has no row yet and creates one, entering directly at
  // `authorized`: a human clicking Deploy on figures they can see IS the
  // authorization, and there is no form still to fill.
  const authorized =
    input.intentId === null
      ? await persistAuthorizedIntent({
          intentId: randomUUID(),
          sessionId: input.sessionId,
          origin: "user",
          status: "authorized",
          chainId: planned.plan.preview.chainId,
          walletAddress: context.walletAddress,
          name: context.request.name,
          symbol: context.request.symbol,
          description: context.request.description,
          links: { urls: context.request.links },
          imageId: context.request.imageId,
          // Raw amount + its decimals, together and always (rule 90).
          prebuyRaw: context.request.prebuyWei.toString(),
          prebuyDecimals: 18,
          authorizationId: randomUUID(),
          authorizationKind: "user_submit",
          authorizationJson: consent,
          expiresAt: new Date(Date.now() + AUTHORIZED_WINDOW_MS).toISOString(),
        })
      : await authorizeDraftedIntent({
          intentId: input.intentId,
          sessionId: input.sessionId,
          // THE USER'S FINAL VALUES, not the agent's draft. Every field in the
          // dialog is editable, and these are the ones the consent snapshot
          // above was built from — they must be the ones the row ends up
          // carrying, or the pre-sign cross-check sees the record and the row
          // describing two different tokens.
          name: context.request.name,
          symbol: context.request.symbol,
          description: context.request.description,
          links: { urls: context.request.links },
          imageId: context.request.imageId,
          prebuyRaw: context.request.prebuyWei.toString(),
          authorizationJson: consent,
        });

  if (!authorized.ok) return { ok: false, refusal: authorized.refusal };
  const intentId = authorized.intentId;

  log.info(`[token-launch:submit] authorized intentId=${intentId}`);

  // Past this point the intent is claimable and the executor owns the money.
  // Its refusals — drift, a lost double-submit race, a locked vault — are
  // surfaced VERBATIM: this layer knows less about them than it does, and
  // paraphrasing a money refusal is how a user learns the wrong thing.
  const outcome = await executeLaunch({ intentId, sessionId: input.sessionId });

  if (outcome.kind === "refused") {
    // Nothing was signed. Wake any parked agent with the refusal rather than
    // leaving its turn hanging on a form that will never be answered.
    await wake(intentId, input.sessionId, { kind: "failed", reason: outcome.message });
    return { ok: false, refusal: { kind: "launch_refused", detail: outcome.message } };
  }

  await wake(
    intentId,
    input.sessionId,
    outcome.txHash === null
      ? { kind: "failed", reason: outcome.message }
      : { kind: "launched", txHash: outcome.txHash, tokenAddress: outcome.tokenAddress },
  );

  return {
    ok: true,
    result: {
      intentId,
      status: outcome.status,
      txHash: outcome.txHash,
      tokenAddress: outcome.tokenAddress,
      msgValueWei: planned.plan.preview.msgValueWei,
      message: outcome.message,
    },
  };
}

/**
 * Write the authorized row under the session control lock.
 *
 * The lock is not incidental: creation is the one transition a row lock cannot
 * exclude (there is no row to lock yet), so it is what keeps the compaction
 * safe-moment gate from reading `clear` a microsecond before live money state
 * appears. DB-only and short — nothing external runs inside it.
 */
async function persistAuthorizedIntent(
  createInput: CreateIntentWithConsent,
): Promise<PersistedAuthorization> {
  try {
    const { createWith } = await import("@vex-agent/db/repos/token-launch-intents.js");
    const { withSessionControlLock } = await import(
      "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js"
    );
    await withSessionControlLock(createInput.sessionId, (client) =>
      createWith(client, createInput),
    );
    return { ok: true, intentId: createInput.intentId };
  } catch (cause) {
    return refusalFromWriteFailure(cause);
  }
}

/**
 * `awaiting_user_form → authorized` on the row an AGENT already drafted (§C3b).
 *
 * THE ROW IS UPDATED, NEVER REPLACED. `authorizeWith` touches status, the
 * authorization id/kind, every editable token field (name, symbol, description,
 * links, image, prebuy) and the consent snapshot, and leaves `origin`,
 * `tool_call_id` and `mission_run_id` exactly as the agent wrote them. That is the whole reason this path exists: those three columns are
 * how `resumeAgentAfterUserForm` later finds the parked call to answer, and a
 * fresh `user`-origin row would carry none of them.
 *
 * The consent snapshot is the SAME one the create path persists, built by the
 * same function from the same plan. A human clicked Deploy on figures they could
 * see either way, so the C0 record is `user_submit` on both paths — the agent
 * proposed the token, it did not authorize the spend.
 *
 * SAME LOCK, for the same reason: this moves an intent INTO the live money set
 * the compaction safe-moment gate reads, so it serializes with that gate.
 *
 * A `null` return is a CAS MISS, not an outage: the predicate requires
 * `status = 'awaiting_user_form' AND expires_at > NOW()`, so `null` means the
 * form window lapsed, the user already answered it, or it was cancelled. Nothing
 * was signed, and a retry cannot change any of those — so it refuses as
 * `launch_refused` rather than inviting one.
 */
async function authorizeDraftedIntent(input: {
  readonly intentId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly symbol: string;
  readonly description: string | null;
  readonly links: Record<string, unknown>;
  readonly imageId: string;
  readonly prebuyRaw: string;
  readonly authorizationJson: unknown;
}): Promise<PersistedAuthorization> {
  try {
    const { authorizeWith } = await import("@vex-agent/db/repos/token-launch-intents.js");
    const { withSessionControlLock } = await import(
      "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js"
    );
    const row = await withSessionControlLock(input.sessionId, (client) =>
      authorizeWith(client, input.intentId, input.sessionId, {
        authorizationId: randomUUID(),
        authorizationKind: "user_submit",
        // The whole editable token, moved in ONE CAS with the consent record
        // that describes it.
        name: input.name,
        symbol: input.symbol,
        description: input.description,
        links: input.links,
        imageId: input.imageId,
        // Raw amount + its decimals, together and always (rule 90).
        prebuyRaw: input.prebuyRaw,
        prebuyDecimals: 18,
        authorizationJson: input.authorizationJson,
      }),
    );

    if (row === null) {
      log.info(`[token-launch:submit] authorize CAS miss intentId=${input.intentId}`);
      return {
        ok: false,
        refusal: {
          kind: "launch_refused",
          detail:
            "This launch request is no longer open — it expired, was already answered, or was "
            + "cancelled. Nothing was signed and no funds moved. Ask Vex to draft the launch "
            + "again, or start one yourself from the Book panel.",
        },
      };
    }
    return { ok: true, intentId: input.intentId };
  } catch (cause) {
    return refusalFromWriteFailure(cause);
  }
}

/**
 * Map a throw from either authorization writer onto its public refusal.
 *
 * Shared by both paths deliberately: they raise the SAME two failures (a
 * vanished image, or anything else), and two copies of this mapping would be
 * free to disagree about whether a missing image is the user's to fix.
 */
function refusalFromWriteFailure(
  cause: unknown,
): { readonly ok: false; readonly refusal: TokenLaunchRefusal } {
  // A vanished image is the one failure here the user can act on, and it must
  // NOT read as a generic outage: it means the picture behind this launch was
  // deleted between preview and Deploy, and a launch cannot proceed without
  // bytes to write on-chain.
  if (cause instanceof Error && cause.name === "LaunchImageMissingError") {
    return {
      ok: false,
      refusal: {
        kind: "image_not_found",
        detail:
          "The image for this launch was removed from the Trench Photos locker while you were "
          + "reviewing. Nothing was signed — pick another image and preview again.",
      },
    };
  }
  // Server-side structured log only — the public refusal below stays
  // redacted. The message is load-bearing for diagnosing schema/constraint
  // failures (a bare error NAME proved undiagnosable in the live probe).
  log.warn(
    `[token-launch:submit] intent write failed type=${
      cause instanceof Error ? cause.name : typeof cause
    } message=${cause instanceof Error ? cause.message.slice(0, 200) : String(cause).slice(0, 200)}`,
  );
  return {
    ok: false,
    refusal: {
      kind: "unpriceable",
      detail:
        "Vex could not record the authorization for this launch, so it did not sign anything. "
        + "Check that Vex services are running and try again.",
    },
  };
}
