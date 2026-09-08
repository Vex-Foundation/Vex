import { afterEach, describe, expect, it, vi } from "vitest";

import { testPoolClient, testQueryResult } from "../../helpers/db-client.js";
import { createApprovedDispatchAbortOwner, revokeApprovedDispatches, setStudioDispatchPreflight } from "@vex-agent/engine/core/approval-runtime/studio/dispatch-preflight.js";

vi.mock("@utils/logger.js", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@vex-agent/db/repos/approvals.js", () => ({ rejectWith: vi.fn() }));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({ markDecisionWith: vi.fn() }));
const { refusePendingStudioIntents } = await import("@vex-agent/engine/core/approval-runtime/studio/refuse.js");
const client = testPoolClient();
client.query.mockImplementation(async () => testQueryResult());
afterEach(() => { setStudioDispatchPreflight(null); vi.clearAllMocks(); });

describe("approved authority sources", () => {
  it.each(["scope_changed", "project_deleted"] as const)("revokes %s even with no pending cards", async (reason) => {
    const target = createApprovedDispatchAbortOwner("project-1"), other = createApprovedDispatchAbortOwner("project-2");
    try {
      await refusePendingStudioIntents(client, { projectId: "project-1" }, reason);
      expect(target.signal.aborted).toBe(true);
      expect(target.signal.reason).toBe(reason);
      expect(other.signal.aborted).toBe(false);
    } finally { target.dispose(); other.dispose(); }
  });
  it.each(["disconnect", "cancelled"] as const)("does not revoke approved authority on client %s", async (reason) => {
    const owner = createApprovedDispatchAbortOwner("project-1");
    try {
      await refusePendingStudioIntents(client, { approvalId: "pending-card" }, reason);
      expect(owner.signal.aborted).toBe(false);
    } finally { owner.dispose(); }
  });
  it.each(["lock", "vex_quit"] as const)("revokes both Studio and resumed app owners on %s", (reason) => {
    const studio = createApprovedDispatchAbortOwner("project-1"), app = createApprovedDispatchAbortOwner(null);
    try {
      revokeApprovedDispatches({ reason });
      expect(studio.signal.reason).toBe(reason);
      expect(app.signal.reason).toBe(reason);
    } finally { studio.dispose(); app.dispose(); }
  });
  it("does not retain disposed owners", () => {
    const owner = createApprovedDispatchAbortOwner("project-1");
    owner.dispose(); owner.dispose();
    revokeApprovedDispatches({ reason: "lock" });
    expect(owner.signal.aborted).toBe(false);
  });
  it("starts refused when the host preflight is closed", () => {
    setStudioDispatchPreflight(() => false);
    const owner = createApprovedDispatchAbortOwner(null);
    try { expect(owner.signal.aborted).toBe(true); } finally { owner.dispose(); }
  });
});
