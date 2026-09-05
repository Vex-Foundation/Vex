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
 * PROJECT SCOPE (Studio parity decree, 2026-09-04). `agentScan` AND `assets`
 * can ALSO be narrowed to one Vex Studio project, from the project rail's own
 * Activity and Balances cards. Session and project are mutually exclusive -
 * two arms, not two nullable ids - and `agentScanRouteScope` /
 * `assetsRouteScope` below are the one reader each that turns a route into
 * the closed scope union. The narrowing itself is enforced in MAIN
 * (`agent-scan-db.ts` intersects the project's wallets with the inventory
 * allow-list; the portfolio read's `project` arm resolves the project's own
 * selection); a route only says which read was asked for.
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
 * the All-assets screen was in when the eye was pressed, so a session- or
 * project-scoped register is restored with that same scope - never silently
 * re-minted global. The two `assets` members are the route's own two
 * narrowings (see `ShellRoute`), minus the origin.
 */
export type ShellRouteReturnTo =
  | { readonly kind: "shell" }
  | {
      readonly kind: "assets";
      readonly sessionId: string | null;
      readonly projectId?: undefined;
    }
  | {
      readonly kind: "assets";
      readonly sessionId?: null;
      readonly projectId: string;
    };

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
  /**
   * AGENT SCAN, in its two mutually exclusive narrowings. TWO members rather
   * than one member with two nullable ids: a route carrying BOTH a session and
   * a project is not a scope, and the wire schema
   * (`agentScanFiltersSchema`) refuses it by name - a shape that cannot
   * represent it here is what keeps the renderer from ever constructing that
   * request. Read the scope through `agentScanRouteScope`, never by
   * re-deciding what a null means at each consumer.
   */
  | {
      readonly kind: "agentScan";
      readonly origin: ShellScreenOrigin | null;
      /** `null` = the full global feed; a uuid narrows it to one session. */
      readonly sessionId: string | null;
      readonly projectId?: undefined;
    }
  | {
      readonly kind: "agentScan";
      readonly origin: ShellScreenOrigin | null;
      readonly sessionId?: null;
      /** A uuid narrows the feed to ONE Vex Studio project's own wallets. */
      readonly projectId: string;
    }
  /**
   * ALL ASSETS, in the same two mutually exclusive narrowings as Agent Scan.
   * The project arm is what lets the Studio rail's Balances card offer the
   * same "View all assets" door the session rail has: before it, the route
   * could only say `sessionId: null`, which IS the global aggregate, so a
   * project rail hid the door rather than widen a project's money view to
   * every wallet Vex knows about. Read through `assetsRouteScope`.
   */
  | {
      readonly kind: "assets";
      readonly origin: ShellScreenOrigin | null;
      /** `null` = the global portfolio; a uuid narrows it to one session. */
      readonly sessionId: string | null;
      readonly projectId?: undefined;
    }
  | {
      readonly kind: "assets";
      readonly origin: ShellScreenOrigin | null;
      readonly sessionId?: null;
      /** A uuid narrows the register to ONE Vex Studio project's own wallets. */
      readonly projectId: string;
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

/**
 * WHAT AN OPEN AGENT SCAN SCREEN IS NARROWED TO - the closed union every
 * consumer of the route reads instead of interpreting two nullable ids.
 *
 * It mirrors the wire contract's own narrowings (`agentScanFiltersSchema`:
 * `sessionId` XOR `projectId`, the inventory allow-list applying underneath
 * both), so a member added to one and not the other is a compile error rather
 * than a screen that silently opens the GLOBAL feed. Widening by accident is
 * the failure this type exists to prevent: on an audit surface it shows one
 * project's user every wallet Vex knows about.
 */
export type AgentScanRouteScope =
  | { readonly kind: "global" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "project"; readonly projectId: string };

/** The global feed, hoisted so callers share one frozen literal. */
export const GLOBAL_AGENT_SCAN_SCOPE: AgentScanRouteScope = { kind: "global" };

/**
 * The scope an open Agent Scan route describes.
 *
 * The ONE place a route's ids become a scope. `projectId` is checked FIRST and
 * the two are mutually exclusive by construction, so there is no ordering
 * question and no reachable state in which both are set.
 */
export function agentScanRouteScope(
  route: Extract<ShellRoute, { kind: "agentScan" }>,
): AgentScanRouteScope {
  if (route.projectId !== undefined) {
    return { kind: "project", projectId: route.projectId };
  }
  return route.sessionId === null || route.sessionId === undefined
    ? GLOBAL_AGENT_SCAN_SCOPE
    : { kind: "session", sessionId: route.sessionId };
}

/**
 * The scope's identity for a React `key` and for the screen's own remount
 * decision. Distinct per scope member AND per id: swapping between the global
 * feed, a session preset and a project preset must remount the screen rather
 * than reuse filter state that belonged to another scope.
 */
export function agentScanScopeKey(scope: AgentScanRouteScope): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "session":
      return `session:${scope.sessionId}`;
    case "project":
      return `project:${scope.projectId}`;
  }
}

