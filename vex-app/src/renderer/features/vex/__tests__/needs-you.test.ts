/**
 * Needs you: the item mapping per approval (expiry or since, where it was
 * raised, the action word per tool family) and per mission status, and the
 * model's honest status for a loading, failed or empty inbox, and for a
 * withdrawal check that is loading, failed, incomplete or signed out.
 */

import { describe, expect, it } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { ApprovalPendingGlobalDto } from "@shared/schemas/approvals.js";
import type { MissionRunStatus } from "@shared/schemas/sessions.js";
import {
  APPROVAL_ACTION_WORDS,
  approvalActionWord,
  approvalNeedsYouItem,
  formatNeedsYouTime,
  missionNeedsYouItem,
  NEEDS_YOU_ALL_UNKNOWN_COPY,
  NEEDS_YOU_UNKNOWN_COPY,
  NEEDS_YOU_WITHDRAWALS_INCOMPLETE_COPY,
  NEEDS_YOU_WITHDRAWALS_UNKNOWN_COPY,
  needsYouMetaText,
  needsYouModelOf,
  needsYouWithdrawalReadOf,
  type NeedsYouWithdrawalRead,
} from "../needs-you.js";
import type { VexCloudWithdrawalNotice, VexCloudWithdrawalNoticesResult } from "@shared/schemas/vex-cloud-funding.js";
import { approval, session } from "./fixtures.js";

const NOW = Date.parse("2026-10-17T12:30:00.000Z");

function ok(rows: ApprovalPendingGlobalDto[]): Result<ApprovalPendingGlobalDto[]> {
  return { ok: true, data: rows };
}

const FAILED: Result<ApprovalPendingGlobalDto[]> = {
  ok: false,
  error: {
    code: "internal.unexpected",
    domain: "approvals",
    message: "Could not read approvals.",
    retryable: true,
    userActionable: false,
    redacted: true,
    correlationId: "test",
  },
};

describe("formatNeedsYouTime", () => {
  it("shows the clock and the zone for today", () => {
    expect(formatNeedsYouTime("2026-10-17T15:30:00.000Z", NOW)).toBe("15:30 UTC");
    expect(formatNeedsYouTime("2026-10-17T05:07:00.000Z", NOW)).toBe("05:07 UTC");
  });

  it("adds the date for any other day", () => {
    expect(formatNeedsYouTime("2026-10-12T15:30:00.000Z", NOW)).toBe("Oct 12, 15:30 UTC");
    expect(formatNeedsYouTime("2026-11-02T00:00:00.000Z", NOW)).toBe("Nov 2, 00:00 UTC");
  });

  it("reads an instant with an offset as the same UTC time", () => {
    expect(formatNeedsYouTime("2026-10-17T17:30:00.000+02:00", NOW)).toBe("15:30 UTC");
  });

  it("says nothing for an unparseable value", () => {
    expect(formatNeedsYouTime("soon", NOW)).toBeNull();
  });
});

