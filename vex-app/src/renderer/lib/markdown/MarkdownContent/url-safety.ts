/**
 * URL gates for markdown rendering: https-only links, the launch-disabled
 * remote-image gate (audit finding W1), and the bundled-asset gate used by the
 * `article` variant.
 */

/** ASCII control chars (U+0000–U+001F) and DEL (U+007F) are never valid in a URL. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Allow only absolute https: URLs; everything else → render as plain text. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  if (hasControlChars(trimmed)) return null;
  if (trimmed.startsWith("//")) return null; // protocol-relative
  try {
    const url = new URL(trimmed); // throws on relative (no base)
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Image-source gate. Remote images are DISABLED for launch to close the CSP
 * img-src exfiltration channel (docs/audit/vexapp-prerelease-audit.md, finding
 * W1): a prompt-injected model could otherwise emit a markdown `<img>` whose URL
 * smuggles a wallet address / portfolio to an attacker host via a GET that
 * `connect-src 'self'` does not stop. So this gate rejects EVERY source and the
 * caller renders alt text via the existing fallback.
 *
 * Post-launch restore is NOT a re-widen of this old host check — it is a
 * tool-sourced-URL allowlist (render only image URLs that appeared verbatim in
 * a validated tool response). Build that instead of reintroducing arbitrary-host
 * loading; `MarkdownImage` (kept dormant) is the hardened `<img>` it will feed.
 */
export function safeImgSrc(_raw: string): string | null {
  return null;
}

/**
 * Local BUNDLED-asset image gate for the `article` variant ONLY (static repo
 * markdown such as the "How Vex works" guide — never model output; chat stays
 * on `safeImgSrc`, which rejects everything). Accepts exactly one shape: a
 * root-relative path into the renderer's own public/ assets. No scheme, no
 * host, no `..`, no query/fragment — a same-origin GET to a bundled file
 * cannot reach an attacker host, so the W1 exfiltration channel stays closed.
 */
export function safeArticleImgSrc(raw: string): string | null {
  const trimmed = raw.trim();
  if (hasControlChars(trimmed)) return null;
  if (!/^\/[A-Za-z0-9_/-]+\.(?:png|svg|jpg|jpeg|webp)$/.test(trimmed)) {
    return null;
  }
  // The character class above already excludes "." path segments; the "//"
  // check closes the protocol-relative shape a doubled separator would allow.
  if (trimmed.includes("//")) return null;
  return trimmed;
}