/**
 * WHAT AN OPEN ALL-ASSETS SCREEN IS NARROWED TO - the same closed union shape
 * as `AgentScanRouteScope`, for the same reason: a consumer reads one scope
 * instead of interpreting two nullable ids, and a member added to the route
 * without a reader here is a compile error rather than a register that
 * silently opens on the GLOBAL portfolio. It is structurally the portfolio
 * cards' own `PortfolioCardScope`, so the screen feeds it to the same
 * `portfolioReadInputFor` mapper the rail's cards use.
 */
export type AssetsRouteScope =
  | { readonly kind: "global" }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "project"; readonly projectId: string };

/** The global register, hoisted so callers share one frozen literal. */
export const GLOBAL_ASSETS_SCOPE: AssetsRouteScope = { kind: "global" };

/**
 * The scope an open All-assets route describes. `projectId` is checked FIRST
 * and the two arms are mutually exclusive by construction.
 */
export function assetsRouteScope(
  route: Extract<ShellRoute, { kind: "assets" }>,
): AssetsRouteScope {
  if (route.projectId !== undefined) {
    return { kind: "project", projectId: route.projectId };
  }
  return route.sessionId === null || route.sessionId === undefined
    ? GLOBAL_ASSETS_SCOPE
    : { kind: "session", sessionId: route.sessionId };
}

/**
 * The All-assets route for a scope - the ONE constructor, so the Balances
 * cards and the token-history return path build the same arm for the same
 * scope. Total over the union: a new scope member fails here, never opens the
 * global register.
 */
export function assetsRouteFor(
  scope: AssetsRouteScope,
  origin: ShellScreenOrigin | null,
): Extract<ShellRoute, { kind: "assets" }> {
  switch (scope.kind) {
    case "global":
      return { kind: "assets", origin, sessionId: null };
    case "session":
      return { kind: "assets", origin, sessionId: scope.sessionId };
    case "project":
      return { kind: "assets", origin, projectId: scope.projectId };
  }
}

/** The `returnTo` that brings a token-history close back to this scope. */
export function assetsReturnToFor(scope: AssetsRouteScope): ShellRouteReturnTo {
  switch (scope.kind) {
    case "global":
      return { kind: "assets", sessionId: null };
    case "session":
      return { kind: "assets", sessionId: scope.sessionId };
    case "project":
      return { kind: "assets", projectId: scope.projectId };
  }
}

/** The scope a token-history `returnTo: assets` carries - the reader's twin. */
export function assetsReturnToScope(
  returnTo: Extract<ShellRouteReturnTo, { kind: "assets" }>,
): AssetsRouteScope {
  if (returnTo.projectId !== undefined) {
    return { kind: "project", projectId: returnTo.projectId };
  }
  return returnTo.sessionId === null || returnTo.sessionId === undefined
    ? GLOBAL_ASSETS_SCOPE
    : { kind: "session", sessionId: returnTo.sessionId };
}

/**
 * The scope's identity for a React `key`: distinct per member AND per id, so
 * swapping between the global register, a session and a project remounts the
 * screen rather than reusing another scope's state.
 */
export function assetsScopeKey(scope: AssetsRouteScope): string {
  switch (scope.kind) {
    case "global":
      return "global";
    case "session":
      return `session:${scope.sessionId}`;
    case "project":
      return `project:${scope.projectId}`;
  }
}
