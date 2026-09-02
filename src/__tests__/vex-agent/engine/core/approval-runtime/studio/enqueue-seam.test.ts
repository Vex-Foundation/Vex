/**
 * The Vex Studio ENQUEUE, through the shared seam.
 *
 * The seam's other caller (the turn loop) is pinned unchanged by
 * `approval-enqueue-mission-update-emit.test.ts` and
 * `prepared-action-approval-intent.test.ts`, which this file deliberately does
 * not duplicate. What is proved here is what the Studio lane adds:
 *
 *   - the durable provenance a Studio dispatch is later decided against
 *     (origin, project id, scope version, request digest, dispatch generation)
 *     and the queue row's `source`;
 *   - the emit carries the BACKING SESSION, so the existing global approvals
 *     inbox refreshes through the push it already subscribes to;
 *   - each gate refusal writes NOTHING at all: no queue row, no intent row, no
 *     event. A refused call never existed as an approval, so there is no card
 *     to decide and nothing to clean up.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StudioRuntimeAvailability } from "@vex-agent/mcp/approvals.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import type { MissionUpdateEvent } from "@vex-agent/engine/runtime/mission-bus.js";
import type { ProjectScope } from "@vex-agent/mcp/project-scope.js";
import { buildProjectToolContext } from "@vex-agent/mcp/project-context.js";

const enqueueWith = vi.fn();
const createWith = vi.fn();
const rejectWith = vi.fn();
const updateStatus = vi.fn();
const clientQuery = vi.fn();

vi.mock("@vex-agent/db/repos/approvals.js", () => ({ enqueueWith, rejectWith }));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({ createWith }));
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({ updateStatus }));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: object) => Promise<unknown>) =>
    fn({ query: clientQuery }),
  executeWith: vi.fn().mockResolvedValue(1),
  queryWith: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn().mockResolvedValue(null),
  queryOne: vi.fn().mockResolvedValue(null),
  query: vi.fn().mockResolvedValue([]),
  execute: vi.fn().mockResolvedValue(1),
}));

const { enqueueStudioApprovalIntent } = await import(
  "@vex-agent/mcp/approvals.js"
);
const { missionUpdateBus } = await import(
  "@vex-agent/engine/runtime/mission-bus.js"
);
const { computeStudioAuthorityDigest, buildApprovalToolCall } = await import(
  "@vex-agent/engine/core/approval-runtime/tool-call-envelope.js"
);

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function scope(): ProjectScope {
  return {
    projectId: PROJECT_ID,
    scopeVersion: 4,
    permission: "restricted",
    backingSessionId: SESSION_ID,
    wallets: { evm: null, solana: null },
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  const projectScope = scope();
  const result: ToolResult = {
    success: false,
    output: "approval required",
    pendingApproval: true,
    actionKind: "user_wallet_broadcast",
  };
  return {
    scope: projectScope,
    call: {
      name: "wallet_send",
      args: { network: "solana", amount: "1" },
      toolCallId: "call-1",
    },
    result,
    toolContext: buildProjectToolContext(projectScope),
    readStudioRuntimeAvailability: (): StudioRuntimeAvailability => ({
      available: true,
    }),
    ...overrides,
  };
}

/** Script the gate's three statements: advisory lock, project row, generation. */
function scriptGate(
  project:
    | { scope_version: number; permission: string; deleted_at?: Date | null }
    | undefined,
  generation: string | null,
): void {
  clientQuery.mockReset();
  clientQuery.mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (text.includes("FROM projects")) {
      return {
        // `deleted_at` defaults to null - an ACTIVE project - so every existing
        // case keeps its meaning. The gate reads the column, and a row without
        // it would be treated as deleted (fail closed).
        rows:
          project === undefined
            ? []
            : [{ deleted_at: null, ...project }],
        rowCount: project === undefined ? 0 : 1,
      };
    }
    if (text.includes("studio_runtime_gate")) {
      return {
        rows: generation === null ? [] : [{ dispatch_generation: generation }],
        rowCount: generation === null ? 0 : 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Studio enqueue - a tombstoned project (B0)", () => {
  it("REFUSES and writes nothing", async () => {
    // A soft delete reads exactly like an absent project to this gate: the one
    // question it asks is whether an external agent may still obtain authority
    // under the project, and for a tombstone the answer is no.
    scriptGate(
      {
        scope_version: 4,
        permission: "restricted",
        deleted_at: new Date("2026-08-29T10:00:00.000Z"),
      },
      "7",
    );

    const outcome = await enqueueStudioApprovalIntent(baseInput());

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason).toContain("no longer exists");
    expect(outcome.reason).toContain("no funds moved");
    // NOTHING was written: no intent row, no queue row.
    expect(createWith).not.toHaveBeenCalled();
    expect(enqueueWith).not.toHaveBeenCalled();
  });
});