describe("approvalActionWord", () => {
  const CASES: ReadonlyArray<
    readonly [string, Pick<ApprovalPendingGlobalDto, "toolName" | "preview">, string]
  > = [
    ["a bridge tool name", { toolName: "BridgeExecute", preview: null }, "Approve bridge"],
    [
      "a Relay bridge by namespace",
      {
        toolName: "execute_tool",
        preview: { toolName: "bridge", namespace: "relay", criticalArgs: {} },
      },
      "Approve bridge",
    ],
    [
      "a Lighter order",
      {
        toolName: "order.create",
        preview: { toolName: "order.create", namespace: "lighter", criticalArgs: {} },
      },
      "Approve order",
    ],
    [
      "a Lighter order named only by the wrapper's toolId",
      {
        toolName: "execute_tool",
        preview: {
          toolName: "execute_tool",
          criticalArgs: { toolId: "lighter.order.create" },
        },
      },
      "Approve order",
    ],
    [
      "a Lighter position close",
      {
        toolName: null,
        preview: { toolName: "position.close", namespace: "lighter", criticalArgs: {} },
      },
      "Approve order",
    ],
    [
      "a Lighter deposit",
      {
        toolName: "deposit",
        preview: { toolName: "deposit", namespace: "lighter", criticalArgs: {} },
      },
      "Approve transfer",
    ],
    [
      "a swap execute",
      {
        toolName: "swap.execute",
        preview: { toolName: "swap.execute", namespace: "kyberswap", criticalArgs: {} },
      },
      "Approve swap",
    ],
    [
      "a dotted swap tool id",
      { toolName: "uniswap.swap.execute", preview: null },
      "Approve swap",
    ],
    ["a wallet send", { toolName: "wallet:send", preview: null }, "Approve transfer"],
    [
      "a wallet send by preview",
      {
        toolName: "send",
        preview: { toolName: "send", namespace: "wallet", criticalArgs: {} },
      },
      "Approve transfer",
    ],
    ["the swap alias", { toolName: "SwapExecute", preview: null }, "Approve swap"],
    ["the Uniswap swap alias", { toolName: "SwapExecuteUniswap", preview: null }, "Approve swap"],
    [
      "the wallet send confirm",
      { toolName: "WalletSendConfirm", preview: { toolName: "WalletSendConfirm", criticalArgs: {} } },
      "Approve transfer",
    ],
    [
      "a signed transaction confirm of no named family",
      { toolName: "WalletEvmTransactionConfirm", preview: null },
      "Approve",
    ],
    ["an unnamed tool", { toolName: null, preview: null }, "Approve"],
    ["a tool of no named family", { toolName: "memory_write", preview: null }, "Approve"],
    [
      "a liquidity tool that only shares a venue name with swaps",
      { toolName: "uniswap.liquidity.add", preview: null },
      "Approve",
    ],
  ];

  it.each(CASES)("%s", (_name, target, expected) => {
    expect(approvalActionWord(target)).toBe(expected);
  });

  it("offers exactly the four named families and the plain word", () => {
    expect(Object.values(APPROVAL_ACTION_WORDS).sort()).toEqual(
      ["Approve", "Approve bridge", "Approve order", "Approve swap", "Approve transfer"].sort(),
    );
  });
});

describe("approvalNeedsYouItem", () => {
  it("names the action, where it was raised and when it expires", () => {
    const row = approval({
      id: "a1",
      toolName: "BridgeExecute",
      sessionTitle: "Treasury chat",
      expiresAt: "2026-10-17T15:30:00.000Z",
    });
    const item = approvalNeedsYouItem(row, NOW);
    expect(item).toMatchObject({
      key: "approval:a1",
      kind: "approval",
      title: "Approve bridge",
      go: "Review",
      where: "Treasury chat",
      sessionId: row.sessionId,
      approvalId: "a1",
      expiresAt: "2026-10-17T15:30:00.000Z",
    });
    expect(needsYouMetaText(item)).toBe("Treasury chat · expires 15:30 UTC");
    expect(item.metaTime).toBe("15:30 UTC");
  });

  it("says since when it waits when there is no expiry", () => {
    const item = approvalNeedsYouItem(
      approval({ expiresAt: null, createdAt: "2026-10-17T12:05:00.000Z" }),
      NOW,
    );
    expect(needsYouMetaText(item)).toBe("Treasury chat · since 12:05 UTC");
  });

  it("uses the date for an expiry on another day", () => {
    const item = approvalNeedsYouItem(
      approval({ expiresAt: "2026-10-18T09:00:00.000Z" }),
      NOW,
    );
    expect(needsYouMetaText(item)).toBe("Treasury chat · expires Oct 18, 09:00 UTC");
  });

  it("names the project for a Studio approval and groups by it", () => {
    const row = approval({
      sessionId: null,
      sessionTitle: null,
      projectId: "00000000-0000-4000-8000-0000000000aa",
      projectName: "payments-api",
      toolName: "wallet:send",
    });
    const item = approvalNeedsYouItem(row, NOW);
    expect(item.where).toBe("payments-api");
    expect(item.groupKey).toBe("project:00000000-0000-4000-8000-0000000000aa");
    expect(item.title).toBe("Approve transfer");
    expect(item.sessionId).toBeNull();
  });

  it("falls back to the same labels the inbox always used", () => {
    expect(approvalNeedsYouItem(approval({ sessionTitle: null }), NOW).where).toBe(
      "Untitled session",
    );
    expect(
      approvalNeedsYouItem(approval({ sessionId: null, sessionTitle: null }), NOW).where,
    ).toBe("Background approval");
    expect(
      approvalNeedsYouItem(approval({ sessionId: null, sessionTitle: null }), NOW).groupKey,
    ).toBe("background");
  });

  it("drops the time rather than print one it cannot read", () => {
    const item = approvalNeedsYouItem(
      approval({ expiresAt: null, createdAt: "not a date" }),
      NOW,
    );
    expect(item.metaTime).toBeNull();
    expect(needsYouMetaText(item)).toBe("Treasury chat");
  });
});

