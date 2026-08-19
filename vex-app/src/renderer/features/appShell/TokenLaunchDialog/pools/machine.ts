/**
 * The pools.fun TWO-STAGE authorization machine.
 *
 * A pure reducer, deliberately outside React: this is the rule that decides when
 * a click may spend the user's money, and it must be readable and testable
 * without mounting anything.
 *
 * ── THE TWO STAGES ────────────────────────────────────────────────────────
 * STAGE 1 (`editing` → `verifying` → `authorizing`): the user's inputs go to
 * main, which prepares the launch, verifies the returned calldata line by line
 * and answers with a FINGERPRINT — the final predicted token address, the
 * resolved fee recipient and the exact costs. Nothing is signed.
 *
 * STAGE 2 (`authorizing` → `deploying` → `done`): the Deploy click authorizes
 * EXACTLY that fingerprint, by its opaque id. The figures the user is looking at
 * are the figures main already computed and pinned.
 *
 * ── THE INVARIANT THIS FILE EXISTS TO ENFORCE ─────────────────────────────
 * A DISPLAYED FINGERPRINT IS VOIDED BY ANY CHANGE. Editing a field, a drift
 * refusal, or a required reprepare all return to stage 1 and DROP the
 * fingerprint. There is deliberately no transition that carries a fingerprint
 * forward across an edit: if such a path existed, a user could change the symbol
 * after stage 1 and press Deploy on numbers computed for the old one. `Deploy`
 * is armed by exactly one state, `authorizing`, and that state is only ever
 * entered by a fresh `prepare_succeeded`.
 *
 * `re_review` and `refused` are distinct on purpose. `re_review` means the
 * numbers moved and the user must look again; `refused` means this attempt was
 * rejected and the input is the thing to change. Collapsing them would tell a
 * user whose fee moved that they had typed something wrong.
 */

import type { TerminalTone } from "../../token-launch/launch-display.js";
import type { PoolsPreparedLaunch } from "@shared/schemas/pools-launch.js";

export type PoolsLaunchState =
  /** Stage 1. No fingerprint exists; Deploy is unreachable. */
  | { readonly kind: "editing" }
  /** Stage 1, in flight: main is preparing and verifying. */
  | { readonly kind: "verifying" }
  /** Stage 2 armed: this exact fingerprint is what Deploy authorizes. */
  | { readonly kind: "authorizing"; readonly fingerprint: PoolsPreparedLaunch }
  /** Stage 2, in flight: signed and broadcasting. Not dismissible. */
  | { readonly kind: "deploying"; readonly fingerprint: PoolsPreparedLaunch }
  /** The numbers moved. The fingerprint is GONE and stage 1 must run again. */
  | { readonly kind: "re_review"; readonly message: string }
  /** This attempt was rejected; the user's input is what changes. */
  | { readonly kind: "refused"; readonly message: string }
  | {
      readonly kind: "done";
      readonly message: string;
      readonly tone: TerminalTone;
      readonly autoDismiss: boolean;
    };

export type PoolsLaunchEvent =
  /** Any edit to any field. Voids a displayed fingerprint. */
  | { readonly type: "form_changed" }
  | { readonly type: "prepare_started" }
  | {
      readonly type: "prepare_succeeded";
      readonly fingerprint: PoolsPreparedLaunch;
    }
  | { readonly type: "prepare_failed"; readonly message: string }
  | { readonly type: "deploy_started" }
  | {
      readonly type: "deploy_succeeded";
      readonly message: string;
      readonly tone: TerminalTone;
      readonly autoDismiss: boolean;
    }
  /**
   * The deploy was refused. Whatever the reason, the fingerprint is VOIDED:
   * a refusal cannot prove the verified plan is still valid, and re-preparing
   * is correct in every case, so this is the one fail-safe direction.
   */
  | { readonly type: "deploy_refused"; readonly message: string }
  /** The armed fingerprint reached its expiry while the user was reading it. */
  | { readonly type: "fingerprint_expired" }
  /** A fresh open cycle is a fresh consent. */
  | { readonly type: "reopened" };

export const POOLS_LAUNCH_INITIAL_STATE: PoolsLaunchState = { kind: "editing" };

export function poolsLaunchReducer(
  state: PoolsLaunchState,
  event: PoolsLaunchEvent,
): PoolsLaunchState {
  switch (event.type) {
    case "reopened":
      return { kind: "editing" };

    case "form_changed":
      // THE VOIDING RULE. An in-flight stage returns nothing here: `verifying`
      // is answered by its own result, and `deploying` is a signature already
      // in flight that an edit cannot recall. Every other state drops whatever
      // was on screen and goes back to stage 1.
      if (state.kind === "verifying" || state.kind === "deploying") return state;
      if (state.kind === "done") return state;
      return state.kind === "editing" ? state : { kind: "editing" };

    case "prepare_started":
      // Only reachable from a stage-1 state. Refusing it while `deploying`
      // keeps a signature in flight from being overwritten by a new preparation.
      if (state.kind === "deploying" || state.kind === "done") return state;
      return { kind: "verifying" };

    case "prepare_succeeded":
      // The ONLY door into stage 2, and only from the stage-1 call that was
      // actually in flight. A late answer arriving after the user has edited
      // again must not silently arm Deploy behind them.
      if (state.kind !== "verifying") return state;
      return { kind: "authorizing", fingerprint: event.fingerprint };

    case "prepare_failed":
      if (state.kind !== "verifying") return state;
      return { kind: "refused", message: event.message };

    case "deploy_started":
      // Deploy is reachable from exactly one state. This is the code-level
      // restatement of "the click authorizes the displayed fingerprint".
      if (state.kind !== "authorizing") return state;
      return { kind: "deploying", fingerprint: state.fingerprint };

    case "deploy_succeeded":
      if (state.kind !== "deploying") return state;
      return {
        kind: "done",
        message: event.message,
        tone: event.tone,
        autoDismiss: event.autoDismiss,
      };

    case "deploy_refused":
      // The fingerprint is NOT carried forward. A refused deploy cannot prove
      // the verified plan is still what main would sign, so the user prepares
      // again and reads the figures again — never a second click on figures
      // that already failed once.
      if (state.kind !== "deploying") return state;
      return { kind: "re_review", message: event.message };

    case "fingerprint_expired":
      // Only an ARMED fingerprint can expire. A deploy already in flight is
      // past the point where expiry means anything, and main is the authority
      // on that transaction's outcome.
      if (state.kind !== "authorizing") return state;
      return {
        kind: "re_review",
        message:
          "Those figures have expired. Prepare the launch again to see the current ones.",
      };
  }
}

/**
 * The armed fingerprint, or `null`. The single source for both the Deploy
 * button's enabled state and the figures rendered beside it, so the two can
 * never disagree about what is being authorized.
 */
export function armedFingerprint(
  state: PoolsLaunchState,
): PoolsPreparedLaunch | null {
  return state.kind === "authorizing" ? state.fingerprint : null;
}

/** Is a stage in flight? Freezes the form and blocks dismissal. */
export function isPoolsLaunchBusy(state: PoolsLaunchState): boolean {
  return state.kind === "verifying" || state.kind === "deploying";
}

/**
 * A SIGNATURE IN FLIGHT IS NOT DISMISSIBLE — the same rule the Trench lane
 * enforces. `verifying` signs nothing and stays dismissible.
 */
export function canDismissPoolsLaunch(state: PoolsLaunchState): boolean {
  return state.kind !== "deploying";
}
