/**
 * Shared URL security helpers — used by both the app://vex/ protocol handler
 * and the external-link allowlist (shell.openExternal / setWindowOpenHandler).
 *
 * Lives under `src/main/` (not `src/shared/`) per skill §3: shared/ holds
 * DTO/schema/contracts only; security policy is privileged main-process logic.
 *
 * IMPORTANT: every check here must be paired with a unit test.
 */

/**
 * True if the raw request URL string contains any form of parent-directory
 * traversal segment. Catches:
 *   /..    \..    %2e%2e    %2f%2e%2e    %5c%2e%2e
 * Case-insensitive.
 *
 * The URL constructor normalizes `../` away, so a raw URL like
 *   app://vex/../etc/passwd
 * becomes
 *   pathname = "/etc/passwd"
 * which would *technically* resolve inside our root. Adversarial intent —
 * reject pre-parse so we never even try.
 */
export function containsTraversal(rawUrl: string): boolean {
  const lower = rawUrl.toLowerCase();
  return (
    lower.includes("/..") ||
    lower.includes("\\..") ||
    lower.includes("/%2e%2e") ||
    lower.includes("\\%2e%2e") ||
    lower.includes("%2f%2e%2e") ||
    lower.includes("%5c%2e%2e")
  );
}

/**
 * Path-prefix check that respects path boundary: a prefix like `/foo` only
 * matches `/foo` itself or `/foo/...`, never `/foo-bar` or `/foobaz`.
 *
 * Without this boundary, an allowlist entry `/electron/electron/releases`
 * would erroneously accept `/electron/electron/releases-malicious`.
 */
export function pathStartsWithBoundary(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  // A trailing slash on prefix means "this dir or deeper". Otherwise we
  // accept either an exact match or `prefix + '/'` boundary.
  if (prefix.endsWith("/")) {
    return pathname.startsWith(prefix);
  }
  return pathname.startsWith(`${prefix}/`);
}

/**
 * Allowlist entry shape used by the external-link allowlist.
 * `string` = exact-host match; `{host, pathPrefix}` = host + path-boundary match.
 */
export type ExternalAllowEntry =
  | string
  | { readonly host: string; readonly pathPrefix: string };

/**
 * Decide if a raw URL string is safe to pass to `shell.openExternal`.
 *  - Rejects anything containing path traversal markers.
 *  - Rejects anything that isn't `https:`.
 *  - Accepts only entries from the allowlist with proper path boundary.
 */