describe("missionNeedsYouItem", () => {
  it("offers Recover for a mission paused on an error", () => {
    const row = session({ title: "Weekly rebalance", missionStatus: "paused_error" });
    const item = missionNeedsYouItem(row);
    expect(item).toMatchObject({
      key: `mission:${row.id}`,
      kind: "recover",
      title: "Recover the mission",
      go: "Recover",
      sessionId: row.id,
      approvalId: null,
    });
    expect(item === null ? null : needsYouMetaText(item)).toBe(
      "Weekly rebalance · paused on an error",
    );
  });

  it("asks to accept the contract and to fill in the form", () => {
    const contract = missionNeedsYouItem(session({ missionStatus: "paused_plan_acceptance" }));
    expect(contract).toMatchObject({ kind: "contract", title: "Accept the contract", go: "Review" });
    expect(contract === null ? null : needsYouMetaText(contract)).toBe(
      "Weekly rebalance · the mission waits for your decision",
    );
    const form = missionNeedsYouItem(session({ missionStatus: "paused_user_form" }));
    expect(form).toMatchObject({ kind: "form", title: "Fill in the form", go: "Open" });
  });

  const NEEDS_NOTHING: readonly (MissionRunStatus | null)[] = [
    null,
    "running",
    "paused_user",
    "paused_wake",
    "paused_approval",
    "completed",
    "failed",
    "stopped",
    "cancelled",
  ];

  it.each(NEEDS_NOTHING)("never lists a mission whose status is %s", (status) => {
    expect(missionNeedsYouItem(session({ missionStatus: status }))).toBeNull();
  });
});

const FOREIGN: VexCloudWithdrawalNotice = {
  withdrawalId: "wd_foreign",
  amountWei: "6000000000000000000000",
  destination: "0x2222222222222222222222222222222222222222",
  releaseAt: "2026-10-18T00:30:00.000Z",
  cancellable: true,
  createdAt: "2026-10-17T12:30:00.000Z",
};

const NOTICES_FAILED: Result<VexCloudWithdrawalNoticesResult> = {
  ok: false,
  error: {
    code: "internal.unexpected",
    domain: "vexCloud",
    message: "Vex Inference could not be reached.",
    retryable: true,
    userActionable: false,
    redacted: true,
    correlationId: "test",
  },
};

