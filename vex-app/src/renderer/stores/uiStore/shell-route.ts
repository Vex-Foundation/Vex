/**
 * Shell-screen ROUTE CONTRACT — the discriminated union describing which
 * full-app overlay screen is open and what payload it carries.
 *
 * Split out of `uiStore.ts` (same-named sibling folder, repo-native pattern)
 * when the session-scope arms pushed that file toward the 550-line hard
 * limit. `uiStore.ts` re-exports every name here, so no caller's import
 * changes — this module is the ROUTE TYPES' owner, the store is still the
 * public entry point.
 *
 * SESSION SCOPE (C4). Two screens can be opened either globally (from the
 * welcome Portfolio tab / profile menu) or narrowed to ONE session (from the
 * session rail's cards): `assets` and `agentScan`. Both carry
 * `sessionId: string | null` — `null` is the global read, a uuid narrows it.
 * `agentScan` therefore has its OWN arm rather than sharing the payload-free
 * memory|sessions|howItWorks arm.
 *
 * The token-history screen's `returnTo` is an OBJECT, not a bare string, so a
 * return to the All-assets screen carries the scope it was opened in. A bare
 * `"assets"` string re-minted the GLOBAL screen on close, silently widening a
 * session-scoped register behind the user's back.
 */

/**
 * Viewport rect of the trigger control that opened the current shell screen —
 * the expand-from-trigger anchor for the screen's enter animation. Plain
 * numbers (not a live DOMRect) so the store stays serializable. `null` = no
 * origin (the screen falls back to a centered expand). NOT persisted.
 */
export interface ShellScreenOrigin {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Token identity + display metadata carried by the token-history route.
 * `chainId`/`tokenAddress` are the EXACT query identity (the IPC input schema
 * re-validates them at the boundary); `symbol` is RAW provider text —
 * consumers sanitize before display — and `tokenName` is the main-sanitized
 * display name. Neither symbol nor name is ever a query/cache/auth input.
 */
export interface ShellRouteToken {
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly symbol: string | null;
  readonly tokenName: string | null;
}

/**
 * Where closing the token-history screen returns. `assets` CARRIES the scope
 * the All-assets screen was in when the eye was pressed, so a session-scoped
 * register is restored as session-scoped — never silently re-minted global.
 */
export type ShellRouteReturnTo =
  | { readonly kind: "shell" }
  | { readonly kind: "assets"; readonly sessionId: string | null };

/** The bare-shell return, hoisted so callers share one frozen literal. */
export const RETURN_TO_SHELL: ShellRouteReturnTo = { kind: "shell" };

/**
 * Settings screen sections (Phase 2b — the in-shell Settings rebuild that
 * retired the reconfigure-wizard "Edit infrastructure" entry). Each section
 * hosts the matching wizard step form in back-edit mode. Carried on the
 * `settings` route so callers can deep-link a section (the welcome
 * Portfolio "Add wallet" row lands directly on `wallets`); `null` opens
 * the landing register.
 */
export type SettingsSection =
  | "vault"
  | "wallets"
  | "apiKeys"
  | "model"
  | "memory"
  | "tuning";

/**
 * Full-app overlay screen route (Chronos screens redesign, 2026-07-20;
 * atomised into ONE discriminated union in the token-history round so a
 * screen and its payload can never desync). The center panel is ALWAYS the
 * session panel; Memory, the sessions library and the "How Vex works" article
 * open as payload-free overlays expanding from their profile-menu rows;
 * `agentScan` is the full-history activity feed (global from the profile
 * menu, session-narrowed from the rail's Activity card); `assets` is the
 * All-assets register (global from the welcome Balances card, session-narrowed
 * from the rail's Balances card); `tokenHistory` is the per-token history
 * screen (the eye trigger on a token row), carrying the row's token identity
 * and the surface its close returns to. `none` = no screen open. NOT
 * persisted — launch-ephemeral, like activeSessionId.
 */
export type ShellRoute =
  | { readonly kind: "none" }
  | {
      readonly kind: "memory" | "sessions" | "howItWorks";
      readonly origin: ShellScreenOrigin | null;
    }
  | {
      readonly kind: "agentScan";
      readonly origin: ShellScreenOrigin | null;
      /** `null` = the full global feed; a uuid narrows it to one session. */
      readonly sessionId: string | null;
    }
  | {
      readonly kind: "assets";
      readonly origin: ShellScreenOrigin | null;
      /** `null` = the global portfolio; a uuid narrows it to one session. */
      readonly sessionId: string | null;
    }
  | {
      readonly kind: "settings";
      readonly origin: ShellScreenOrigin | null;
      readonly section: SettingsSection | null;
    }
  | {
      readonly kind: "tokenHistory";
      readonly origin: ShellScreenOrigin | null;
      readonly token: ShellRouteToken;
      readonly returnTo: ShellRouteReturnTo;
    };
