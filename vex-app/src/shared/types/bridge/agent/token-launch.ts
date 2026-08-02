import type { Result } from "../../../ipc/result.js";
import type {
  TokenLaunchCancelInput,
  TokenLaunchCancelResult,
  TokenLaunchMyLaunchesInput,
  TokenLaunchMyLaunchesResult,
  TokenLaunchPreviewInput,
  TokenLaunchPreviewResult,
  TokenLaunchSubmitInput,
  TokenLaunchSubmitResult,
} from "../../../schemas/token-launch.js";

/**
 * Token launch (C5) — the renderer-facing half of the Trench Express launch
 * surface, over the four `vex:tokenLaunch:*` channels.
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
 * `submit` and `cancel` are NOT yet implemented in main — both resolve to a
 * typed refusal that says so in words the dialog can render. That is a
 * fail-closed state by design, not an oversight: they need the C0 authorization
 * snapshot and the agent-wake machinery, and a stub that pretended to succeed
 * on a signing path would be far worse than one that refuses.
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
}
