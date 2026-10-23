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
 * A check that proves the withdrawal was not created resolves its record; a
 * check main answers with "no such proposal" keeps it (lost, blocking a
 * duplicate review) until the user dismisses it; a refused check keeps it.
 * Submit and claim results are published under React StrictMode.
 * A backend outage (the account read fails) still shows the stored auto
 * top-up rule with working Pause and Revoke and a disabled Edit with its
 * reason.
 */

import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VexCloudAccount, VexCloudAccountResult, VexCloudDepositPin } from "@shared/schemas/vex-cloud.js";
import type { VexCloudDepositProposal, VexCloudWithdrawalProposal } from "@shared/schemas/vex-cloud-funding.js";
import type { Result } from "@shared/ipc/result.js";
import { VexCloudFundingPage } from "../VexCloudFundingScreen.js";
import { SPENDING_CHANGES_NEED_ACCOUNT } from "../AutoTopUpTab.js";
import { SENDER_NOT_LINKED } from "../DepositTab.js";
import { DISMISS_LOST, LOST_UNRESOLVED_DETAIL, OUTCOME_UNKNOWN_DETAIL, UNRESOLVED_BLOCKS_REVIEW } from "../WithdrawTab.js";
import { CLAIM_STATUS_UNKNOWN } from "../CashbackTab.js";
import { useUnresolvedWithdrawals } from "../unresolved-withdrawals.js";
import { useUiStore } from "../../../../stores/uiStore.js";

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
  account: vi.fn<() => Promise<Result<VexCloudAccountResult>>>(),
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
  alertGet: vi.fn(),
  alertSet: vi.fn(),
  autoTopUpGet: vi.fn(),
  prepareAutoTopUp: vi.fn(),
  submitAutoTopUp: vi.fn(),
  cancelWithdrawal: vi.fn(),
  withdrawalNotices: vi.fn(),
  dismissWithdrawalNotice: vi.fn(),
};

