/**
 * The two tool-context builders every suite should use.
 *
 * Both exist for the same reason: `InternalToolContext` and
 * `ProtocolExecutionContext` are LIVE contracts that gain required fields when
 * the runtime does (`planMode`, `walletResolution`, `walletPolicy` were the
 * most recent). A suite that hand-rolls a context literal does not fail when
 * that happens — vitest never typechecks — so the drift only ever surfaced in
 * the test-type ratchet, dozens of files at a time. Building through these
 * makes the compiler the thing that notices, once, here.
 *
 * `overrides` is `Partial<…>` on purpose: a test states only the fields its
 * assertion depends on, and the defaults below are the least-privilege ones
 * (restricted, unapproved, no mission), so a permission a test needs is a
 * permission it had to ask for out loud.
 */

import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

export function makeTestContext(overrides?: Partial<InternalToolContext>): InternalToolContext {
  return {
    sessionId: "test-session",
    loadedDocuments: new Map<string, string>(),
    sessionPermission: "restricted",
    approved: false,
    planMode: false,
    missionRunId: null,
    missionId: null,
    sessionKind: "agent",
    contextUsageBand: "normal",
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...overrides,
  };
}

export function makeProtocolContext(
  overrides?: Partial<ProtocolExecutionContext>,
): ProtocolExecutionContext {
  return {
    sessionPermission: "restricted",
    approved: false,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...overrides,
  };
}
