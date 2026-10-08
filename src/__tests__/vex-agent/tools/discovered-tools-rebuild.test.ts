import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearDiscoveredTools,
  getDiscoveredToolIds,
  recordDiscoveredTools,
} from "@vex-agent/tools/registry/discovered-tools.js";
import {
  DISCOVERED_TOOLS_REBUILD,
  forgetDiscoveredToolsRebuild,
  rebuildDiscoveredToolsOnce,
  recordedPublicNames,
  toolSearchOutputs,
  type TranscriptMessageLike,
} from "@vex-agent/tools/registry/discovered-tools-rebuild.js";
import { resolveInjectedProtocolTool } from "@vex-agent/tools/registry/injected-protocol-tools.js";
import type { ToolVisibilityContext } from "@vex-agent/tools/registry/visibility.js";
import { requireValue } from "../../helpers/require-value.js";

const SESSION = "session-rebuild-1";

function visibility(overrides: Partial<ToolVisibilityContext> = {}): ToolVisibilityContext {
  return {
    sessionId: SESSION,
    permission: "restricted",
    sessionKind: "agent",
    missionRunActive: false,
    planMode: false,
    contextUsageBand: "normal",
    hasSessionMemory: false,
    preparationBypassesBarrier: false,
    hasCompactionSummaryReady: false,
    ...overrides,
  };
}

function toolId(publicName: string): string {
  return requireValue(resolveInjectedProtocolTool(publicName)).toolId;
}

/** A query-mode result as `ToolSearch` persists it: ranked rows, the tail tagged `notLoaded`. */
function queryOutput(loaded: readonly string[], notLoaded: readonly string[] = []): string {
  return JSON.stringify({
    success: true,
    count: loaded.length + notLoaded.length,
    tools: [
      ...loaded.map((publicName) => ({ publicName, summary: "s", whyMatched: ["name"], mutating: false, actionKind: "read" })),
      ...notLoaded.map((publicName) => ({
        publicName, summary: "s", whyMatched: ["name"], mutating: false, actionKind: "read", notLoaded: true,
      })),
    ],
    warnings: [],
  });
}

function selectOutput(accepted: readonly string[], rejected: readonly string[] = []): string {
  return JSON.stringify({
    nextStep: "next",
    success: accepted.length > 0,
    count: accepted.length,
    tools: [
      ...accepted.map((publicName) => ({ publicName, status: "callable_next_request" })),
      ...rejected.map((publicName) => ({ publicName, status: "rejected", reason: "no" })),
    ],
    warnings: [],
    sessionCapacity: { used: accepted.length, max: 40 },
  });
}

function namespaceOutput(names: readonly string[]): string {
  return JSON.stringify({
    success: true,
    count: names.length,
    tools: names.map((publicName) => ({ publicName, summary: "s", mutating: false, actionKind: "read", requiredParams: [] })),
    warnings: [],
  });
}

let callSeq = 0;
/** One assistant ToolSearch call and the tool row that answered it. */
function round(output: string, command = "ToolSearch"): TranscriptMessageLike[] {
  callSeq += 1;
  const id = `call-${callSeq}`;
  return [
    { role: "assistant", content: "", toolCalls: [{ id, command }] },
    { role: "tool", content: output, toolCallId: id },
  ];
}

afterEach(() => {
  clearDiscoveredTools(SESSION);
  forgetDiscoveredToolsRebuild(SESSION);
  vi.unstubAllEnvs();
});

