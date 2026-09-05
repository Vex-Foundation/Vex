/**
 * Opening a terminal link - the renderer's data-access layer.
 *
 * One function over `window.vex.terminalLinks.open`, so the terminal registry
 * does not reach for the global and a bridge change surfaces as one compile
 * error here.
 */

import type { Result } from "@shared/ipc/result.js";
import type { OpenTerminalLinkValue } from "@shared/schemas/terminal-links.js";

/**
 * Ask main to open a link the terminal produced.
 *
 * @param url - the link EXACTLY as the terminal produced it. Do not normalise
 * it through `new URL().href` first: that converts pre-encoded values (`%2B` ->
 * `+`) and would open a different resource than the one the user clicked.
 */
export function openTerminalLink(url: string): Promise<Result<OpenTerminalLinkValue>> {
  return window.vex.terminalLinks.open({ url });
}
