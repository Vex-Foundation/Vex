/**
 * `vex:terminal:openLink` - the ONLY way a link a shell printed reaches a
 * browser.
 *
 * ## Why this is a channel and not `window.open`
 *
 * xterm's default OSC 8 activation is `confirm()` then `window.open`
 * (`@xterm/xterm/src/browser/OscLinkProvider.ts:114-129`). In Vex that produced
 * a renderer `confirm()` branded `@vex/app` with the URL cut mid-string, and
 * then nothing at all, because `setWindowOpenHandler` serves a CLOSED allowlist
 * of Vex's own destinations and denies every host a developer's shell might
 * print. Measured on the owner's Windows session (17.png, 18.png).
 *
 * The renderer never decides that a URL may be opened, and it never gets a
 * window handle. It asks; main decides.
 *
 * ## Two gates, and they answer different questions
 *
 * 1. `isUserOpenableTerminalLink` (`main/security/url.ts`) is POLICY: is this
 *    shape offerable at all. `http(s)` only, no embedded credentials, a real
 *    host, no whitespace or control characters. A failure here is refused BY
 *    NAME and no dialog is shown - there is nothing to consent to.
 * 2. The native `dialog.showMessageBox` is AUTHORITY: a human sees the whole
 *    host and the whole URL and says yes. A model cannot reach this channel and
 *    could not answer the dialog if it did.
 *
 * VS Code splits the same way - `TerminalUrlLinkOpener` hands the link to the
 * opener service with `openExternal: true`
 * (`terminalContrib/links/browser/terminalLinkOpeners.ts:298-313`) and the
 * trusted-domain prompt lives behind that service - and this is the ADOPTED
 * half of its model. The REJECTED half is its durable trusted-domains store
 * (`workbench/contrib/url/browser/trustedDomains.ts`), which persists a user's
 * yes across restarts: that is a durable authority record with its own
 * management UI, revocation story and threat model, and none of those exist
 * here yet. This memory is per window, per host, per RUN, and it dies with the
 * process.
 *
 * ## The raw string is what is opened
 *
 * Never `new URL(raw).href`. Re-serialising converts pre-encoded values
 * (`%2B` -> `+`) and would open a different resource than the one the user
 * clicked; VS Code passes `link.text` for the same reason
 * (`terminalLinkOpeners.ts:306-308`). The policy's control-character check is
 * what makes validating one string and opening another safe.
 */

import { BrowserWindow, dialog, shell } from "electron";
import { domainToUnicode } from "node:url";
import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  openTerminalLinkInputSchema,
  openTerminalLinkValueSchema,
  TERMINAL_LINK_MAX_LENGTH,
  type OpenTerminalLinkValue,
  type TerminalLinkHost,
} from "@shared/schemas/terminal-links.js";
import { isUserOpenableTerminalLink } from "../security/url.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

/**
 * How many hosts one window may remember a yes for.
 *
 * Every entry costs the user a deliberate click on a modal dialog, so this is
 * not a defence against volume - it is rule 05's floor that a map living for
 * the process lifetime states its bound. Past it the dialog simply asks again,
 * which is the fail-closed direction.
 */
const REMEMBERED_HOSTS_PER_WINDOW = 128;

/**
 * Hosts this window has already been told yes for, THIS RUN.
 *
 * Keyed by `webContents.id` so one window's consent is not another's, and held
 * in a module constant because the authority it records has exactly one owner -
 * this handler - and no other reader.
 */
const trustedHostsByWindow = new Map<number, Set<string>>();

/** Test seam: forget every in-session yes. */
export function __resetTerminalLinkTrustForTests(): void {
  trustedHostsByWindow.clear();
}

/**
 * The host as the dialog spells it.
 *
 * TWO spellings, because an internationalised domain has two truthful ones and
 * showing only the pretty one is how a homograph attack works: `аррӏе.com`
 * (Cyrillic) and `xn--80ak6aa92e.com` are the same host and only the second
 * says so. They are equal for an ordinary ASCII host, and the dialog labels
 * them separately only when they differ.
 */