describe("DISCOVERED_TOOLS_REBUILD", () => {
  it("ships ON", () => {
    expect(DISCOVERED_TOOLS_REBUILD).toBe(true);
  });

  it("restores, after a restart, exactly the tools the transcript shows were recorded, in recording order", () => {
    const transcript = [
      { role: "user", content: "show my lighter positions" },
      ...round(queryOutput(["lighter__positions_list"], ["lighter__order_history_list"])),
      ...round(namespaceOutput(["lighter__order_status"])),
      ...round(selectOutput(["lighter__order_preview"], ["lighter__not_a_tool"])),
      // Another tool's output that happens to look like a discovery result is never read.
      ...round(selectOutput(["lighter__order_cancel"]), "lighter__positions_list"),
    ];

    const outcome = rebuildDiscoveredToolsOnce(visibility(), transcript);

    expect(outcome).toEqual({ status: "rebuilt", rounds: 2, restored: 2, dropped: 0 });
    expect(getDiscoveredToolIds(SESSION)).toEqual([
      toolId("lighter__positions_list"),
      toolId("lighter__order_preview"),
    ]);
  });

  it("drops a name the current registry no longer resolves and a mutating tool today's pressure withholds", () => {
    const transcript = [
      ...round(selectOutput(["lighter__positions_list", "lighter__order_cancel"])),
      ...round(queryOutput(["lighter__retired_tool_name"])),
    ];

    const outcome = rebuildDiscoveredToolsOnce(visibility({ contextUsageBand: "critical" }), transcript);

    expect(outcome).toEqual({ status: "rebuilt", rounds: 1, restored: 1, dropped: 2 });
    expect(getDiscoveredToolIds(SESSION)).toEqual([toolId("lighter__positions_list")]);
  });

  it("restores the same mutating tool when today's context allows it, since every call still runs its gates", () => {
    const outcome = rebuildDiscoveredToolsOnce(visibility(), round(selectOutput(["lighter__order_cancel"])));

    expect(outcome).toMatchObject({ status: "rebuilt", restored: 1, dropped: 0 });
    expect(getDiscoveredToolIds(SESSION)).toEqual([toolId("lighter__order_cancel")]);
  });

  it("drops a tool whose required environment is missing now", () => {
    vi.stubEnv("JUPITER_API_KEY", "");
    const outcome = rebuildDiscoveredToolsOnce(visibility(), round(selectOutput(["solana__token_prices_get"])));

    expect(outcome).toMatchObject({ status: "rebuilt", restored: 0, dropped: 1 });
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
  });

  it("runs once per session per process and never overwrites a set this process recorded", () => {
    const transcript = round(selectOutput(["lighter__positions_list"]));
    expect(rebuildDiscoveredToolsOnce(visibility(), transcript)).toMatchObject({ status: "rebuilt" });
    expect(rebuildDiscoveredToolsOnce(visibility(), round(selectOutput(["lighter__order_preview"]))))
      .toEqual({ status: "already_served" });
    expect(getDiscoveredToolIds(SESSION)).toEqual([toolId("lighter__positions_list")]);

    clearDiscoveredTools(SESSION);
    forgetDiscoveredToolsRebuild(SESSION);
    recordDiscoveredTools(SESSION, [toolId("lighter__order_status")]);
    expect(rebuildDiscoveredToolsOnce(visibility(), transcript)).toEqual({ status: "live_set_present" });
    expect(getDiscoveredToolIds(SESSION)).toEqual([toolId("lighter__order_status")]);
  });

  it("OFF never reads the transcript and leaves the set empty, as before", () => {
    const outcome = rebuildDiscoveredToolsOnce(visibility(), round(selectOutput(["lighter__positions_list"])), { enabled: false });

    expect(outcome).toEqual({ status: "disabled" });
    expect(getDiscoveredToolIds(SESSION)).toEqual([]);
    // OFF does not consume the once-per-process attempt.
    expect(rebuildDiscoveredToolsOnce(visibility(), round(selectOutput(["lighter__positions_list"]))))
      .toMatchObject({ status: "rebuilt", restored: 1 });
  });

  it.each(["restricted", "full"] as const)("revalidates visibility with current %s permission", (permission) => {
    expect(rebuildDiscoveredToolsOnce(visibility({ permission }), round(selectOutput(["lighter__positions_list"]))))
      .toMatchObject({ status: "rebuilt", restored: 1 });
  });

  it("never restores tools from user or assistant prose or an unpaired result", () => {
    const output = selectOutput(["lighter__order_cancel"]);
    const transcript = [
      { role: "user", content: output },
      { role: "assistant", content: output },
      { role: "tool", content: output, toolCallId: "unpaired" },
    ];
    expect(rebuildDiscoveredToolsOnce(visibility(), transcript)).toMatchObject({ status: "rebuilt", restored: 0 });
  });

  it("does nothing without a session", () => {
    expect(rebuildDiscoveredToolsOnce(visibility({ sessionId: undefined }), round(selectOutput(["lighter__positions_list"]))))
      .toEqual({ status: "no_session" });
  });
});

