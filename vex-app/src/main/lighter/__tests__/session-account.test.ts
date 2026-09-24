import { describe, expect, it, vi } from "vitest";
import type { SessionWalletScope } from "../onboarding-checklist.js";
import { resolveLighterSessionAccount } from "../session-account.js";

vi.mock("../onboarding-checklist.js", () => ({ readSessionWalletFromEngine: vi.fn() }));

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const walletScope: SessionWalletScope = {
  walletAddress: WALLET,
  walletResolution: { source: "session", evm: { id: "wallet-1", address: WALLET }, solana: null },
  walletPolicy: { kind: "none" },
};

describe("desk session account ownership", () => {
  it("reads the session wallet and verifies the exact environment's paginated master account", async () => {
    const readSessionWallet = vi.fn().mockResolvedValue(walletScope);
    const getAccountsByL1Address = vi.fn()
      .mockResolvedValueOnce({ code: 200, l1_address: WALLET, sub_accounts: [], next_cursor: "next" })
      .mockResolvedValueOnce({ code: 200, l1_address: WALLET, sub_accounts: [{ account_type: 0, index: 42, l1_address: WALLET }] });

    await expect(resolveLighterSessionAccount({ sessionId: "session-1", environment: "rhc" }, {
      readSessionWallet, client: { getAccountsByL1Address },
    })).resolves.toBe(42);

    expect(readSessionWallet).toHaveBeenCalledWith("session-1");
    expect(getAccountsByL1Address).toHaveBeenNthCalledWith(1, "rhc", { l1Address: WALLET, cursor: undefined });
    expect(getAccountsByL1Address).toHaveBeenNthCalledWith(2, "rhc", { l1Address: WALLET, cursor: "next" });
  });

  it.each(["missing wallet", "foreign account", "multiple accounts"])("refuses %s without choosing another saved account", async (scenario) => {
    const readSessionWallet = scenario === "missing wallet"
      ? vi.fn().mockRejectedValue(new Error("No wallet selected"))
      : vi.fn().mockResolvedValue(walletScope);
    const getAccountsByL1Address = vi.fn().mockResolvedValue({
      code: 200, l1_address: WALLET,
      sub_accounts: scenario === "foreign account"
        ? [{ account_type: 0, index: 42, l1_address: OTHER }]
        : [42, 43].map((index) => ({ account_type: 0, index, l1_address: WALLET })),
    });

    await expect(resolveLighterSessionAccount({ sessionId: "session-1", environment: "rhc" }, {
      readSessionWallet, client: { getAccountsByL1Address },
    })).rejects.toThrow();
    if (scenario === "missing wallet") expect(getAccountsByL1Address).not.toHaveBeenCalled();
  });
});