describe("Studio enqueue - the clear path", () => {
  it("writes origin, project id, scope version, digest, generation and source", async () => {
    scriptGate({ scope_version: 4, permission: "restricted" }, "7");
    const events: MissionUpdateEvent[] = [];
    const off = missionUpdateBus.subscribe((event) => events.push(event));
    let outcome;
    try {
      outcome = await enqueueStudioApprovalIntent(baseInput());
    } finally {
      off();
    }
    expect(outcome.kind).toBe("enqueued");

    const intent = requireRecord(createWith.mock.calls[0]?.[1], "intent insert");
    expect(intent.origin).toBe("studio_mcp");
    expect(intent.projectId).toBe(PROJECT_ID);
    expect(intent.scopeVersionAtEnqueue).toBe(4);
    expect(intent.dispatchGenerationAtEnqueue).toBe("7");
    expect(intent.sessionId).toBe(SESSION_ID);
    // A project has no mission run, so nothing is flipped to paused_approval.
    expect(updateStatus).not.toHaveBeenCalled();

    // The digest is taken over the ENVELOPE that will be dispatched, so
    // recomputing it from the stored value at commit time must agree.
    const queueArgs = enqueueWith.mock.calls[0];
    if (queueArgs === undefined) throw new Error("queue insert was not called");
    const storedEnvelope = requireRecord(queueArgs[2], "stored envelope");
    const storedPreview = requireRecord(intent.previewJson, "stored preview");
    if (typeof intent.expiresAt !== "string") {
      throw new Error("intent expiry was not a string");
    }
    expect(intent.requestDigest).toBe(
      computeStudioAuthorityDigest({
        envelope: storedEnvelope,
        preview: storedPreview,
        expiresAt: intent.expiresAt,
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        scopeVersion: 4,
        permission: "restricted",
      }),
    );
    expect(storedEnvelope).toEqual(
      buildApprovalToolCall("wallet_send", { network: "solana", amount: "1" }),
    );
    // `approval_queue.source` names the surface that asked.
    expect(queueArgs[7]).toBe("studio_mcp");

    // The push carries the backing session, which is what the existing global
    // approvals live-sync subscribes to.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "approval_enqueued",
      sessionId: SESSION_ID,
      missionId: null,
    });
  });

  it("takes the session control lock before it reads the project row", async () => {
    scriptGate({ scope_version: 4, permission: "restricted" }, "7");
    await enqueueStudioApprovalIntent(baseInput());
    const statements = clientQuery.mock.calls.map((c) => String(c[0]));
    const lockAt = statements.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    const projectAt = statements.findIndex((s) => s.includes("FROM projects"));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(projectAt).toBeGreaterThan(lockAt);
    // The project row is held only for reading, so concurrent enqueues for one
    // project do not serialize behind each other.
    expect(statements[projectAt]).toContain("FOR SHARE");
    const generationAt = statements.findIndex((s) =>
      s.includes("studio_runtime_gate"),
    );
    expect(generationAt).toBeGreaterThan(projectAt);
    expect(statements[generationAt]).toContain("FOR SHARE");
  });
});

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("Studio enqueue - the gate refuses", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly project: { scope_version: number; permission: string } | undefined;
    readonly generation: string | null;
    readonly unlocked: boolean;
    readonly matches: RegExp;
  }> = [
    {
      name: "the project no longer exists",
      project: undefined,
      generation: "7",
      unlocked: true,
      matches: /no longer exists/i,
    },
    {
      name: "the project scope moved since admission",
      project: { scope_version: 5, permission: "restricted" },
      generation: "7",
      unlocked: true,
      matches: /changed while this call was being prepared/i,
    },
    {
      name: "Vex is locked",
      project: { scope_version: 4, permission: "restricted" },
      generation: "7",
      unlocked: false,
      matches: /Vex is locked/i,
    },
    {
      name: "the dispatch gate row is unreadable",
      project: { scope_version: 4, permission: "restricted" },
      generation: null,
      unlocked: true,
      matches: /dispatchable state/i,
    },
  ];

  for (const testCase of cases) {
    it(`refuses and writes nothing when ${testCase.name}`, async () => {
      scriptGate(testCase.project, testCase.generation);
      const listener = vi.fn();
      const off = missionUpdateBus.subscribe(listener);
      let outcome;
      try {
        outcome = await enqueueStudioApprovalIntent(
          baseInput({
            // Main owns the sentence, so the case supplies it exactly as the
            // main-process reader would: an engine that invented one could not
            // tell "locked" from "starting" from "shutting down".
            readStudioRuntimeAvailability: (): StudioRuntimeAvailability =>
              testCase.unlocked
                ? { available: true }
                : {
                    available: false,
                    reason:
                      "Vex is locked, so it will not hold an approval for this "
                      + "action. Nothing was executed and no funds moved. Unlock "
                      + "Vex and call the tool again.",
                  },
          }),
        );
      } finally {
        off();
      }
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;
      expect(outcome.reason).toMatch(testCase.matches);
      // Every refusal says what did not happen.
      expect(outcome.reason).toMatch(/Nothing was executed/i);
      expect(enqueueWith).not.toHaveBeenCalled();
      expect(createWith).not.toHaveBeenCalled();
      expect(rejectWith).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });
  }

  it("refuses a tool that declared no actionKind instead of throwing", async () => {
    scriptGate({ scope_version: 4, permission: "restricted" }, "7");
    const outcome = await enqueueStudioApprovalIntent(
      baseInput({
        result: { success: false, output: "x", pendingApproval: true },
      }),
    );
    expect(outcome.kind).toBe("refused");
    expect(enqueueWith).not.toHaveBeenCalled();
  });
});
