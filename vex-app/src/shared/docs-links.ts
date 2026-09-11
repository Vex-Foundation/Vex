/**
 * The "Your data stays yours" link the Settings Superboard section and the
 * wizard footer render, and the external-link allow entry that makes it
 * clickable.
 *
 * WHY BOTH FACTS LIVE HERE. Same reason as `chart-attribution.ts`: the anchor
 * is in the renderer, the decision to open an external URL belongs to main's
 * `ALLOWED_EXTERNAL`, and held in two places they drift silently - the link
 * renders, the user clicks, and nothing at all happens. What shipped before
 * this module was worse than silence: both anchors pointed at
 * `docs.vex.ai/security/local-vault`, a host that does not resolve (measured
 * 2026-09-11: NXDOMAIN, while the apex `vex.ai` belongs to a third party),
 * and the allowlist admitted both hosts host-wide, so the click opened the
 * user's browser on a DNS error. So the URL the components render
 * and the entry the allowlist spreads are ONE declaration, and
 * `shared/__tests__/docs-links.test.ts` asserts the real allowlist admits
 * the real URL and denies its lookalikes.
 *
 * SCOPE. The apex `projectvex.ai`, path-scoped to `/docs`: the documentation
 * tree and nothing else on the site (the release-notes CTA keeps its own
 * `/releases` entry). `isAllowedExternalUrl` matches the hostname exactly and
 * the path with boundary respect, so `www.projectvex.ai`,
 * `projectvex.ai.evil.example` and `/docsX` are all denied.
 */

/** Structurally identical to main's `ExternalAllowEntry`; shared must not import main. */
export type DocsAllowEntry =
  | string
  | { readonly host: string; readonly pathPrefix: string };

/**
 * The privacy page of the public docs: what stays on the machine, what leaves
 * it, and what is opt-in. It is the page the label promises, and it exists in
 * the landing repository's docs navigation (`/docs/security/privacy`).
 */
export const VEX_PRIVACY_DOC_URL = "https://projectvex.ai/docs/security/privacy";

/** The visible label beside the arrow glyph. */
export const VEX_PRIVACY_DOC_LABEL = "Your data stays yours";

/** Spread verbatim into main's `ALLOWED_EXTERNAL`. */
export const DOCS_EXTERNAL_ALLOW: readonly DocsAllowEntry[] = [
  { host: "projectvex.ai", pathPrefix: "/docs" },
];