describe("needsYouModelOf", () => {
  const CHECKED: NeedsYouWithdrawalRead = { state: "ready", notices: [], complete: true };
  const base = { approvalsErrored: false, sessions: null, withdrawals: CHECKED, nowMs: NOW } as const;

  it("is loading before the first read, with no count to claim", () => {
    expect(needsYouModelOf({ ...base, approvals: undefined })).toEqual({
      status: "loading",
      unknownCopy: null,
      count: null,
      items: [],
    });
  });

  it("is ready and empty only after a read that listed nothing", () => {
    expect(needsYouModelOf({ ...base, approvals: ok([]) })).toEqual({
      status: "ready",
      unknownCopy: null,
      count: 0,
      items: [],
    });
  });

  it("is unknown, never empty, after a failed read", () => {
    expect(needsYouModelOf({ ...base, approvals: FAILED })).toEqual({
      status: "unknown",
      unknownCopy: NEEDS_YOU_UNKNOWN_COPY,
      count: null,
      items: [],
    });
  });

  it("is unknown when the query errored over an earlier empty read", () => {
    const model = needsYouModelOf({ ...base, approvals: ok([]), approvalsErrored: true });
    expect(model.status).toBe("unknown");
    expect(model.count).toBeNull();
  });

  it("keeps the last known rows when a refetch errors over a non-empty read", () => {
    const model = needsYouModelOf({
      ...base,
      approvals: ok([approval(), approval()]),
      approvalsErrored: true,
    });
    expect(model.status).toBe("ready");
    expect(model.count).toBe(2);
  });

  it("lists approvals newest first, then the missions that wait, and counts both", () => {
    const older = approval({ id: "old", createdAt: "2026-10-17T09:00:00.000Z" });
    const newer = approval({ id: "new", createdAt: "2026-10-17T11:00:00.000Z" });
    const recover = session({ missionStatus: "paused_error" });
    const model = needsYouModelOf({
      ...base,
      approvals: ok([older, newer]),
      sessions: [
        session({ missionStatus: "running" }),
        recover,
        session({ missionStatus: "paused_user" }),
        session({ missionStatus: "paused_wake" }),
      ],
    });
    expect(model.status).toBe("ready");
    expect(model.count).toBe(3);
    expect(model.items.map((item) => item.key)).toEqual([
      "approval:new",
      "approval:old",
      `mission:${recover.id}`,
    ]);
  });

  it("still lists the missions that wait when the approvals read failed, without a count", () => {
    const recover = session({ missionStatus: "paused_error" });
    const model = needsYouModelOf({ ...base, approvals: FAILED, sessions: [recover] });
    expect(model.status).toBe("unknown");
    expect(model.count).toBeNull();
    expect(model.items.map((item) => item.kind)).toEqual(["recover"]);
  });

  it("counts a mission that waits even with no approval pending", () => {
    const model = needsYouModelOf({
      ...base,
      approvals: ok([]),
      sessions: [session({ missionStatus: "paused_plan_acceptance" })],
    });
    expect(model.count).toBe(1);
  });

  it("a cancellable withdrawal this app did not start counts, after approvals and before missions, and opens nothing by itself", () => {
    const model = needsYouModelOf({
      ...base,
      approvals: ok([approval()]),
      sessions: [session({ missionStatus: "paused_error" })],
      withdrawals: { state: "ready", notices: [FOREIGN], complete: true },
    });
    expect(model.count).toBe(3);
    expect(model.items.map((item) => item.kind)).toEqual(["approval", "withdrawal", "recover"]);
    expect(model.items[1]).toMatchObject({
      key: "withdrawal:wd_foreign",
      title: "Check a withdrawal you did not start",
      metaLead: "Vex Inference · releases",
      metaTime: "Oct 18, 00:30 UTC",
      go: "Review",
      sessionId: null,
      approvalId: null,
    });
  });
});

describe("the withdrawal check never produces an all-clear it did not verify", () => {
  const approvalsEmpty = { approvals: ok([]), approvalsErrored: false, sessions: null, nowMs: NOW } as const;

  it("a failed withdrawal check over an empty inbox and no waiting mission is unknown, never Nothing needs you", () => {
    const model = needsYouModelOf({ ...approvalsEmpty, withdrawals: { state: "failed", lastKnown: [] } });
    expect(model).toEqual({ status: "unknown", unknownCopy: NEEDS_YOU_WITHDRAWALS_UNKNOWN_COPY, count: null, items: [] });
  });

  it("an incomplete scan (complete: false) is unknown coverage, even with nothing listed", () => {
    const model = needsYouModelOf({ ...approvalsEmpty, withdrawals: { state: "ready", notices: [], complete: false } });
    expect(model).toEqual({ status: "unknown", unknownCopy: NEEDS_YOU_WITHDRAWALS_INCOMPLETE_COPY, count: null, items: [] });
  });

  it("a failed check keeps the notices already shown, listed but uncounted", () => {
    const model = needsYouModelOf({ ...approvalsEmpty, withdrawals: { state: "failed", lastKnown: [FOREIGN] } });
    expect(model.status).toBe("unknown");
    expect(model.count).toBeNull();
    expect(model.items.map((item) => item.key)).toEqual(["withdrawal:wd_foreign"]);
  });

  it("a failed check is unknown even when approvals are pending", () => {
    const model = needsYouModelOf({ ...approvalsEmpty, approvals: ok([approval()]), withdrawals: { state: "failed", lastKnown: [] } });
    expect(model.status).toBe("unknown");
    expect(model.count).toBeNull();
    expect(model.items.map((item) => item.kind)).toEqual(["approval"]);
  });

  it("both checks failed names both", () => {
    const model = needsYouModelOf({ ...approvalsEmpty, approvals: FAILED, withdrawals: { state: "failed", lastKnown: [] } });
    expect(model.unknownCopy).toBe(NEEDS_YOU_ALL_UNKNOWN_COPY);
  });

  it("signed out claims nothing about an account and is not an error: an empty inbox reads Nothing needs you", () => {
    expect(needsYouModelOf({ ...approvalsEmpty, withdrawals: { state: "signed_out" } })).toEqual({
      status: "ready",
      unknownCopy: null,
      count: 0,
      items: [],
    });
  });

  it("a locked vault is a known state like signed out: one approval reads ready with count 1, no unknown copy", () => {
    expect(needsYouModelOf({ ...approvalsEmpty, approvals: ok([approval()]), withdrawals: { state: "locked" } })).toMatchObject({
      status: "ready",
      unknownCopy: null,
      count: 1,
    });
    expect(needsYouModelOf({ ...approvalsEmpty, withdrawals: { state: "locked" } })).toEqual({
      status: "ready",
      unknownCopy: null,
      count: 0,
      items: [],
    });
  });

  it("a withdrawal check still loading keeps the empty inbox from reading as clear", () => {
    const model = needsYouModelOf({ ...approvalsEmpty, withdrawals: { state: "loading" } });
    expect(model.status).toBe("loading");
    expect(model.count).toBeNull();
  });
});

