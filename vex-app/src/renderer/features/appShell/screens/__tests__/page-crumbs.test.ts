/**
 * page-crumbs - what the title bar calls the open page and, for a subpage,
 * its crumb (docs/design/R3-MINIMAL.md sections 3 and 9.2). Pure: a route in,
 * a name and parent routes out.
 *
 * Pins:
 *   - no page: null; a top-level page: its name and no parents;
 *   - Agent Scan and All assets: Portfolio as their parent; a narrowed
 *     register names its scope ("Session assets", "Project assets");
 *   - the token history: "{name} history" (main-sanitized name, else the
 *     sanitized symbol, else the truncated address), Portfolio always, plus
 *     the register it was opened from, whose crumb goes back to THAT scope
 *     with a null origin, never the global register.
 */

import { describe, expect, it } from "vitest";
import type { ShellRoute, ShellRouteReturnTo } from "../../../../stores/uiStore/shell-route.js";
import { PORTFOLIO_CRUMB, UNNAMED_TOKEN, titleBarPageOf, tokenDisplayName } from "../page-crumbs.js";

const SESSION = "00000000-0000-4000-8000-0000000000aa";
const PROJECT = "00000000-0000-4000-8000-0000000000bb";
const TOKEN = {
  chainId: 8453,
  tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  symbol: "USDC",
  tokenName: "USD Coin",
} as const;

function history(returnTo: ShellRouteReturnTo): ShellRoute {
  return { kind: "tokenHistory", origin: null, token: TOKEN, returnTo };
}

describe("titleBarPageOf", () => {
  it("is null with no page open, and a top-level page has no parents", () => {
    expect(titleBarPageOf({ kind: "none" })).toBeNull();
    for (const [kind, name] of [
      ["memory", "Memory"],
      ["sessions", "Sessions"],
      ["howItWorks", "How Vex works"],
      ["portfolio", "Portfolio"],
      ["board", "Board"],
      ["needsYou", "Needs you"],
    ] as const) {
      expect(titleBarPageOf({ kind, origin: null })).toEqual({ name, parents: [] });
    }
    expect(titleBarPageOf({ kind: "settings", origin: null, section: "wallets" })).toEqual({
      name: "Settings",
      parents: [],
    });
  });

  it("puts Agent Scan and All assets under Portfolio, and names a narrowed register by its scope", () => {
    expect(titleBarPageOf({ kind: "agentScan", origin: null, sessionId: null })).toEqual({
      name: "Agent Scan",
      parents: [PORTFOLIO_CRUMB],
    });
    expect(titleBarPageOf({ kind: "assets", origin: null, sessionId: null })?.name).toBe("All assets");
    expect(titleBarPageOf({ kind: "assets", origin: null, sessionId: SESSION })?.name).toBe(
      "Session assets",
    );
    expect(titleBarPageOf({ kind: "assets", origin: null, projectId: PROJECT })).toEqual({
      name: "Project assets",
      parents: [PORTFOLIO_CRUMB],
    });
  });

  it("names the token history by the token, under Portfolio alone when opened from the shell", () => {
    expect(titleBarPageOf(history({ kind: "shell" }))).toEqual({
      name: "USD Coin history",
      parents: [PORTFOLIO_CRUMB],
    });
  });

  it("adds the register a token history was opened from, going back to THAT scope with a null origin", () => {
    expect(titleBarPageOf(history({ kind: "assets", sessionId: null }))?.parents).toEqual([
      PORTFOLIO_CRUMB,
      { label: "All assets", route: { kind: "assets", origin: null, sessionId: null } },
    ]);
    expect(titleBarPageOf(history({ kind: "assets", sessionId: SESSION }))?.parents[1]).toEqual({
      label: "Session assets",
      route: { kind: "assets", origin: null, sessionId: SESSION },
    });
    expect(titleBarPageOf(history({ kind: "assets", projectId: PROJECT }))?.parents[1]).toEqual({
      label: "Project assets",
      route: { kind: "assets", origin: null, projectId: PROJECT },
    });
  });
});

describe("tokenDisplayName", () => {
  it("prefers the sanitized name, then the sanitized symbol, then the truncated address", () => {
    expect(tokenDisplayName(TOKEN)).toBe("USD Coin");
    expect(tokenDisplayName({ ...TOKEN, tokenName: null })).toBe("USDC");
    const bare = tokenDisplayName({ ...TOKEN, tokenName: null, symbol: null });
    expect(bare).not.toBe(TOKEN.tokenAddress);
    expect(bare.startsWith("0x8335")).toBe(true);
  });
});

describe("a malformed route never throws in the title bar", () => {
  it("names a missing or empty token identity honestly", () => {
    expect(UNNAMED_TOKEN).toBe("Token");
    expect(tokenDisplayName(undefined)).toBe("Token");
    expect(tokenDisplayName(null)).toBe("Token");
    expect(
      tokenDisplayName({ chainId: 1, tokenAddress: "", symbol: null, tokenName: null }),
    ).toBe("Token");
    expect(
      tokenDisplayName({ chainId: 1, tokenAddress: "0xabc", symbol: null, tokenName: null }),
    ).toBe("0xabc");
  });

  it("a token history route without its token or its return point reads as a Portfolio subpage", () => {
    const malformed = { kind: "tokenHistory", origin: null } as unknown as ShellRoute;
    expect(() => titleBarPageOf(malformed)).not.toThrow();
    expect(titleBarPageOf(malformed)).toEqual({ name: "Token history", parents: [PORTFOLIO_CRUMB] });
  });
});
