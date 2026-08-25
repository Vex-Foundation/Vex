import { describe, expect, it, vi } from "vitest";

import { readAllRhcWithdrawalHistory } from "@tools/lighter/withdrawal/rhc-preflight.js";
import { readAllCoreWithdrawalHistory } from "@tools/lighter/withdrawal/core-preflight.js";
import type { LighterWithdrawHistoryResponse } from "@tools/lighter/types.js";

const AUTH = { token: "privileged-token", accountIndex: 42 };

function response(overrides: Partial<LighterWithdrawHistoryResponse> = {}): LighterWithdrawHistoryResponse {
  return { code: 200, withdraws: [], cursor: "", ...overrides };
}

describe.each([
  ["RHC", readAllRhcWithdrawalHistory],
  ["Core", readAllCoreWithdrawalHistory],
] as const)("%s withdrawal history pagination", (_label, readAll) => {
  it("terminates cleanly on an empty cursor", async () => {
    const getWithdrawHistory = vi.fn(async () => response({ cursor: "" }));
    const rows = await readAll({ getWithdrawHistory }, 42, AUTH);
    expect(rows).toEqual([]);
    expect(getWithdrawHistory).toHaveBeenCalledTimes(1);
  });

  it("terminates cleanly when a repeated cursor carries no new rows (no withdrawal history yet)", async () => {
    const getWithdrawHistory = vi.fn(async () => response({ cursor: "same-cursor", withdraws: [] }));
    const rows = await readAll({ getWithdrawHistory }, 42, AUTH);
    expect(rows).toEqual([]);
    // First call establishes the cursor, second call sees it repeat with no new rows and stops.
    expect(getWithdrawHistory).toHaveBeenCalledTimes(2);
  });

  it("still fails closed when a repeated cursor keeps returning new rows", async () => {
    const item = { id: "w1", amount: "1.0", timestamp: 1, status: "completed" as const, type: "secure" as const, l1_tx_hash: "0xabc", asset_id: 3 };
    const getWithdrawHistory = vi.fn(async () => response({ cursor: "same-cursor", withdraws: [item] }));
    await expect(readAll({ getWithdrawHistory }, 42, AUTH)).rejects.toThrow(/repeated cursor/);
  });
});