describe("needsYouWithdrawalReadOf", () => {
  const signedIn = (notices: VexCloudWithdrawalNotice[], complete = true): Result<VexCloudWithdrawalNoticesResult> => ({
    ok: true,
    data: { state: "signed_in", notices, complete, checkedAt: "2026-10-17T12:30:00.000Z" },
  });

  it("is loading before the first answer, and failed (with what was known) when the first read threw", () => {
    expect(needsYouWithdrawalReadOf(undefined, false, [])).toEqual({ state: "loading" });
    expect(needsYouWithdrawalReadOf(undefined, true, [FOREIGN])).toEqual({ state: "failed", lastKnown: [FOREIGN] });
  });

  it("a failed Result keeps the last good read's notices", () => {
    expect(needsYouWithdrawalReadOf(NOTICES_FAILED, false, [FOREIGN])).toEqual({ state: "failed", lastKnown: [FOREIGN] });
  });

  it("a refetch that threw over a good read is failed, keeping that read's notices", () => {
    expect(needsYouWithdrawalReadOf(signedIn([FOREIGN]), true, [])).toEqual({ state: "failed", lastKnown: [FOREIGN] });
  });

  it("a refetch that threw over a cached signed out is failed, never signed out", () => {
    expect(needsYouWithdrawalReadOf({ ok: true, data: { state: "signed_out" } }, true, [])).toEqual({ state: "failed", lastKnown: [] });
    expect(needsYouWithdrawalReadOf({ ok: true, data: { state: "signed_out" } }, true, [FOREIGN])).toEqual({ state: "failed", lastKnown: [FOREIGN] });
  });

  it("a locked vault is its own known state and drops the notices held from an earlier read", () => {
    expect(needsYouWithdrawalReadOf({ ok: true, data: { state: "locked" } }, false, [FOREIGN])).toEqual({ state: "locked" });
  });

  it("a failure while unlocked is still failed, never locked or clear", () => {
    expect(needsYouWithdrawalReadOf(NOTICES_FAILED, false, [])).toEqual({ state: "failed", lastKnown: [] });
    expect(needsYouWithdrawalReadOf({ ok: true, data: { state: "locked" } }, true, [])).toEqual({ state: "failed", lastKnown: [] });
  });

  it("carries complete through, and signed out is its own state", () => {
    expect(needsYouWithdrawalReadOf(signedIn([FOREIGN], false), false, [])).toEqual({ state: "ready", notices: [FOREIGN], complete: false });
    expect(needsYouWithdrawalReadOf({ ok: true, data: { state: "signed_out" } }, false, [FOREIGN])).toEqual({ state: "signed_out" });
  });
});
