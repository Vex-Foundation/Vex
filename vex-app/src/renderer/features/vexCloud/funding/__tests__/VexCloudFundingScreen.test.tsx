/**
 * The Vex Cloud funding page against a mocked `window.vex.vexCloud` bridge.
 *
 * Pinned: the page's states (loading, signed out, Deposits open soon, the
 * pin mismatch); every disabled reason is said in words; the deposit form
 * sends the typed TEXT to prepare and the approval card's figures come from
 * the proposal; the card has REAL FUNDS, Reject as the first focus and in
 * the first place, a missing figure reads "Not available", and Approve needs
 * a second press before submit echoes the proposal; withdraw offers only
 * wallets that are linked AND in the app and shows the status as a fill plus
 * a word; cashback says why it cannot claim; history says when more exists.
 * Also: an unlinked wallet is listed but disabled with its reason; a
 * withdrawal whose outcome is unknown has no Reject, offers Check status
 * first, survives Close and blocks a duplicate review; an unknown claim says
 * so; a failed Load more keeps its rows and retries the same cursor.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VexCloudAccount, VexCloudAccountResult, VexCloudDepositPin } from "@shared/schemas/vex-cloud.js";
import type { VexCloudDepositProposal, VexCloudWithdrawalProposal } from "@shared/schemas/vex-cloud-funding.js";
import { VexCloudFundingPage } from "../VexCloudFundingScreen.js";
import { SENDER_NOT_LINKED } from "../DepositTab.js";
import { OUTCOME_UNKNOWN_DETAIL, UNRESOLVED_BLOCKS_REVIEW } from "../WithdrawTab.js";
import { CLAIM_STATUS_UNKNOWN } from "../CashbackTab.js";
import { useUnresolvedWithdrawals } from "../unresolved-withdrawals.js";

const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";
const DEPOSIT = "0x00000000000000000000000000000000000D3905";
const E18 = 10n ** 18n;
const NOW = "2026-10-21T12:00:00.000Z";

function amount(wei: bigint, usd: string | null) {
  return { wei: wei.toString(), decimals: 18 as const, symbol: "VEX" as const, usdMicroEstimate: usd };
}

function account(overrides: Partial<VexCloudAccount> = {}): VexCloudAccount {
  return {
    accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    paused: false,
    wallets: [{ address: W1, linkedAt: NOW }],
    balances: {
      available: amount(20_000n * E18, "20000000"),
      provisional: amount(0n, "0"),
      reserved: amount(0n, "0"),
      pendingWithdrawal: amount(0n, "0"),
      claimable: amount(0n, "0"),
      cashbackPending: amount(3n * E18, "3000"),
    },
    withdrawable: amount(10_000n * E18, "10000000"),
    depositAddress: DEPOSIT,
    limits: {
      minDepositMicroUsd: "5000000",
      minWithdrawMicroUsd: "5000000",
      provisionalCapMicroUsd: "25000000",
      withdrawDailyLimitMicroUsd: "500000000",
      withdrawDailyRemainingWei: null,
    },
    rate: {
      available: true,
      source: "twap",
      observedAt: NOW,
      ageSeconds: 30,
      vexWeiPerMicroUsd: "1000000000000000",
      validUntil: "2026-10-21T12:10:00.000Z",
    },
    readAt: NOW,
    ...overrides,
  };
}

function signedIn(pin: VexCloudDepositPin = { state: "matches", address: DEPOSIT }, overrides: Partial<VexCloudAccount> = {}) {
  return { ok: true as const, data: { state: "signed_in" as const, account: account(overrides), localWallets: [W1, W2], depositPin: pin } };
}

const DEPOSIT_PROPOSAL: VexCloudDepositProposal = {
  proposalId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  actor: "user",
  chainId: 4663,
  token: { address: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", symbol: "VEX", decimals: 18 },
  amountWei: String(6_000n * E18),
  from: W1,
  to: DEPOSIT,
  feeBound: {
    gasLimit: "180000",
    maxFeePerGasWei: "40000000",
    maxPriorityFeePerGasWei: "0",
    maxNetworkFeeWei: "7200000000000",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
  },
  usdMicroEstimate: "6000000",
  minimumWei: String(5_000n * E18),
  minimumMicroUsd: "5000000",
  provisionalCapMicroUsd: "25000000",
  walletVexWei: String(9_000n * E18),
  walletNativeWei: "100000000000000000",
  preparedAt: NOW,
  expiresAt: "2026-10-21T12:02:00.000Z",
};

const bridge = {
  account: vi.fn<() => Promise<{ ok: true; data: VexCloudAccountResult }>>(),
  depositWallets: vi.fn(),
  prepareDeposit: vi.fn(),
  submitDeposit: vi.fn(),
  prepareWithdrawal: vi.fn(),
  submitWithdrawal: vi.fn(),
  withdrawal: vi.fn(),
  claimCashback: vi.fn(),
  activity: vi.fn(),
  usage: vi.fn(),
  deposits: vi.fn(),
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <VexCloudFundingPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useUnresolvedWithdrawals.setState({ records: [] });
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.account.mockResolvedValue(signedIn());
  bridge.depositWallets.mockReturnValue({
    promise: Promise.resolve({
      ok: true,
      data: {
        chainId: 4663,
        wallets: [
          { address: W1, label: "Main", vexWei: String(9_000n * E18) },
          { address: W2, label: "Trading", vexWei: null },
        ],
        readAt: NOW,
      },
    }),
    cancel: vi.fn(),
  });
  Object.defineProperty(window, "vex", { configurable: true, value: { vexCloud: bridge } });
});

afterEach(() => {
  cleanup();
});

async function typeAmount(value: string): Promise<void> {
  const input = await screen.findByLabelText("You send");
  fireEvent.change(input, { target: { value } });
}

describe("page states", () => {
  it("loading is a word, never figures", () => {
    bridge.account.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText("Checking Vex Cloud")).toBeTruthy();
  });

  it("signed out points at Settings and offers no form", async () => {
    bridge.account.mockResolvedValue({ ok: true, data: { state: "signed_out", reason: "not_signed_in", localWallets: [W1] } });
    renderPage();
    expect(await screen.findByText("Sign in to Vex Cloud first.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Vex Cloud settings" })).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("the four tabs in order", async () => {
    renderPage();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Deposit", "Withdraw", "Cashback", "History"]);
  });

  it("Deposits open soon when the build pins no address", async () => {
    bridge.account.mockResolvedValue(signedIn({ state: "not_open" }));
    renderPage();
    expect(await screen.findByText("Deposits open soon")).toBeTruthy();
    expect(screen.queryByLabelText("You send")).toBeNull();
    expect(bridge.depositWallets).not.toHaveBeenCalled();
  });

  it("a pin mismatch disables funding and names both addresses", async () => {
    bridge.account.mockResolvedValue(signedIn({ state: "mismatch", pinned: DEPOSIT, backend: W2 }));
    renderPage();
    expect(await screen.findByText("Funding is disabled")).toBeTruthy();
    expect(screen.getByTestId("deposit-mismatch").textContent).toContain(DEPOSIT);
    expect(screen.getByTestId("deposit-mismatch").textContent).toContain(W2);
    expect(screen.queryByLabelText("You send")).toBeNull();
  });
});

describe("deposit", () => {
  it("says why the key is disabled, in words", async () => {
    renderPage();
    const review = await screen.findByRole("button", { name: "Review deposit" });
    await waitFor(() => expect(screen.getByTestId("deposit-disabled-reason").textContent).toBe("Enter an amount."));
    expect((review as HTMLButtonElement).disabled).toBe(true);
    await typeAmount("100");
    expect(screen.getByTestId("deposit-disabled-reason").textContent).toBe("The minimum is $5.00, about 5,000 VEX.");
    await typeAmount("12000");
    expect(screen.getByTestId("deposit-disabled-reason").textContent).toBe("That is more than this wallet holds (9,000 VEX).");
    await typeAmount("6000");
    expect(screen.getByTestId("deposit-disabled-reason").textContent).toBe("");
    expect(screen.getByText(/about \$6\.00/)).toBeTruthy();
    expect(screen.getAllByText("Spendable now up to $25.00; the rest after about 16 minutes.").length).toBeGreaterThan(0);
    expect(screen.getByTestId("token-chip").textContent).toContain("VEX");
  });

  it("sends the typed text, shows the proposal as an approval card with Reject first, and approves on the second press", async () => {
    bridge.prepareDeposit.mockReturnValue({ promise: Promise.resolve({ ok: true, data: DEPOSIT_PROPOSAL }), cancel: vi.fn() });
    bridge.submitDeposit.mockReturnValue({
      promise: Promise.resolve({ ok: true, data: { status: "pending", txHash: `0x${"ab".repeat(32)}`, transferProven: false, notified: true } }),
      cancel: vi.fn(),
    });
    renderPage();
    await typeAmount("6000");
    fireEvent.click(await screen.findByRole("button", { name: "Review deposit" }));
    expect(bridge.prepareDeposit).toHaveBeenCalledWith({ walletAddress: W1, amountText: "6000" });

    const card = await screen.findByTestId("deposit-approval");
    expect(within(card).getByText("Real funds")).toBeTruthy();
    expect(within(card).getByText("Deposit 6,000 VEX to Vex Cloud.")).toBeTruthy();
    expect(within(card).getAllByText(DEPOSIT).length).toBeGreaterThan(0);
    expect(within(card).getByText("0.0000072 ETH")).toBeTruthy();
    const buttons = within(card).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Reject", "Approve deposit"]);
    expect(document.activeElement).toBe(buttons[0]);

    fireEvent.click(within(card).getByRole("button", { name: "Approve deposit" }));
    expect(bridge.submitDeposit).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Click again to confirm" }));
    expect(bridge.submitDeposit).toHaveBeenCalledWith({
      proposalId: DEPOSIT_PROPOSAL.proposalId,
      walletAddress: W1,
      amountWei: DEPOSIT_PROPOSAL.amountWei,
    });
    expect(await screen.findByText("Sent, awaiting confirmation")).toBeTruthy();
    expect(screen.getByTestId("deposit-outcome").textContent).toContain("Vex will not send it again");
  });

  it("Reject goes back to the form and signs nothing", async () => {
    bridge.prepareDeposit.mockReturnValue({ promise: Promise.resolve({ ok: true, data: DEPOSIT_PROPOSAL }), cancel: vi.fn() });
    renderPage();
    await typeAmount("6000");
    fireEvent.click(await screen.findByRole("button", { name: "Review deposit" }));
    fireEvent.click(within(await screen.findByTestId("deposit-approval")).getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Deposit rejected. Nothing was signed.")).toBeTruthy();
    expect(bridge.submitDeposit).not.toHaveBeenCalled();
  });

  it("a wallet not linked to the account is listed but disabled, with the reason and the next step", async () => {
    renderPage();
    const picker = await screen.findByRole("combobox");
    await waitFor(() => expect(picker.textContent).toContain("Main"));
    fireEvent.click(picker);
    const unlinked = screen.getByRole("option", { name: /Trading/ });
    expect(unlinked.getAttribute("aria-disabled")).toBe("true");
    expect(unlinked.textContent).toContain("not linked");
    fireEvent.click(unlinked);
    expect(screen.getByRole("combobox").textContent).toContain("Main");
    expect(screen.getByTestId("deposit-unlinked").textContent).toContain(`Trading 0x2222…2222: ${SENDER_NOT_LINKED}`);
  });

  it("with no linked wallet the form says why it cannot deposit and offers no review", async () => {
    bridge.account.mockResolvedValue(signedIn(undefined, { wallets: [] }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("deposit-disabled-reason").textContent).toBe(`None of your wallets can deposit yet. ${SENDER_NOT_LINKED}`));
    await typeAmount("6000");
    expect((screen.getByRole("button", { name: "Review deposit" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a refusal from main is shown as main worded it", async () => {
    bridge.prepareDeposit.mockReturnValue({
      promise: Promise.resolve({
        ok: false,
        error: { code: "wallet.policy_blocked", domain: "vexCloud", message: "Funding is disabled: the deposit address built into Vex does not match.", retryable: false, userActionable: false, redacted: true, correlationId: "c" },
      }),
      cancel: vi.fn(),
    });
    renderPage();
    await typeAmount("6000");
    fireEvent.click(await screen.findByRole("button", { name: "Review deposit" }));
    expect((await screen.findByTestId("deposit-message")).textContent).toMatch(/does not match/);
  });
});

describe("withdraw", () => {
  const PROPOSAL: VexCloudWithdrawalProposal = {
    proposalId: "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    actor: "user",
    chainId: 4663,
    amountWei: String(6_000n * E18),
    destination: W1,
    usdMicroEstimate: "6000000",
    minimumWei: String(5_000n * E18),
    minimumMicroUsd: "5000000",
    withdrawableWei: String(10_000n * E18),
    dailyRemainingWei: null,
    dailyLimitMicroUsd: "500000000",
    preparedAt: NOW,
    expiresAt: "2026-10-21T12:05:00.000Z",
  };

  async function openWithdraw(): Promise<void> {
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Withdraw" }));
  }

  it("a backend without a deposit address: Withdrawals are not open yet, no form", async () => {
    bridge.account.mockResolvedValue(signedIn({ state: "not_open" }, { depositAddress: null }));
    await openWithdraw();
    expect(await screen.findByText("Withdrawals are not open yet")).toBeTruthy();
    expect(screen.queryByLabelText("You withdraw")).toBeNull();
  });

  it("no wallet that is both linked and in the app: says so, no form", async () => {
    bridge.account.mockResolvedValue(signedIn(undefined, { wallets: [{ address: "0x3333333333333333333333333333333333333333", linkedAt: NOW }] }));
    await openWithdraw();
    expect(await screen.findByText("No wallet to withdraw to")).toBeTruthy();
  });

  it("the card says the amount, the destination, Funds leave Vex Cloud, and Not available for a missing daily limit", async () => {
    bridge.prepareWithdrawal.mockReturnValue({ promise: Promise.resolve({ ok: true, data: PROPOSAL }), cancel: vi.fn() });
    bridge.submitWithdrawal.mockResolvedValue({
      ok: true,
      data: { outcome: "accepted", withdrawal: { id: "wd_1", status: "broadcast", amountWei: PROPOSAL.amountWei, destination: W1, txHash: null, createdAt: NOW, updatedAt: NOW } },
    });
    bridge.withdrawal.mockReturnValue(new Promise(() => undefined));
    await openWithdraw();
    fireEvent.change(await screen.findByLabelText("You withdraw"), { target: { value: "11000" } });
    expect(screen.getByTestId("withdraw-disabled-reason").textContent).toBe("That is more than can be withdrawn now (10,000 VEX).");
    fireEvent.change(screen.getByLabelText("You withdraw"), { target: { value: "6000" } });
    fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
    expect(bridge.prepareWithdrawal).toHaveBeenCalledWith({ destination: W1, amountText: "6000" });
    const card = await screen.findByTestId("withdraw-approval");
    expect(within(card).getByText("Funds leave Vex Cloud:")).toBeTruthy();
    expect(within(card).getAllByText(W1).length).toBeGreaterThan(0);
    expect(within(card).getByText("Not available")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Reject");
    fireEvent.click(within(card).getByRole("button", { name: "Approve withdrawal" }));
    expect(bridge.submitWithdrawal).toHaveBeenCalledWith({ proposalId: PROPOSAL.proposalId, destination: W1, amountWei: PROPOSAL.amountWei });
    const status = await screen.findByTestId("withdraw-status");
    expect(within(status).getByText("Pending")).toBeTruthy();
  });

  const UNKNOWN = { ok: true, data: { outcome: "unknown", proposalId: PROPOSAL.proposalId, amountWei: PROPOSAL.amountWei, destination: W1 } };

  async function approveInto(answer: unknown): Promise<void> {
    bridge.prepareWithdrawal.mockReturnValue({ promise: Promise.resolve({ ok: true, data: PROPOSAL }), cancel: vi.fn() });
    bridge.submitWithdrawal.mockResolvedValueOnce(answer);
    await openWithdraw();
    fireEvent.change(await screen.findByLabelText("You withdraw"), { target: { value: "6000" } });
    fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
    const card = await screen.findByTestId("withdraw-approval");
    fireEvent.click(within(card).getByRole("button", { name: "Approve withdrawal" }));
  }

  it("reviewing (never submitted): Reject is offered, first in focus, and says nothing was sent", async () => {
    bridge.prepareWithdrawal.mockReturnValue({ promise: Promise.resolve({ ok: true, data: PROPOSAL }), cancel: vi.fn() });
    await openWithdraw();
    fireEvent.change(await screen.findByLabelText("You withdraw"), { target: { value: "6000" } });
    fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
    const card = await screen.findByTestId("withdraw-approval");
    const reject = within(card).getByRole("button", { name: "Reject" });
    expect(document.activeElement).toBe(reject);
    fireEvent.click(reject);
    expect(await screen.findByText("Withdrawal rejected. Nothing was sent.")).toBeTruthy();
    expect(bridge.submitWithdrawal).not.toHaveBeenCalled();
  });

  it("outcome_unknown (submitted, unknown): no Reject, Check status first in focus, and the copy states the uncertainty", async () => {
    await approveInto(UNKNOWN);
    const block = await screen.findByTestId("withdraw-outcome-unknown");
    expect(within(block).getByText("Status unknown")).toBeTruthy();
    expect(block.textContent).toContain(OUTCOME_UNKNOWN_DETAIL);
    expect(block.textContent).not.toMatch(/Nothing was sent/);
    expect(within(block).getAllByRole("button").map((b) => b.textContent)).toEqual(["Check status", "Close", "Open History"]);
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(document.activeElement?.textContent).toBe("Check status");
  });

  it("Check status replays the SAME proposal and shows the withdrawal once Vex Cloud answers", async () => {
    await approveInto(UNKNOWN);
    bridge.submitWithdrawal.mockResolvedValueOnce({
      ok: true,
      data: { outcome: "accepted", withdrawal: { id: "wd_1", status: "debited", amountWei: PROPOSAL.amountWei, destination: W1, txHash: null, createdAt: NOW, updatedAt: NOW } },
    });
    bridge.withdrawal.mockReturnValue(new Promise(() => undefined));
    fireEvent.click(within(await screen.findByTestId("withdraw-outcome-unknown")).getByRole("button", { name: "Check status" }));
    expect(await screen.findByTestId("withdraw-status")).toBeTruthy();
    expect(bridge.submitWithdrawal).toHaveBeenCalledTimes(2);
    expect(bridge.submitWithdrawal.mock.calls[1]).toEqual([{ proposalId: PROPOSAL.proposalId, destination: W1, amountWei: PROPOSAL.amountWei }]);
    expect(useUnresolvedWithdrawals.getState().records).toEqual([]);
  });

  it("Close keeps the record visible as Status unknown, and blocks a new review of the same amount and wallet", async () => {
    await approveInto(UNKNOWN);
    fireEvent.click(within(await screen.findByTestId("withdraw-outcome-unknown")).getByRole("button", { name: "Close" }));
    const row = await screen.findByTestId("withdraw-unresolved-row");
    expect(within(row).getByText("Status unknown")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Check status" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("You withdraw"), { target: { value: "6000" } });
    expect(screen.getByTestId("withdraw-disabled-reason").textContent).toBe(UNRESOLVED_BLOCKS_REVIEW);
    expect((screen.getByRole("button", { name: "Review withdrawal" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("You withdraw"), { target: { value: "7000" } });
    expect(screen.getByTestId("withdraw-disabled-reason").textContent).toBe("");
  });

  it("Open History from an unknown outcome goes to the History tab", async () => {
    bridge.activity.mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } });
    await approveInto(UNKNOWN);
    fireEvent.click(within(await screen.findByTestId("withdraw-outcome-unknown")).getByRole("button", { name: "Open History" }));
    expect(await screen.findByTestId("history-tab")).toBeTruthy();
  });
});

describe("cashback", () => {
  it("says why nothing can be claimed, and shows pending cashback as not claimable", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Cashback" }));
    expect(await screen.findByTestId("cashback-disabled-reason")).toBeTruthy();
    expect(screen.getByTestId("cashback-pending").textContent).toContain("Pending, not claimable yet: 3 VEX");
    expect((screen.getByRole("button", { name: "Claim to balance" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("claims to the balance and says what moved", async () => {
    bridge.account.mockResolvedValue(signedIn(undefined, { balances: { ...account().balances, claimable: amount(12n * E18, "12000") } }));
    bridge.claimCashback.mockResolvedValue({ ok: true, data: { outcome: "claimed", claimedWei: String(12n * E18) } });
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Cashback" }));
    expect((await screen.findByTestId("cashback-claimable")).textContent).toBe("12 VEX");
    fireEvent.click(screen.getByRole("button", { name: "Claim to balance" }));
    expect(await screen.findByText("Claimed 12 VEX to your Vex Cloud balance.")).toBeTruthy();
  });

  it("an unknown claim outcome says so, never Nothing was changed, and offers Check status", async () => {
    bridge.account.mockResolvedValue(signedIn(undefined, { balances: { ...account().balances, claimable: amount(12n * E18, "12000") } }));
    bridge.claimCashback.mockResolvedValueOnce({ ok: true, data: { outcome: "unknown" } });
    bridge.claimCashback.mockResolvedValueOnce({ ok: true, data: { outcome: "claimed", claimedWei: String(12n * E18) } });
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Cashback" }));
    fireEvent.click(await screen.findByRole("button", { name: "Claim to balance" }));
    const outcome = await screen.findByTestId("cashback-outcome");
    expect(within(outcome).getByText("Status unknown")).toBeTruthy();
    expect(outcome.textContent).toContain(CLAIM_STATUS_UNKNOWN);
    expect(outcome.textContent).not.toMatch(/Nothing was changed/);
    fireEvent.click(screen.getByRole("button", { name: "Check status" }));
    expect(await screen.findByText("Claimed 12 VEX to your Vex Cloud balance.")).toBeTruthy();
    expect(bridge.claimCashback).toHaveBeenCalledTimes(2);
  });
});

describe("history", () => {
  it("Load more appears only while more exists, and the foot says so", async () => {
    const row = (id: string) => ({ id, kind: "deposit", amountWei: String(E18), status: "credited", txHash: null, createdAt: NOW });
    bridge.activity
      .mockResolvedValueOnce({ ok: true, data: { items: [row("a"), row("b")], nextCursor: "c_2" } })
      .mockResolvedValueOnce({ ok: true, data: { items: [row("c")], nextCursor: null } });
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "History" }));
    expect((await screen.findByTestId("history-foot")).textContent).toBe("Showing 2 · more available");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getByTestId("history-foot").textContent).toBe("Showing all 3"));
    expect(bridge.activity).toHaveBeenLastCalledWith({ cursor: "c_2" });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("a failed Load more keeps the rows, offers Retry of the same cursor, and never says Showing all", async () => {
    const row = (id: string) => ({ id, kind: "deposit", amountWei: String(E18), status: "credited", txHash: null, createdAt: NOW });
    bridge.activity
      .mockResolvedValueOnce({ ok: true, data: { items: [row("a"), row("b")], nextCursor: "c_2" } })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "provider.unavailable", domain: "vexCloud", message: "Vex Cloud could not be reached.", retryable: true, userActionable: true, redacted: true, correlationId: "c" },
      })
      .mockResolvedValueOnce({ ok: true, data: { items: [row("c")], nextCursor: null } });
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect((await screen.findByTestId("history-next-failed")).textContent).toContain("Vex Cloud could not be reached.");
    expect(screen.getAllByTestId("history-row")).toHaveLength(2);
    expect(screen.getByTestId("history-foot").textContent).toBe("Showing 2 · more available");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("history-foot").textContent).toBe("Showing all 3"));
    expect(bridge.activity.mock.calls.map((call) => call[0])).toEqual([{ cursor: null }, { cursor: "c_2" }, { cursor: "c_2" }]);
    expect(screen.queryByTestId("history-next-failed")).toBeNull();
  });

  it("labels an estimated usage cost as estimated", async () => {
    const row = (requestId: string, status: string) => ({
      requestId,
      model: "deepseek/deepseek-v4",
      effort: "medium",
      status,
      upstreamCostMicroUsd: "1230000",
      chargedWei: String(E18),
      clampReason: null,
      createdAt: NOW,
    });
    bridge.activity.mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } });
    bridge.usage.mockResolvedValue({ ok: true, data: { items: [row("r1", "settled"), row("r2", "settled_estimated"), row("r3", "settled_input_floor")], nextCursor: null } });
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "History" }));
    fireEvent.click(await screen.findByRole("button", { name: "Usage" }));
    const rows = await screen.findAllByTestId("history-row");
    expect(rows.map((r) => r.textContent?.includes("(estimated)"))).toEqual([false, true, true]);
  });

  it("a failed read is said in words, never an empty list", async () => {
    bridge.activity.mockResolvedValue({
      ok: false,
      error: { code: "provider.unavailable", domain: "vexCloud", message: "Vex Cloud could not be reached.", retryable: true, userActionable: true, redacted: true, correlationId: "c" },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "History" }));
    expect(await screen.findByText("Your activity could not be read.")).toBeTruthy();
  });
});
