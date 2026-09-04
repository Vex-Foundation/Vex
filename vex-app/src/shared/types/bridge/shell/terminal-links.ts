import type { Result } from "../../../ipc/result.js";
import type {
  OpenTerminalLinkInput,
  OpenTerminalLinkValue,
} from "../../../schemas/terminal-links.js";

/**
 * `vex.terminalLinks.*` - opening a link a shell printed, as the RENDERER sees
 * it.
 *
 * ONE DOMAIN METHOD, and it grants nothing. The renderer hands over a string
 * and gets back what happened; it never receives a window handle, never learns
 * whether a host was trusted before it asked, and cannot pre-approve anything.
 * The two gates - the shape policy and the native consent dialog - are both in
 * main (`main/ipc/terminal-links.ts`).
 *
 * SEPARATE FROM `TerminalBridge` on purpose. That surface is the terminal
 * CONTROL plane: create, write, resize, kill, the data port, the workspace
 * snapshot. Every one of those is authority over a pty this window owns. This
 * is authority over the user's BROWSER, which no terminal owns, and folding it
 * into the same namespace would read as though a terminal had it.
 */
export interface TerminalLinksBridge {
  /**
   * Ask main to open a link the terminal produced.
   *
   * Resolves for every outcome, including "you were asked and said no" and
   * "that scheme is refused": those are answers, not transport failures. A
   * `Result` error means the request never reached the policy.
   *
   * The string must be the link EXACTLY as the terminal produced it. Do not
   * normalise it through `new URL().href` first - that converts pre-encoded
   * values and would open a different resource than the one clicked.
   */
  readonly open: (
    input: OpenTerminalLinkInput,
  ) => Promise<Result<OpenTerminalLinkValue>>;
}