function renderPage(options: { readonly strict?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const page = (
    <QueryClientProvider client={client}>
      <VexCloudFundingPage />
    </QueryClientProvider>
  );
  // StrictMode runs every effect's setup, cleanup and setup again, as the app's entry does in development.
  return render(options.strict === true ? <StrictMode>{page}</StrictMode> : page);
}

beforeEach(() => {
  useUnresolvedWithdrawals.setState({ records: [] });
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.account.mockResolvedValue(signedIn());
  bridge.alertGet.mockResolvedValue({ ok: true, data: { alertPercent: 20, observation: null } });
  bridge.autoTopUpGet.mockReturnValue({ promise: Promise.resolve({ ok: true, data: { rule: null } }), cancel: vi.fn() });
  bridge.withdrawalNotices.mockReturnValue({ promise: Promise.resolve({ ok: true, data: { state: "signed_in", notices: [], complete: true, checkedAt: NOW } }), cancel: vi.fn() });
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
    expect(screen.getByText("Checking Vex Inference")).toBeTruthy();
  });

  it("signed out points at Settings and offers no form", async () => {
    bridge.account.mockResolvedValue({ ok: true, data: { state: "signed_out", reason: "not_signed_in", localWallets: [W1] } });
    renderPage();
    expect(await screen.findByText("Sign in to Vex Inference first.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Vex Inference settings" }));
    // Settings, Inference, with the Vex Inference account shown.
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "settings",
      origin: null,
      section: "inference",
      inferenceProvider: "vexcloud",
    });
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("the four tabs in order", async () => {
    renderPage();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Deposit", "Withdraw", "Cashback", "Auto top-up", "History"]);
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

describe("a backend outage (the account read fails)", () => {
  const OUTAGE = { code: "provider.unavailable", domain: "vexCloud", message: "Vex Inference could not be reached.", retryable: true, userActionable: true, redacted: true, correlationId: "c-outage" } as const;
  const storedRule = {
    ruleId: "vxrule-00000000-0000-4000-8000-000000000001",
    version: 1,
    state: "suspended" as const,
    suspendedReason: "balance_read_failing",
    sourceWallet: W1,
    amountWei: String(6_000n * E18),
    maxPerDay: 2,
    monthlyCapWei: String(12_000n * E18),
    maxNetworkFeeWei: "100000000000000",
    trigger: "below_alert_percent" as const,
    expiresAt: "2026-11-20T12:00:00.000Z",
    approvedAt: NOW,
    usedLast24Hours: 0,
    usedLast30DaysWei: "0",
    recentExecutions: [],
  };

  it("the stored rule is still shown with working Pause and Revoke; Edit is disabled with the reason; no other tab is offered", async () => {
    bridge.account.mockResolvedValue({ ok: false, error: OUTAGE });
    bridge.autoTopUpGet.mockReturnValue({ promise: Promise.resolve({ ok: true, data: { rule: storedRule } }), cancel: vi.fn() });
    bridge.prepareAutoTopUp.mockReturnValue({ promise: Promise.resolve({ ok: false, error: OUTAGE }), cancel: vi.fn() });
    renderPage();
    const page = await screen.findByTestId("funding-page-unavailable");
    expect(within(page).getByText("Vex Inference could not be read.")).toBeTruthy();
    const summary = await within(page).findByTestId("rule-summary");
    expect(within(summary).getByText("Suspended: Balance cannot be read")).toBeTruthy();
    expect(within(summary).getByRole("button", { name: "Edit" }).hasAttribute("disabled")).toBe(true);
    expect(within(summary).getByText(SPENDING_CHANGES_NEED_ACCOUNT)).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    for (const [name, action] of [["Pause", "pause"], ["Revoke", "revoke"]] as const) {
      const button = within(summary).getByRole("button", { name });
      expect(button.hasAttribute("disabled")).toBe(false);
      fireEvent.click(button);
      expect(bridge.prepareAutoTopUp).toHaveBeenLastCalledWith({ action, ruleId: storedRule.ruleId, expectedVersion: 1 });
      await waitFor(() => expect(within(summary).getByRole("button", { name }).hasAttribute("disabled")).toBe(false));
    }
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
    expect(within(card).getByText("Deposit 6,000 VEX to Vex Inference.")).toBeTruthy();
    expect(within(card).getAllByText(DEPOSIT).length).toBeGreaterThan(0);
    expect(within(card).getByText("0.0000072 ETH")).toBeTruthy();
    const buttons = within(card).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Reject", "Approve deposit"]);
    await waitFor(() => expect(document.activeElement).toBe(buttons[0]));

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
    coolingSeconds: 43_200,
    preparedAt: NOW,
    expiresAt: "2026-10-21T12:05:00.000Z",
  };

  async function openWithdraw(options: { readonly strict?: boolean } = {}): Promise<void> {
    renderPage(options);
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
      data: { outcome: "accepted", withdrawal: { id: "wd_1", status: "broadcast", amountWei: PROPOSAL.amountWei, destination: W1, txHash: null, createdAt: NOW, updatedAt: NOW, releaseAt: null, cancellable: false } },
    });
    bridge.withdrawal.mockReturnValue(new Promise(() => undefined));
    await openWithdraw();
    fireEvent.change(await screen.findByLabelText("You withdraw"), { target: { value: "11000" } });
    expect(screen.getByTestId("withdraw-disabled-reason").textContent).toBe("That is more than can be withdrawn now (10,000 VEX).");
    fireEvent.change(screen.getByLabelText("You withdraw"), { target: { value: "6000" } });
    fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
    expect(bridge.prepareWithdrawal).toHaveBeenCalledWith({ destination: W1, amountText: "6000" });
    const card = await screen.findByTestId("withdraw-approval");
    expect(within(card).getByText("Funds leave Vex Inference:")).toBeTruthy();
    expect(within(card).getAllByText(W1).length).toBeGreaterThan(0);
    expect(within(card).getByText("Not available")).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Reject"));
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
    await waitFor(() => expect(document.activeElement).toBe(reject));
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
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Check status"));
  });

  it("Check status replays the SAME proposal and shows the withdrawal once Vex Cloud answers", async () => {
    await approveInto(UNKNOWN);
    bridge.submitWithdrawal.mockResolvedValueOnce({
      ok: true,
      data: { outcome: "accepted", withdrawal: { id: "wd_1", status: "debited", amountWei: PROPOSAL.amountWei, destination: W1, txHash: null, createdAt: NOW, updatedAt: NOW, releaseAt: null, cancellable: false } },
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

  const ACCEPTED = {
    ok: true,
    data: { outcome: "accepted", withdrawal: { id: "wd_1", status: "debited", amountWei: PROPOSAL.amountWei, destination: W1, txHash: null, createdAt: NOW, updatedAt: NOW, releaseAt: null, cancellable: false } },
  };

  it("under StrictMode a submit result is still published (the effect setup restores mounted)", async () => {
    bridge.prepareWithdrawal.mockReturnValue({ promise: Promise.resolve({ ok: true, data: PROPOSAL }), cancel: vi.fn() });
    bridge.submitWithdrawal.mockResolvedValueOnce(ACCEPTED);
    bridge.withdrawal.mockReturnValue(new Promise(() => undefined));
    await openWithdraw({ strict: true });
    fireEvent.change(await screen.findByLabelText("You withdraw"), { target: { value: "6000" } });
    fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
    fireEvent.click(within(await screen.findByTestId("withdraw-approval")).getByRole("button", { name: "Approve withdrawal" }));
    expect(await screen.findByTestId("withdraw-status")).toBeTruthy();
  });

  it("a check that proves the withdrawal was not created resolves the record and says why", async () => {
    await approveInto(UNKNOWN);
    bridge.submitWithdrawal.mockResolvedValueOnce({
      ok: true,
      data: { outcome: "not_created", proposalId: PROPOSAL.proposalId, detail: "That is more than can be withdrawn now. Nothing was moved." },
    });
    fireEvent.click(within(await screen.findByTestId("withdraw-outcome-unknown")).getByRole("button", { name: "Check status" }));
    expect((await screen.findByTestId("withdraw-message")).textContent).toBe(
      "Vex Inference did not create this withdrawal. That is more than can be withdrawn now. Nothing was moved.",
    );
    expect(useUnresolvedWithdrawals.getState().records).toEqual([]);
    expect(screen.queryByTestId("withdraw-unresolved-row")).toBeNull();
  });

  it("a check main answers with no such proposal keeps the record, says so, keeps blocking a duplicate, and leaves only on dismiss", async () => {
    await approveInto(UNKNOWN);
    bridge.submitWithdrawal.mockResolvedValueOnce({
      ok: false,
      error: { code: "approvals.already_resolved", domain: "vexCloud", message: "This withdrawal was already sent, cancelled or never prepared.", retryable: true, userActionable: true, redacted: true, correlationId: "c" },
    });
    fireEvent.click(within(await screen.findByTestId("withdraw-outcome-unknown")).getByRole("button", { name: "Check status" }));
    const row = await screen.findByTestId("withdraw-unresolved-row");
    expect(within(row).getByTestId("withdraw-unresolved-lost").textContent).toBe(LOST_UNRESOLVED_DETAIL);
    expect(within(row).queryByRole("button", { name: "Check status" })).toBeNull();
    expect(useUnresolvedWithdrawals.getState().records).toEqual([
      { proposalId: PROPOSAL.proposalId, amountWei: PROPOSAL.amountWei, destination: W1, lost: true },
    ]);
    fireEvent.change(screen.getByLabelText("You withdraw"), { target: { value: "6000" } });
    expect(screen.getByTestId("withdraw-disabled-reason").textContent).toBe(UNRESOLVED_BLOCKS_REVIEW);
    fireEvent.click(within(row).getByRole("button", { name: DISMISS_LOST }));
    expect(useUnresolvedWithdrawals.getState().records).toEqual([]);
    expect(screen.getByTestId("withdraw-disabled-reason").textContent).toBe("");
  });

  it("a refused check (session expired) keeps the record and shows why the check failed", async () => {
    await approveInto(UNKNOWN);
    const text = "Your Vex Cloud session expired, so Vex could not check this withdrawal. Vex still holds the same request: sign in again under Settings, Vex Cloud, then press Check status. Do not send it again.";
    bridge.submitWithdrawal.mockResolvedValueOnce({
      ok: false,
      error: { code: "permissions.denied", domain: "vexCloud", message: text, retryable: false, userActionable: true, redacted: true, correlationId: "c" },
    });
    fireEvent.click(within(await screen.findByTestId("withdraw-outcome-unknown")).getByRole("button", { name: "Check status" }));
    expect((await screen.findByTestId("withdraw-check-note")).textContent).toBe(text);
    expect(useUnresolvedWithdrawals.getState().records).toEqual([{ proposalId: PROPOSAL.proposalId, amountWei: PROPOSAL.amountWei, destination: W1 }]);
  });

  it("Open History from an unknown outcome goes to the History tab", async () => {
    bridge.activity.mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } });
    await approveInto(UNKNOWN);
    fireEvent.click(within(await screen.findByTestId("withdraw-outcome-unknown")).getByRole("button", { name: "Open History" }));
    expect(await screen.findByTestId("history-tab")).toBeTruthy();
  });
  it("the form shows VEX at two decimals and the card keeps every digit (the release capture's 18 decimals)", async () => {
    const ODD = 998_822_910_592_527_374_555n;
    const DAILY = "500123456789012345678";
    bridge.account.mockResolvedValue(
      signedIn(undefined, {
        balances: { ...account().balances, available: amount(ODD, "3700") },
        withdrawable: amount(ODD, "998822"),
        limits: { ...account().limits, minWithdrawMicroUsd: "1000", withdrawDailyRemainingWei: DAILY },
      }),
    );
    bridge.prepareWithdrawal.mockReturnValue({
      promise: Promise.resolve({
        ok: true,
        data: { ...PROPOSAL, amountWei: ODD.toString(), usdMicroEstimate: "998822", withdrawableWei: ODD.toString(), dailyRemainingWei: DAILY, minimumMicroUsd: "1000" },
      }),
      cancel: vi.fn(),
    });
    await openWithdraw();
    const form = await screen.findByTestId("withdraw-form");
    expect(form.textContent).toContain("withdrawable now 998.82 VEX");
    expect(form.textContent).toContain("Daily limit left: 500.12 VEX");
    expect(form.textContent).not.toMatch(/\d\.\d{3,} VEX/);
    // The page's own line: an estimate under a cent is "less than $0.01".
    const top = screen.getByTestId("funding-available").parentElement;
    expect(top?.textContent).toContain("998.82 VEX · less than $0.01 · withdrawable now 998.82 VEX");
    expect(top?.textContent).not.toContain("about less than");

    fireEvent.change(screen.getByLabelText("You withdraw"), { target: { value: "998.822910592527374555" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Review withdrawal" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
    const card = await screen.findByTestId("withdraw-approval");
    expect(within(card).getByText("Withdraw 998.822910592527374555 VEX to your wallet 0x1111…1111.")).toBeTruthy();
    expect(within(card).getByText("500.123456789012345678 VEX")).toBeTruthy();
    expect(card.textContent).toContain("about $0.99");
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
    expect(await screen.findByText("Claimed 12 VEX to your Vex Inference balance.")).toBeTruthy();
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
    expect(await screen.findByText("Claimed 12 VEX to your Vex Inference balance.")).toBeTruthy();
    expect(bridge.claimCashback).toHaveBeenCalledTimes(2);
  });

  it("under StrictMode a claim result is still published", async () => {
    bridge.account.mockResolvedValue(signedIn(undefined, { balances: { ...account().balances, claimable: amount(12n * E18, "12000") } }));
    bridge.claimCashback.mockResolvedValue({ ok: true, data: { outcome: "claimed", claimedWei: String(12n * E18) } });
    renderPage({ strict: true });
    fireEvent.click(await screen.findByRole("tab", { name: "Cashback" }));
    fireEvent.click(await screen.findByRole("button", { name: "Claim to balance" }));
    expect(await screen.findByText("Claimed 12 VEX to your Vex Inference balance.")).toBeTruthy();
  });

  it("a refused check of an unknown claim stays Status unknown, shows why, and still offers Check status", async () => {
    bridge.account.mockResolvedValue(signedIn(undefined, { balances: { ...account().balances, claimable: amount(12n * E18, "12000") } }));
    const text = "Your Vex Cloud session expired, so Vex could not check this cashback claim.";
    bridge.claimCashback.mockResolvedValueOnce({ ok: true, data: { outcome: "unknown" } });
    bridge.claimCashback.mockResolvedValueOnce({
      ok: false,
      error: { code: "permissions.denied", domain: "vexCloud", message: text, retryable: false, userActionable: true, redacted: true, correlationId: "c" },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Cashback" }));
    fireEvent.click(await screen.findByRole("button", { name: "Claim to balance" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check status" }));
    expect((await screen.findByTestId("cashback-check-note")).textContent).toBe(text);
    const outcome = screen.getByTestId("cashback-outcome");
    expect(within(outcome).getByText("Status unknown")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check status" })).toBeTruthy();
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