export function isAllowedExternalUrl(
  raw: string,
  allowlist: ReadonlyArray<ExternalAllowEntry>
): boolean {
  if (containsTraversal(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  for (const entry of allowlist) {
    if (typeof entry === "string") {
      if (url.hostname === entry) return true;
    } else if (
      url.hostname === entry.host &&
      pathStartsWithBoundary(url.pathname, entry.pathPrefix)
    ) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * The TERMINAL-LINK policy - a second, separate policy
 * ------------------------------------------------------------------ */

/**
 * The decision {@link isUserOpenableTerminalLink} returns.
 *
 * WHY, not a bare boolean: a refusal that reaches the user has to name the rule
 * that produced it (rule 90's error contract), and a caller cannot invent that
 * name from `false`.
 */
export type TerminalLinkDecision =
  | {
      readonly kind: "allowed";
      /** The raw string, unchanged. Open THIS, never a re-serialised URL. */
      readonly url: string;
      /** Punycode host, exactly as the URL resolves it. */
      readonly asciiHost: string;
    }
  | { readonly kind: "refused"; readonly reason: TerminalLinkPolicyRefusal };

/** The refusal names this policy can produce. Mirrors the wire enum. */
export type TerminalLinkPolicyRefusal =
  | "terminal_link_unparsable"
  | "terminal_link_scheme_refused"
  | "terminal_link_credentials_refused"
  | "terminal_link_host_refused"
  | "terminal_link_too_long";

/**
 * C0 controls, space and DEL.
 *
 * Not cosmetic. The caller opens the RAW text rather than `url.href`, because
 * re-serialising a URL is LOSSY and the loss is measurable on this Node:
 * `https://example.com/a\\b` becomes `.../a/b`, `https://EXAMPLE.com/P` becomes
 * `https://example.com/P`, `https://example.com:443/x` loses its port. VS
 * Code's `TerminalUrlLinkOpener` passes `link.text` for the same reason
 * (`terminalLinkOpeners.ts:306-308`).
 *
 * Opening a different string from the one that was validated is only safe while
 * the two cannot diverge, and the URL parser silently strips leading and
 * trailing C0, plus tab and newline ANYWHERE, before parsing. So a raw string
 * carrying any of those is refused rather than trusted: that is the classic
 * parser-differential bug, and this is the check that closes it.
 */
const UNSAFE_LINK_CHARACTERS = /[\u0000-\u0020\u007f]/;

/**
 * Whether a link a SHELL printed may be OFFERED to the user for opening.
 *
 * DELIBERATELY NOT `isAllowedExternalUrl`, and the difference is the whole
 * reason this exists. That function serves Vex's OWN destinations: a closed host
 * allowlist, so a link Vex itself authored opens with nobody asked. A terminal
 * link is arbitrary text from the user's own shell - it can be any host on the
 * internet, and no allowlist can be written for it.
 *
 * So this policy narrows the SHAPE and leaves the destination to a human:
 *
 *  - `http:` or `https:` ONLY. `file:`, `javascript:`, `vscode:`, `mailto:` and
 *    every custom protocol handler an installed application registered are
 *    refused, because `shell.openExternal` on those hands a chosen argument to
 *    a chosen local program.
 *  - NO CREDENTIALS in the URL. `https://www.paypal.com@evil.example/` reads as
 *    PayPal to a human and resolves to `evil.example`; there is no legitimate
 *    terminal link of that shape.
 *  - A HOST MUST EXIST, so `http:///etc/passwd` cannot smuggle a path through.
 *  - NO WHITESPACE OR CONTROL CHARACTERS. See {@link UNSAFE_LINK_CHARACTERS}.
 *
 * It says a link is OFFERABLE, never that it may be opened. The consent dialog
 * above it is the authority that decides that.
 *
 * @param raw - the link exactly as the terminal produced it.
 * @param maxLength - the wire bound, passed in rather than imported so this
 * module stays free of schema dependencies (it is loaded by the protocol
 * handler too).
 */
export function isUserOpenableTerminalLink(
  raw: string,
  maxLength: number,
): TerminalLinkDecision {
  if (raw.length > maxLength) {
    return { kind: "refused", reason: "terminal_link_too_long" };
  }
  if (UNSAFE_LINK_CHARACTERS.test(raw)) {
    return { kind: "refused", reason: "terminal_link_unparsable" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "refused", reason: "terminal_link_unparsable" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "refused", reason: "terminal_link_scheme_refused" };
  }
  if (url.username !== "" || url.password !== "") {
    return { kind: "refused", reason: "terminal_link_credentials_refused" };
  }
  // DEFENSIVE. The WHATWG parser requires a non-empty host for `http:`/`https:`
  // and throws without one, and it reinterprets a triple slash rather than
  // producing an empty host (`http:///etc/passwd` parses with host `etc`), so
  // no input reaches this on the current runtime. It is a cheap floor against a
  // parser that ever stops guaranteeing that, and the refusal it would produce
  // is named rather than generic.
  if (url.hostname === "") {
    return { kind: "refused", reason: "terminal_link_host_refused" };
  }
  return { kind: "allowed", url: raw, asciiHost: url.hostname };
}

/**
 * Resolve an `app://<expectedHost>/...` URL against a renderer-root directory,
 * returning the absolute file path or a refusal reason.
 *  - "bad_request" → URL didn't parse
 *  - "not_found"   → host segment didn't match expectedHost
 *  - "forbidden"   → traversal detected (raw or post-decode) or resolved
 *                    path escapes the root
 */
export type AppUrlResolution =
  | { readonly kind: "ok"; readonly absolutePath: string }
  | { readonly kind: "bad_request" }
  | { readonly kind: "not_found" }
  | { readonly kind: "forbidden" };

export function resolveAppUrl(args: {
  readonly rawUrl: string;
  readonly expectedHost: string;
  readonly normalizedRoot: string;
  /** node:path resolve+sep injected so this stays platform-aware in callers. */
  readonly resolve: (...segments: string[]) => string;
  readonly sep: string;
}): AppUrlResolution {
  if (containsTraversal(args.rawUrl)) {
    return { kind: "forbidden" };
  }
  let urlPath: string;
  try {
    const url = new URL(args.rawUrl);
    if (url.host !== args.expectedHost) return { kind: "not_found" };
    urlPath = decodeURIComponent(url.pathname);
    if (urlPath.includes("..")) return { kind: "forbidden" };
  } catch {
    return { kind: "bad_request" };
  }
  if (urlPath === "/" || urlPath === "") {
    urlPath = "/index.html";
  }
  const resolved = args.resolve(args.normalizedRoot, "." + urlPath);
  if (
    !resolved.startsWith(args.normalizedRoot + args.sep) &&
    resolved !== args.normalizedRoot
  ) {
    return { kind: "forbidden" };
  }
  return { kind: "ok", absolutePath: resolved };
}
