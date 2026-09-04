/**
 * The AGENT SCAN route's scope algebra (`uiStore/shell-route.ts`).
 *
 * A shell route is the only thing standing between "the user opened the
 * Activity card of one project" and a screen that reads every wallet Vex
 * knows. So the two properties pinned here are the two ways that can go wrong:
 *
 *  1. RESOLUTION IS TOTAL AND NARROW. Every reachable route resolves to
 *     exactly the scope it was opened with, and a route with no id resolves to
 *     `global` deliberately - never as a fallback that a missing project id
 *     could reach by accident.
 *  2. IDENTITY IS DISTINCT. The scope key is what `ShellScreens` remounts on;
 *     two different scopes sharing a key would hand a project's screen the
 *     filter state of the session before it.
 *
 * The mutual exclusion itself is a TYPE property and the COMPILER is its guard,
 * not an assertion here: the route union has an arm for a session and an arm
 * for a project and none carrying both, so a call site that tried to build that
 * request fails the renderer typecheck. A runtime test could only re-state it
 * through a suppression comment, which the repository's test-escape gate
 * rejects and which proves less than the compiler already does.
 */

import { describe, expect, it } from "vitest";
import {
  agentScanRouteScope,
  agentScanScopeKey,
  GLOBAL_AGENT_SCAN_SCOPE,
  type ShellRoute,
} from "../uiStore/shell-route.js";

const SESSION = "11111111-2222-4333-8444-555555555555";
const PROJECT = "33333333-4444-4555-8666-777777777777";
const ORIGIN = { x: 1, y: 2, width: 3, height: 4 };

type AgentScanRoute = Extract<ShellRoute, { kind: "agentScan" }>;

describe("agentScanRouteScope", () => {
  it("resolves a bare route to the GLOBAL feed", () => {
    const route: AgentScanRoute = { kind: "agentScan", origin: null, sessionId: null };
    expect(agentScanRouteScope(route)).toEqual({ kind: "global" });
    expect(agentScanRouteScope(route)).toBe(GLOBAL_AGENT_SCAN_SCOPE);
  });

  it("resolves a session route to that session, and nothing wider", () => {
    const route: AgentScanRoute = {
      kind: "agentScan",
      origin: ORIGIN,
      sessionId: SESSION,
    };
    expect(agentScanRouteScope(route)).toEqual({
      kind: "session",
      sessionId: SESSION,
    });
  });

  it("resolves a project route to that project, and nothing wider", () => {
    const route: AgentScanRoute = {
      kind: "agentScan",
      origin: ORIGIN,
      projectId: PROJECT,
    };
    expect(agentScanRouteScope(route)).toEqual({
      kind: "project",
      projectId: PROJECT,
    });
  });
});

describe("agentScanScopeKey", () => {
  it("gives each scope, and each id, its own identity", () => {
    const keys = [
      agentScanScopeKey({ kind: "global" }),
      agentScanScopeKey({ kind: "session", sessionId: SESSION }),
      agentScanScopeKey({ kind: "session", sessionId: PROJECT }),
      agentScanScopeKey({ kind: "project", projectId: PROJECT }),
      agentScanScopeKey({ kind: "project", projectId: SESSION }),
    ];
    // All distinct: a shared key would let one scope's screen reuse another's
    // filter state instead of remounting.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not confuse a session id with the same string as a project id", () => {
    expect(agentScanScopeKey({ kind: "session", sessionId: PROJECT })).not.toBe(
      agentScanScopeKey({ kind: "project", projectId: PROJECT }),
    );
  });
});
