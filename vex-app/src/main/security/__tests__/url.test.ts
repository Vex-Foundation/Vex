/**
 * Unit tests for the shared URL security helpers — they back BOTH the app://vex/
 * protocol handler and the external-link allowlist, so a regression here is a
 * regression in two security boundaries at once.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  containsTraversal,
  isAllowedExternalUrl,
  pathStartsWithBoundary,
  resolveAppUrl,
  type ExternalAllowEntry,
} from "../url.js";

describe("containsTraversal", () => {
  it.each([
    "app://vex/../etc/passwd",
    "app://vex/foo/../../../etc",
    "app://vex/%2e%2e/etc/passwd",
    "app://vex/%2E%2E/etc/passwd",
    "app://vex/%2f%2e%2e/etc",
    "https://github.com/../",
    "https://github.com/foo\\..\\bar",
  ])("flags %s", (s) => {
    expect(containsTraversal(s)).toBe(true);
  });

  it.each([
    "app://vex/index.html",
    "https://github.com/Vex-Foundation/Vex",
    "https://github.com/electron/electron/releases",
    "app://vex/assets/main.js",
  ])("does not flag %s", (s) => {
    expect(containsTraversal(s)).toBe(false);
  });
});

describe("pathStartsWithBoundary", () => {
  it("exact match", () => {
    expect(pathStartsWithBoundary("/foo", "/foo")).toBe(true);
  });
  it("subpath with slash boundary", () => {
    expect(pathStartsWithBoundary("/foo/bar", "/foo")).toBe(true);
  });
  it("rejects suffix-only match", () => {
    expect(pathStartsWithBoundary("/foo-bar", "/foo")).toBe(false);
    expect(pathStartsWithBoundary("/foobar", "/foo")).toBe(false);
  });
  it("trailing slash on prefix accepts deep subpaths", () => {
    expect(pathStartsWithBoundary("/foo/bar/baz", "/foo/")).toBe(true);
    expect(pathStartsWithBoundary("/foo-bar", "/foo/")).toBe(false);
  });
});

describe("isAllowedExternalUrl", () => {
  // Mirrors the production ALLOWED_EXTERNAL in main-window.ts. Keep the
  // two in sync — every new production entry needs both an allow case
  // and a near-miss deny case below.
  const allowlist: ReadonlyArray<ExternalAllowEntry> = [
    "vex.ai",
    "docs.vex.ai",
    "portal.jup.ag",
    "app.tavily.com",
    "openrouter.ai",
    "releases.electronjs.org",
    "desktop.docker.com",
    "docs.docker.com",
    "explorer.solana.com",
    "dexscreener.com",
    "www.tradingview.com",
    "etherscan.io",
    "basescan.org",
    "arbiscan.io",
    "bscscan.com",
    "polygonscan.com",
    "optimistic.etherscan.io",
    { host: "projectvex.ai", pathPrefix: "/releases" },
    { host: "github.com", pathPrefix: "/electron/electron/releases" },
    {
      host: "chromewebstore.google.com",
      pathPrefix:
        "/detail/x-auth-helper/igpkhkjmpdecacocghpgkghdcmcmpfhp",
    },
    {
      host: "addons.mozilla.org",
      pathPrefix: "/en-US/firefox/addon/rettiwt-auth-helper",
    },
  ];

  it.each([
    "https://vex.ai/",
    "https://docs.vex.ai/",
    "https://portal.jup.ag/keys",
    "https://app.tavily.com/",
    "https://app.tavily.com/home",
    "https://app.tavily.com/api-keys",
    "https://openrouter.ai/models",
    "https://releases.electronjs.org/schedule",
    "https://desktop.docker.com/mac/main/arm64/Docker.dmg",
    "https://docs.docker.com/desktop/setup/install/mac-install/",
    "https://projectvex.ai/releases",
    "https://projectvex.ai/releases/v0-2-0",
    "https://github.com/electron/electron/releases",
    "https://github.com/electron/electron/releases/tag/v42.0.0",
    "https://dexscreener.com/solana/8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
    "https://www.tradingview.com/",
    "https://explorer.solana.com/tx/3xY2",
    "https://etherscan.io/tx/0xabc123",
    "https://basescan.org/tx/0xabc123",
    "https://arbiscan.io/tx/0xabc123",
    "https://bscscan.com/tx/0xabc123",
    "https://polygonscan.com/tx/0xabc123",
    "https://optimistic.etherscan.io/tx/0xabc123",
    "https://chromewebstore.google.com/detail/x-auth-helper/igpkhkjmpdecacocghpgkghdcmcmpfhp",
    "https://chromewebstore.google.com/detail/x-auth-helper/igpkhkjmpdecacocghpgkghdcmcmpfhp/reviews",
    "https://addons.mozilla.org/en-US/firefox/addon/rettiwt-auth-helper",
    "https://addons.mozilla.org/en-US/firefox/addon/rettiwt-auth-helper/reviews/",
  ])("allows %s", (u) => {
    expect(isAllowedExternalUrl(u, allowlist)).toBe(true);
  });

  it.each([
    "http://vex.ai/", // wrong scheme
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>",
    "https://evil.com/",
    "https://vex.ai.evil.com/",
    "https://github.com/", // only /electron/electron/releases remains allowlisted
    "https://github.com/torvalds/linux",
    "https://github.com/electron/electron", // missing /releases boundary
    "https://github.com/electron/electron/issues/1",
    // Path-boundary regression: prefix is /electron/electron/releases.
    // Without boundary, /releases-malicious would slip through.
    "https://github.com/electron/electron/releases-malicious/",
    "https://github.com/electron/electron/releasesfoo",
    // Regression: the github.com/Vex-Foundation/ entry died with the
    // projectvex.ai/releases repoint (2026-07-22) — must stay denied.
    "https://github.com/Vex-Foundation/Vex",
    "https://github.com/Vex-Foundation/Vex/releases",
    // projectvex.ai near-misses: path boundary, host root, exact-host only
    "https://projectvex.ai/", // root not under /releases
    "https://projectvex.ai/releasesX",
    "https://projectvex.ai/release",
    "https://www.projectvex.ai/releases", // exact-host match, no subdomains
    "https://projectvex.ai.evil.com/releases",
    // Traversal in path
    "https://projectvex.ai/releases/../../evil",
    "https://github.com/electron/electron/releases/../../torvalds/linux",
    "https://github.com/%2e%2e/Vex-Foundation/",
    // Tavily — host pollution / wrong subdomain / wrong scheme
    "http://app.tavily.com/", // wrong scheme
    "https://docs.tavily.com/",
    "https://api.tavily.com/",
    "https://app.tavily.com.evil.com/",
    // Solana explorer / DexScreener — exact-host pollution / near-miss deny
    "https://dexscreener.com.evil.com/",
    "https://notdexscreener.com/",
    "https://www.tradingview.com.evil.com/",
    "http://www.tradingview.com/",
    "https://explorer.solana.com.evil.com/",
    "http://dexscreener.com/", // wrong scheme
    // EVM explorers — exact-host pollution / subdomain / lookalike / scheme
    "https://etherscan.io.evil.com/",
    "https://api.etherscan.io/", // subdomain not allow-listed (exact host only)
    "https://notetherscan.io/",
    "https://basescan.org.evil.com/",
    "https://arbiscan.io.evil.com/",
    "https://bscscan.com.evil.com/",
    "https://polygonscan.com.evil.com/",
    "https://optimistic.etherscan.io.evil.com/",
    "http://etherscan.io/tx/0xabc123", // wrong scheme
    // Chrome Web Store — exact-extension path-boundary regression
    "https://chromewebstore.google.com/detail/x-auth-helper/igpkhkjmpdecacocghpgkghdcmcmpfhp-malicious",
    "https://chromewebstore.google.com/detail/x-auth-helper-clone/igpkhkjmpdecacocghpgkghdcmcmpfhp",
    "https://chromewebstore.google.com/detail/other-extension/abc",
    "https://chromewebstore.google.com/category/extensions",
    // Firefox addon — path-boundary regression / locale prefix / root
    "https://addons.mozilla.org/en-US/firefox/addon/rettiwt-auth-helper-evil",
    "https://addons.mozilla.org/de/firefox/addon/rettiwt-auth-helper",
    "https://addons.mozilla.org/",
    "",
    "not-a-url",
  ])("denies %s", (u) => {
    expect(isAllowedExternalUrl(u, allowlist)).toBe(false);
  });

  it("URL spec normalizes hostname to lowercase - mixed case still allowed", () => {
    expect(isAllowedExternalUrl("https://VEX.AI/", allowlist)).toBe(true);
    expect(
      isAllowedExternalUrl("https://PROJECTvex.ai/releases", allowlist)
    ).toBe(true);
  });
});

describe("resolveAppUrl", () => {
  // `installAppProtocolHandler` hands `resolveAppUrl` a root that went through
  // the SAME `path.resolve` it injects, so the containment prefix and the
  // resolved candidate speak one platform's separator. Resolving the fixture
  // root reproduces that contract on win32, where a POSIX literal could never
  // prefix-match a drive-rooted backslash path.
  const root = path.resolve("/var/app/dist/renderer");
  const args = (rawUrl: string) => ({
    rawUrl,
    expectedHost: "vex",
    normalizedRoot: root,
    resolve: path.resolve,
    sep: path.sep,
  });

  it("resolves root + named index", () => {
    expect(resolveAppUrl(args("app://vex/")).kind).toBe("ok");
    expect(resolveAppUrl(args("app://vex/index.html")).kind).toBe("ok");
  });

  it("resolves nested asset", () => {
    const out = resolveAppUrl(args("app://vex/assets/main.css"));
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.absolutePath).toBe(path.join(root, "assets", "main.css"));
    }
  });

  it.each([
    "app://vex/../etc/passwd",
    "app://vex/../../etc/passwd",
    "app://vex/%2e%2e/etc/passwd",
    "app://vex/foo/../../../etc/passwd",
    "app://vex/./../etc/passwd",
  ])("blocks traversal: %s", (raw) => {
    expect(resolveAppUrl(args(raw)).kind).toBe("forbidden");
  });

  it("rejects wrong host", () => {
    expect(resolveAppUrl(args("app://other/index.html")).kind).toBe("not_found");
    expect(resolveAppUrl(args("app://localhost/index.html")).kind).toBe(
      "not_found"
    );
  });

  it("rejects malformed URL", () => {
    expect(resolveAppUrl(args("not-a-url")).kind).toBe("bad_request");
  });
});