function describeHost(asciiHost: string): TerminalLinkHost {
  let display = asciiHost;
  try {
    const unicode = domainToUnicode(asciiHost);
    if (unicode !== "") display = unicode;
  } catch {
    // `domainToUnicode` refusing means the ASCII form is all there is, which is
    // the safe spelling anyway.
  }
  return { ascii: asciiHost, display };
}

/**
 * The consent copy. WHOLE, never cut: see the schema module's note.
 *
 * The last line is not decoration. Consent here also covers every LATER link to
 * the same host until the app is closed, and a user cannot give informed
 * consent to a scope they were not told about.
 */
function consentDetail(host: TerminalLinkHost, url: string): string {
  const hostLines =
    host.ascii === host.display
      ? `Host: ${host.ascii}`
      : `Host: ${host.display}\nHost (punycode): ${host.ascii}`;
  return (
    `${hostLines}\n\n${url}\n\n` +
    "Vex will not ask again for this host until you close the app."
  );
}

export function registerTerminalLinkHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.terminal.openLink,
      domain: "studio",
      inputSchema: openTerminalLinkInputSchema,
      outputSchema: openTerminalLinkValueSchema,
      handle: async (input, ctx): Promise<Result<OpenTerminalLinkValue>> => {
        const decision = isUserOpenableTerminalLink(input.url, TERMINAL_LINK_MAX_LENGTH);
        if (decision.kind === "refused") {
          // The REASON is logged, never the URL: a shell's output is the user's
          // content and a link can carry a token in its query string.
          log.warn(`[terminal-links] refused reason=${decision.reason}`);
          return ok<OpenTerminalLinkValue>({ kind: "refused", reason: decision.reason });
        }

        const host = describeHost(decision.asciiHost);
        const windowId = ctx.event.sender.id;
        let trusted = trustedHostsByWindow.get(windowId);
        if (trusted === undefined) {
          trusted = new Set<string>();
          trustedHostsByWindow.set(windowId, trusted);
          // The set outlives no window: dropped when the window's contents go,
          // so a reload cannot inherit the previous document's consent either.
          ctx.event.sender.once("destroyed", () => {
            trustedHostsByWindow.delete(windowId);
          });
        }

        const asked = !trusted.has(host.ascii);
        if (asked) {
          const options = {
            type: "question" as const,
            buttons: ["Open link", "Cancel"],
            // CANCEL IS THE DEFAULT AND THE ESCAPE. Rule 08's floor for a
            // consequential action: the safer choice is the one a stray Enter
            // or Escape lands on.
            defaultId: 1,
            cancelId: 1,
            noLink: true,
            title: "Open a link from the terminal",
            message: "Open this link in your browser?",
            detail: consentDetail(host, decision.url),
          };
          const parent = BrowserWindow.fromWebContents(ctx.event.sender);
          // MODAL TO THE WINDOW THAT ASKED, when there is one: a sheet on the
          // window whose terminal printed the link cannot be mistaken for a
          // prompt from some other part of the app, and it cannot be answered
          // while that window is gone.
          const answer =
            parent === null
              ? await dialog.showMessageBox(options)
              : await dialog.showMessageBox(parent, options);
          if (answer.response !== 0) {
            return ok<OpenTerminalLinkValue>({ kind: "declined", host });
          }
          // REMEMBERED ONLY IF THERE IS ROOM. Past the bound the dialog asks
          // every time, which is the fail-closed direction.
          if (trusted.size < REMEMBERED_HOSTS_PER_WINDOW) trusted.add(host.ascii);
        }

        // CANCELLED WHILE THE DIALOG WAS UP. The pane was closed, the project
        // switched, the window went away: a yes to a question nobody is waiting
        // on any more does not open anything. Fail closed.
        if (ctx.signal.aborted || ctx.event.sender.isDestroyed()) {
          return ok<OpenTerminalLinkValue>({ kind: "declined", host });
        }

        try {
          await shell.openExternal(decision.url);
        } catch {
          // The OS handler is the failure, and its message can carry a local
          // path, so it is not propagated. Nothing was opened.
          log.warn(`[terminal-links] openExternal failed host=${host.ascii}`);
          return ok<OpenTerminalLinkValue>({
            kind: "refused",
            reason: "terminal_link_open_failed",
          });
        }
        return ok<OpenTerminalLinkValue>({ kind: "opened", host, asked });
      },
    }),
  ];
}
