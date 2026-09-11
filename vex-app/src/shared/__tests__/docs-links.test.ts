/**
 * Docs-link coupling - the privacy anchor the Settings Superboard section and
 * the wizard footer render, and the external-link policy that gates
 * `shell.openExternal`, must never drift.
 *
 * This suite runs the REAL `isAllowedExternalUrl` against the REAL
 * `DOCS_EXTERNAL_ALLOW` (the exact list `main-window.ts` spreads into
 * `ALLOWED_EXTERNAL`) and the REAL `VEX_PRIVACY_DOC_URL` the components put
 * in `href`. No mirrored fixture: the previous anchor pointed at a host that
 * never resolved, and nothing in the test suite could have noticed.
 *
 * `DOCS_EXTERNAL_ALLOW` is a subset of `ALLOWED_EXTERNAL`, and the `/docs`
 * prefix on `projectvex.ai` appears ONLY in that subset, so "allowed by the
 * subset" implies "allowed by the full list", and a docs URL denied here is
 * denied by the full list too. Testing the subset is therefore faithful and
 * avoids importing `main-window.ts` (electron).
 */

import { describe, expect, it } from "vitest";
import {
  DOCS_EXTERNAL_ALLOW,
  VEX_PRIVACY_DOC_LABEL,
  VEX_PRIVACY_DOC_URL,
} from "../docs-links.js";
import { isAllowedExternalUrl } from "../../main/security/url.js";

function allowed(url: string): boolean {
  return isAllowedExternalUrl(url, DOCS_EXTERNAL_ALLOW);
}

describe("privacy docs link", () => {
  it("admits the exact URL the components render", () => {
    expect(allowed(VEX_PRIVACY_DOC_URL)).toBe(true);
  });

  it("points at the product's own docs tree under the apex host", () => {
    const url = new URL(VEX_PRIVACY_DOC_URL);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("projectvex.ai");
    expect(url.pathname).toBe("/docs/security/privacy");
  });

  it("keeps the label the sections and their tests render", () => {
    expect(VEX_PRIVACY_DOC_LABEL).toBe("Your data stays yours");
  });

  it("admits the rest of the docs tree and nothing outside it", () => {
    expect(allowed("https://projectvex.ai/docs")).toBe(true);
    expect(allowed("https://projectvex.ai/docs/security/encryption")).toBe(true);
    for (const url of [
      "https://projectvex.ai/",
      "https://projectvex.ai/docsX",
      "https://projectvex.ai/doc",
      "https://projectvex.ai/releases", // admitted by its own entry, not this one
      "https://projectvex.ai/docs/../releases",
    ]) {
      expect(allowed(url), url).toBe(false);
    }
  });

  it("denies lookalike hosts, the www subdomain and the retired placeholder hosts", () => {
    for (const url of [
      "https://www.projectvex.ai/docs/security/privacy",
      "https://projectvex.ai.evil.example/docs/security/privacy",
      "https://notprojectvex.ai/docs",
      "https://evil.example/?next=https://projectvex.ai/docs",
      "https://docs.vex.ai/security/local-vault", // what the anchor used to say
      "https://vex.ai/docs",
    ]) {
      expect(allowed(url), url).toBe(false);
    }
  });

  it("denies the same URL over http and over a non-web scheme", () => {
    expect(allowed("http://projectvex.ai/docs/security/privacy")).toBe(false);
    expect(allowed("file:///projectvex.ai/docs/security/privacy")).toBe(false);
  });
});