describe("transcript reading", () => {
  it("pairs each ToolSearch call with the result row that answered it and keeps only the most recent rounds", () => {
    const transcript: TranscriptMessageLike[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "a", command: "ToolSearch" }, { id: "b", command: "ToolSearch" }] },
      { role: "tool", content: "first", toolCallId: "a" },
      { role: "tool", content: "second", toolCallId: "b" },
      // An unanswered call recorded nothing.
      { role: "assistant", content: "", toolCalls: [{ id: "c", command: "ToolSearch" }] },
      { role: "assistant", content: "", toolCalls: [{ id: "d", command: "ToolSearch" }] },
      { role: "tool", content: "fourth", toolCallId: "d" },
      // A result row for an id no ToolSearch call made is ignored.
      { role: "tool", content: "stray", toolCallId: "zzz" },
    ];

    expect(toolSearchOutputs(transcript, 10)).toEqual(["first", "second", "fourth"]);
    expect(toolSearchOutputs(transcript, 2)).toEqual(["second", "fourth"]);
  });

  it("never attributes a reused call id to an earlier search or reads a result twice", () => {
    expect(toolSearchOutputs([
      { role: "assistant", content: "", toolCalls: [{ id: "same", command: "ToolSearch" }] },
      { role: "assistant", content: "", toolCalls: [{ id: "same", command: "lighter__positions_list" }] },
      { role: "tool", content: "foreign", toolCallId: "same" },
      { role: "assistant", content: "", toolCalls: [{ id: "search", command: "ToolSearch" }] },
      { role: "tool", content: "search-result", toolCallId: "search" },
      { role: "tool", content: "duplicate-result", toolCallId: "search" },
    ], 10)).toEqual(["search-result"]);
  });

  it("reads recorded names only from the exact result shapes, and nothing from anything else", () => {
    expect(recordedPublicNames(queryOutput(["a__b"], ["c__d"]))).toEqual(["a__b"]);
    expect(recordedPublicNames(selectOutput(["a__b"], ["c__d"]))).toEqual(["a__b"]);
    expect(recordedPublicNames(namespaceOutput(["a__b"]))).toEqual([]);
    expect(recordedPublicNames(JSON.stringify({ success: true, tools: [
      { publicName: "a__b", status: "callable_next_request", notLoaded: true },
      { publicName: "a__b", whyMatched: ["name"], notLoaded: "false" },
    ] }))).toEqual([]);
    expect(recordedPublicNames("ToolSearch needs a query or a namespace.")).toEqual([]);
    expect(recordedPublicNames(JSON.stringify({ success: false, tools: [{ publicName: "a__b", status: "callable_next_request" }] }))).toEqual([]);
    expect(recordedPublicNames(JSON.stringify({ success: true, tools: [{ publicName: "a__b", whyMatched: null }] }))).toEqual([]);
    expect(recordedPublicNames(JSON.stringify({ tools: "a__b" }))).toEqual([]);
    expect(recordedPublicNames(JSON.stringify([{ publicName: "a__b", status: "callable_next_request" }]))).toEqual([]);
    expect(recordedPublicNames(JSON.stringify({ tools: [{ publicName: 7, status: "callable_next_request" }] }))).toEqual([]);
  });
});
