/**
 * OPENING A LINK A SHELL PRINTED - the cross-process contract.
 *
 * Claude Code, `npm`, `gh`, a stack trace and half the tools a developer runs
 * print URLs, and xterm turns them into clickable links two ways: an OSC 8
 * hyperlink (the escape sequence carries the target) and the web-links addon's
 * regex over plain text. Both need an ANSWER to "the user clicked it, now
 * what", and xterm's default answer is
 * `confirm("...WARNING: This link could potentially be dangerous")` followed by
 * `window.open` (`@xterm/xterm/src/browser/OscLinkProvider.ts:114-129`).
 *
 * In Vex that produced the worst of both: an ugly renderer `confirm()` that
 * names the app as `@vex/app` and truncates the URL, and then NOTHING, because
 * main's `setWindowOpenHandler` serves a closed allowlist of Vex's own
 * destinations and denies every host a user's shell might print. Measured on
 * the owner's Windows session; screenshots 17.png and 18.png.
 *
 * ## The authority is main's, and it is a SECOND policy
 *
 * This channel does NOT widen the app-link allowlist. That list exists so a
 * Vex-authored link (a release note, a docs page) can be opened without asking
 * anyone; it is Vex's own set of destinations and it stays closed.
 *
 * A terminal link is a different thing entirely: it is arbitrary text the
 * user's own shell printed, so it can be any host on the internet, and the
 * authority for opening it is THE USER SAYING SO - once per host, per window,
 * per run of the app, in a NATIVE dialog that shows the full host and the whole
 * URL. `isUserOpenableTerminalLink` is the policy that decides what may even be
 * offered; the dialog is the authority that decides it is opened.
 *
 * VS Code splits the same way: `TerminalUrlLinkOpener` hands the link to the
 * opener service with `openExternal: true`
 * (`terminalContrib/links/browser/terminalLinkOpeners.ts:298-313`), and the
 * trusted-domain prompt lives behind that service rather than in the terminal.
 *
 * ## Every refusal has a NAME
 *
 * `terminal_link_scheme_refused` is not the same fact as
 * `terminal_link_credentials_refused`, and a user who clicked `file:///etc` or
 * a phishing `https://user:pass@host` deserves to be told which rule stopped
 * it. Rule 90's error contract: never "unexpected error".
 *
 * ## Nothing here is cut
 *
 * The dialog shows the WHOLE URL and the whole host. {@link
 * TERMINAL_LINK_MAX_LENGTH} is a bound on what may be SENT, and a link longer
 * than it is refused BY NAME rather than silently shortened - a shortened URL
 * shown for consent would be consent to a destination the user never read.
 */

import { z } from "zod";

/**
 * The longest link this channel carries, in UTF-16 code units.
 *
 * Chosen against what a terminal can actually produce rather than a round
 * number: an OSC 8 hyperlink's URI is bounded by xterm's own OSC payload limit,
 * and every browser and OS shell handler in practice stops well below 4096
 * (IE's historical 2083 is the low bar, Chrome's is ~32k but Windows'
 * `ShellExecute` path is not). A link past this is refused by name - see the
 * module note on why it is never truncated instead.
 */
export const TERMINAL_LINK_MAX_LENGTH = 4096;

/**
 * The TRANSPORT ceiling, which is a different bound with a different job.
 *
 * {@link TERMINAL_LINK_MAX_LENGTH} is a PRODUCT decision - past it a link is
 * not one a browser or an OS shell handler will accept, and the user is told so
 * by name. This is the boundary's own floor against a payload nobody should be
 * asked to carry: a renderer bug that handed the channel a serialized buffer
 * must be refused at the schema, before any policy reasons about it, and it is
 * `validation.invalid_input` because there is nothing to say about it in
 * product terms.
 *
 * Deliberately larger than the product bound, so the two do not collapse into
 * one and `terminal_link_too_long` stays a reachable, meaningful answer.
 */
export const TERMINAL_LINK_TRANSPORT_MAX = 65_536;

/**
 * WHY a link was not opened.
 *
 * `declined` is deliberately NOT in here: a user saying no is an outcome, not a
 * refusal by policy, and collapsing the two would make "I changed my mind"
 * indistinguishable from "Vex would never have opened that".
 */
export const terminalLinkRefusalSchema = z.enum([
  /** Not a URL at all, or carrying whitespace/control characters. */
  "terminal_link_unparsable",
  /** Parsed, but not `http:` or `https:`. `file:`, `vscode:`, `javascript:`. */
  "terminal_link_scheme_refused",
  /** `https://user:password@host` - the classic host-spoofing shape. */
  "terminal_link_credentials_refused",
  /** Parsed with no host at all, e.g. `http:///path`. */
  "terminal_link_host_refused",
  /** Longer than {@link TERMINAL_LINK_MAX_LENGTH}. */
  "terminal_link_too_long",
  /** The OS handler refused or failed. Nothing was opened. */
  "terminal_link_open_failed",
]);

export type TerminalLinkRefusal = z.infer<typeof terminalLinkRefusalSchema>;

/**
 * A host as it is SHOWN to the user before they consent.
 *
 * Two fields and not one, because an internationalised domain has two truthful
 * spellings and showing only one of them is how a homograph attack works.
 * `ascii` is what the URL actually resolves (`xn--80ak6aa92e.com`); `display`
 * is the Unicode form a human reads (`аррӏе.com`). They are EQUAL for an
 * ordinary ASCII host, and the dialog shows both, labelled, only when they
 * differ - which is exactly the signal "this host is not spelled the way it
 * looks".
 */
export const terminalLinkHostSchema = z
  .object({
    ascii: z.string().min(1),
    display: z.string().min(1),
  })
  .strict();

export type TerminalLinkHost = z.infer<typeof terminalLinkHostSchema>;

/** What the renderer asks for. */
export const openTerminalLinkInputSchema = z
  .object({
    /**
     * The link EXACTLY as the terminal produced it. Never re-serialised by the
     * caller: `new URL(x).href` converts pre-encoded values (`%2B` -> `+`) and
     * would open a different resource than the one the user clicked. VS Code
     * passes the raw text for the same reason
     * (`terminalLinkOpeners.ts:306-308`).
     */
    url: z.string().min(1).max(TERMINAL_LINK_TRANSPORT_MAX),
  })
  .strict();

export type OpenTerminalLinkInput = z.infer<typeof openTerminalLinkInputSchema>;

/**
 * What happened, as a discriminated outcome rather than a boolean.
 *
 * All three are SUCCESSFUL `Result`s: "you were asked and you said no" and
 * "that scheme is not openable" are answers the surface renders as statements,
 * not transport failures (rule 04's error layers).
 */
export const openTerminalLinkValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("opened"),
      host: terminalLinkHostSchema,
      /** Whether this open needed the consent dialog, or reused this window's earlier yes. */
      asked: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("declined"),
      host: terminalLinkHostSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("refused"),
      reason: terminalLinkRefusalSchema,
    })
    .strict(),
]);

export type OpenTerminalLinkValue = z.infer<typeof openTerminalLinkValueSchema>;
