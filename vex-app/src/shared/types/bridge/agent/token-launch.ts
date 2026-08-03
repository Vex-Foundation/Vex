import type { Result } from "../../../ipc/result.js";
import type {
  LaunchFormEvent,
  TokenLaunchCancelInput,
  TokenLaunchCancelResult,
  TokenLaunchGetAwaitingInput,
  TokenLaunchGetAwaitingResult,
  TokenLaunchMyLaunchesInput,
  TokenLaunchMyLaunchesResult,
  TokenLaunchPreviewInput,
  TokenLaunchPreviewResult,
  TokenLaunchSubmitInput,
  TokenLaunchSubmitResult,
} from "../../../schemas/token-launch.js";

/**
 * Token launch (C5) — the renderer-facing half of the Trench Express launch
 * surface, over the five `vex:tokenLaunch:*` channels plus one push event.
 *
 * WHAT THIS INTERFACE DELIBERATELY DOES NOT OFFER: any field that becomes a
 * spend. There is no fee, value, recipient, deadline, gas or wallet address in
 * any input — the renderer describes the TOKEN and echoes the opaque
 * `previewId`/`intentId` it was handed; MAIN re-reads the creation fee,
 * converts the typed prebuy to wei, composes `msg.value` and binds the
 * authorization. A renderer-supplied amount reaching the signing path is the
 * exact failure rule 90 exists to prevent, so the contract has no field for one.
 *
 * `preview` is the ARMING step and `submit` is the SPEND CONSENT: the user
 * authorizes the figures `preview` returned, and `submit` carries that
 * `previewId` so main can refuse with `tokenLaunch.preview_stale` rather than
 * sign a number nobody was shown.
 *
 * `getAwaiting` + `onFormRequested` are the §C3b pair: the agent drafts a launch
 * and parks its turn, the EVENT says a form is waiting (ids only), and the READ
 * returns the token it proposed so the dialog can prefill. The event carries no
 * draft content on purpose — the DB row is the source of truth, exactly as
 * `onTranscriptAppend` is a refresh signal rather than a message.
 *
 * Neither of that pair is a spend surface. `preview` still prices the launch and
 * `submit` still re-derives every figure main-side; a prefilled form shortens
 * the typing, never the authorization.
 */
export interface TokenLaunchBridge {
  readonly preview: (
    input: TokenLaunchPreviewInput,
  ) => Promise<Result<TokenLaunchPreviewResult>>;
  readonly submit: (
    input: TokenLaunchSubmitInput,
  ) => Promise<Result<TokenLaunchSubmitResult>>;
  readonly cancel: (
    input: TokenLaunchCancelInput,
  ) => Promise<Result<TokenLaunchCancelResult>>;
  readonly myLaunches: (
    input: TokenLaunchMyLaunchesInput,
  ) => Promise<Result<TokenLaunchMyLaunchesResult>>;
  /**
   * The launch form an agent drafted and is parked waiting on, or `null` when
   * nothing is waiting. Session-scoped; `null` is the ordinary idle answer and
   * never an error.
   */
  readonly getAwaiting: (
    input: TokenLaunchGetAwaitingInput,
  ) => Promise<Result<TokenLaunchGetAwaitingResult>>;
  /**
   * Subscribe to `EV.launch.formRequested` — fired after an agent's
   * `awaiting_user_form` intent has COMMITTED. Payload is ids only; the handler
   * re-reads `getAwaiting`. The renderer hook filters by `event.sessionId`.
   *
   * Returns an idempotent unsubscribe function.
   */
  readonly onFormRequested: (cb: (event: LaunchFormEvent) => void) => () => void;
}
