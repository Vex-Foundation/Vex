/**
 * The Auto top-up tab against a mocked `window.vex.vexCloud` bridge.
 *
 * Pinned: the tab's states (loading is a word, a failed read offers Try
 * again, closed deposits offer no form, a rule's state is a fill plus a word
 * including "Network fee above your limit"); the form sends the typed text,
 * including the network fee limit prefilled with the measured default; the
 * card shows every bound BEFORE approval (amount, count, cap, network fee
 * limit, trigger, expiry, destination) from the proposal alone, with Reject
 * as the first focus and a second press needed to create; Reject changes
 * nothing; pause and revoke prepare and submit with no rate or minimum
 * (the backend unreachable), the card saying "Not available" for them.
 * With the account unreadable (`account` null): Pause and Revoke still
 * prepare and submit; Edit, Resume and create are disabled or not offered,
 * with the reason in words.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VexCloudAccount } from "@shared/schemas/vex-cloud.js";
import type { VexCloudAutoTopUpProposal, VexCloudAutoTopUpRule } from "@shared/schemas/vex-cloud-auto-top-up.js";
import { AutoTopUpTab, SPENDING_CHANGES_NEED_ACCOUNT } from "../AutoTopUpTab.js";

const W1 = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x00000000000000000000000000000000000D3905";
const E18 = 10n ** 18n;
const NOW = "2026-10-21T12:00:00.000Z";
const RULE_ID = "vxrule-00000000-0000-4000-8000-000000000001";

function account(): VexCloudAccount {
  const amount = (wei: bigint) => ({ wei: wei.toString(), decimals: 18 as const, symbol: "VEX" as const, usdMicroEstimate: "0" });
  return {
    accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    paused: false,
    wallets: [{ address: W1, linkedAt: NOW }],
    balances: { available: amount(0n), provisional: amount(0n), reserved: amount(0n), pendingWithdrawal: amount(0n), claimable: amount(0n), cashbackPending: amount(0n) },
    withdrawable: amount(0n),
    depositAddress: DEPOSIT,
    limits: { minDepositMicroUsd: "5000000", minWithdrawMicroUsd: "5000000", provisionalCapMicroUsd: "25000000", withdrawDailyLimitMicroUsd: "500000000", withdrawDailyRemainingWei: null },
    rate: { available: true, source: "twap", observedAt: NOW, ageSeconds: 30, vexWeiPerMicroUsd: "1000000000000000", validUntil: "2026-10-21T12:10:00.000Z" },
    readAt: NOW,
  };
}

function rule(overrides: Partial<VexCloudAutoTopUpRule> = {}): VexCloudAutoTopUpRule {
  return {
    ruleId: RULE_ID,
    version: 1,
    state: "active",
    suspendedReason: null,
    sourceWallet: W1,
    amountWei: String(6_000n * E18),
    maxPerDay: 2,
    monthlyCapWei: String(12_000n * E18),
    maxNetworkFeeWei: "100000000000000",
    trigger: "below_alert_percent",
    expiresAt: "2026-11-20T12:00:00.000Z",
    approvedAt: NOW,
    usedLast24Hours: 0,
    usedLast30DaysWei: "0",
    recentExecutions: [],
    ...overrides,
  };
}

function proposal(action: VexCloudAutoTopUpProposal["action"], overrides: Partial<VexCloudAutoTopUpProposal> = {}): VexCloudAutoTopUpProposal {
  return {
    proposalId: "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    action,
    ruleId: action === "create" ? null : RULE_ID,
    expectedVersion: action === "create" ? null : 1,
    actor: "user",
    chainId: 4663,
    token: { address: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", symbol: "VEX", decimals: 18 },
    depositAddress: DEPOSIT,
    bounds: {
      sourceWallet: W1,
      amountWei: String(6_000n * E18),
      maxPerDay: 2,
      monthlyCapWei: String(12_000n * E18),
      maxNetworkFeeWei: "100000000000000",
      trigger: "below_alert_percent",
      alertPercent: 20,
      expiresAt: "2026-11-20T12:00:00.000Z",
    },
    amountUsdMicroEstimate: "6000000",
    monthlyCapUsdMicroEstimate: "12000000",
    minimumWei: String(5_000n * E18),
    minimumMicroUsd: "5000000",
    preparedAt: NOW,
    expiresAt: "2026-10-21T12:02:00.000Z",
    ...overrides,
  };
}

const bridge = {
  alertGet: vi.fn(),
  alertSet: vi.fn(),
  autoTopUpGet: vi.fn(),
  prepareAutoTopUp: vi.fn(),
  submitAutoTopUp: vi.fn(),
  depositWallets: vi.fn(),
};

function ruleIs(value: VexCloudAutoTopUpRule | null): void {
  bridge.autoTopUpGet.mockReturnValue({ promise: Promise.resolve({ ok: true, data: { rule: value } }), cancel: vi.fn() });
}

function renderTab(options: { readonly depositsOpen?: boolean; readonly accountUnavailable?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <AutoTopUpTab account={options.accountUnavailable === true ? null : account()} depositsOpen={options.depositsOpen ?? true} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.alertGet.mockResolvedValue({ ok: true, data: { alertPercent: 20, observation: null } });
  bridge.depositWallets.mockReturnValue({
    promise: Promise.resolve({ ok: true, data: { chainId: 4663, wallets: [{ address: W1, label: "Main", vexWei: String(9_000n * E18) }], readAt: NOW } }),
    cancel: vi.fn(),
  });
  ruleIs(null);
  Object.defineProperty(window, "vex", { configurable: true, value: { vexCloud: bridge } });
});

afterEach(() => {
  cleanup();
});

describe("states", () => {
  it("loading is a word, never figures", () => {
    bridge.autoTopUpGet.mockReturnValue({ promise: new Promise(() => undefined), cancel: vi.fn() });
    renderTab();
    expect(screen.getByText("Reading your auto top-up rule")).toBeTruthy();
    expect(screen.queryByTestId("rule-form")).toBeNull();
  });

  it("a failed read says so and offers Try again", async () => {
    bridge.autoTopUpGet.mockReturnValue({ promise: Promise.resolve({ ok: false, error: { code: "provider.unavailable", message: "Vex Inference could not be reached.", domain: "vexCloud", retryable: true, userActionable: true, redacted: true, correlationId: "c-1" } }), cancel: vi.fn() });
    renderTab();
    expect(await screen.findByText("Your auto top-up rule could not be read.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("closed deposits offer no form", async () => {
    renderTab({ depositsOpen: false });
    expect(await screen.findByText("Deposits are not open.")).toBeTruthy();
    expect(screen.queryByTestId("rule-form")).toBeNull();
  });

  it("an active rule shows its bounds, the network fee limit among them; a fee suspension reads as words", async () => {
    ruleIs(rule());
    const { unmount } = renderTab();
    const summary = await screen.findByTestId("rule-summary");
    expect(within(summary).getByText("Active")).toBeTruthy();
    expect(within(summary).getByText("0.0001 ETH per top-up")).toBeTruthy();
    unmount();
    ruleIs(rule({ state: "suspended", suspendedReason: "network_fee_above_limit" }));
    renderTab();
    expect(await screen.findByText("Suspended: Network fee above your limit")).toBeTruthy();
  });
});

describe("create", () => {
  it("sends the typed text with the default fee limit, shows every bound before approval, Reject first, two presses to create", async () => {
    bridge.prepareAutoTopUp.mockReturnValue({ promise: Promise.resolve({ ok: true, data: proposal("create") }), cancel: vi.fn() });
    bridge.submitAutoTopUp.mockResolvedValue({ ok: true, data: { rule: rule() } });
    renderTab();
    await screen.findByTestId("rule-form");
    const fee = screen.getByLabelText("Network fee limit per top-up (ETH)");
    expect(fee).toHaveProperty("value", "0.0001");
    fireEvent.change(screen.getByLabelText("VEX per top-up (at least the $5 minimum)"), { target: { value: "6000" } });
    fireEvent.change(screen.getByLabelText("Cap per 30 days (VEX)"), { target: { value: "12000" } });
    fireEvent.change(screen.getByLabelText("Most top-ups per 24 hours (1 to 24)"), { target: { value: "2" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Review rule" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Review rule" }));
    expect(bridge.prepareAutoTopUp).toHaveBeenCalledWith({
      action: "create",
      fields: { sourceWallet: W1, amountText: "6000", maxPerDay: 2, monthlyCapText: "12000", maxNetworkFeeText: "0.0001", expiresInDays: 30 },
    });

    const card = await screen.findByTestId("rule-approval");
    for (const text of ["6,000 VEX (about $6.00)", "12,000 VEX (about $12.00)", "0.0001 ETH per top-up", "Balance below 20% of its reference", "Robinhood Chain (4663), token VEX", "5,000 VEX ($5.00)"]) {
      expect(within(card).getByText(text)).toBeTruthy();
    }
    expect(within(card).getAllByText(DEPOSIT).length).toBeGreaterThan(0);
    const reject = within(card).getByRole("button", { name: "Reject" });
    expect(document.activeElement).toBe(reject);

    fireEvent.click(within(card).getByRole("button", { name: "Approve rule" }));
    expect(bridge.submitAutoTopUp).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Click again to confirm" }));
    await waitFor(() => expect(bridge.submitAutoTopUp).toHaveBeenCalledWith({ proposalId: proposal("create").proposalId, action: "create", bounds: proposal("create").bounds }));
  });

  it("Reject changes nothing", async () => {
    bridge.prepareAutoTopUp.mockReturnValue({ promise: Promise.resolve({ ok: true, data: proposal("create") }), cancel: vi.fn() });
    renderTab();
    await screen.findByTestId("rule-form");
    fireEvent.change(screen.getByLabelText("VEX per top-up (at least the $5 minimum)"), { target: { value: "6000" } });
    fireEvent.change(screen.getByLabelText("Cap per 30 days (VEX)"), { target: { value: "12000" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Review rule" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Review rule" }));
    fireEvent.click(within(await screen.findByTestId("rule-approval")).getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Rejected. Nothing was changed.")).toBeTruthy();
    expect(bridge.submitAutoTopUp).not.toHaveBeenCalled();
  });

  it("an empty fee limit blocks review with a sentence", async () => {
    renderTab();
    await screen.findByTestId("rule-form");
    fireEvent.change(screen.getByLabelText("VEX per top-up (at least the $5 minimum)"), { target: { value: "6000" } });
    fireEvent.change(screen.getByLabelText("Cap per 30 days (VEX)"), { target: { value: "12000" } });
    fireEvent.change(screen.getByLabelText("Network fee limit per top-up (ETH)"), { target: { value: "" } });
    expect(await screen.findByText("Enter the network fee limit per top-up in ETH.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review rule" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("pause and revoke without the backend (no rate, no minimum)", () => {
  it.each([
    ["pause", "Pause", "Approve pause", "Pause the auto top-up rule. No automatic deposit runs while it is paused.", rule({ state: "suspended", suspendedReason: "user_paused", version: 2 })],
    ["revoke", "Revoke", "Approve revoke", "Revoke the auto top-up rule. No automatic deposit runs after this.", rule({ state: "revoked", version: 2 })],
  ] as const)("%s: prepared from the stored rule, one press, figures it cannot know read Not available", async (action, button, approve, sentence, after) => {
    ruleIs(rule({ state: "suspended", suspendedReason: "balance_read_failing" }));
    bridge.prepareAutoTopUp.mockReturnValue({
      promise: Promise.resolve({ ok: true, data: proposal(action, { minimumWei: null, minimumMicroUsd: null, amountUsdMicroEstimate: null, monthlyCapUsdMicroEstimate: null }) }),
      cancel: vi.fn(),
    });
    bridge.submitAutoTopUp.mockResolvedValue({ ok: true, data: { rule: after } });
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: button }));
    expect(bridge.prepareAutoTopUp).toHaveBeenCalledWith({ action, ruleId: RULE_ID, expectedVersion: 1 });
    const card = await screen.findByTestId("rule-approval");
    expect(within(card).getByText(sentence)).toBeTruthy();
    expect(within(card).getByText("6,000 VEX (Not available)")).toBeTruthy();
    expect(within(card).getAllByText("Not available").length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(within(card).getByRole("button", { name: "Reject" }));
    fireEvent.click(within(card).getByRole("button", { name: approve }));
    await waitFor(() => expect(bridge.submitAutoTopUp).toHaveBeenCalledWith({ proposalId: proposal(action).proposalId, action, bounds: proposal(action).bounds }));
    expect(await screen.findByTestId("auto-top-up-message")).toBeTruthy();
  });
});

describe("the account cannot be read (a backend outage)", () => {
  it.each([
    ["pause", "Pause", "Approve pause", rule({ state: "suspended", suspendedReason: "balance_read_failing" }), rule({ state: "suspended", suspendedReason: "user_paused", version: 2 })],
    ["revoke", "Revoke", "Approve revoke", rule({ state: "suspended", suspendedReason: "user_paused" }), rule({ state: "revoked", version: 2 })],
  ] as const)("%s stays reachable and works from the stored rule", async (action, button, approve, before, after) => {
    ruleIs(before);
    bridge.prepareAutoTopUp.mockReturnValue({
      promise: Promise.resolve({ ok: true, data: proposal(action, { minimumWei: null, minimumMicroUsd: null, amountUsdMicroEstimate: null, monthlyCapUsdMicroEstimate: null }) }),
      cancel: vi.fn(),
    });
    bridge.submitAutoTopUp.mockResolvedValue({ ok: true, data: { rule: after } });
    renderTab({ accountUnavailable: true });
    const summary = await screen.findByTestId("rule-summary");
    expect(within(summary).getByTestId("rule-spending-blocked").textContent).toBe(SPENDING_CHANGES_NEED_ACCOUNT);
    fireEvent.click(within(summary).getByRole("button", { name: button }));
    expect(bridge.prepareAutoTopUp).toHaveBeenCalledWith({ action, ruleId: RULE_ID, expectedVersion: 1 });
    fireEvent.click(within(await screen.findByTestId("rule-approval")).getByRole("button", { name: approve }));
    await waitFor(() => expect(bridge.submitAutoTopUp).toHaveBeenCalledWith({ proposalId: proposal(action).proposalId, action, bounds: proposal(action).bounds }));
    expect(await screen.findByText(/^Done\. The rule is/)).toBeTruthy();
  });

  it("edit and resume are disabled with the reason, and pressing them prepares nothing", async () => {
    ruleIs(rule({ state: "suspended", suspendedReason: "user_paused" }));
    renderTab({ accountUnavailable: true });
    const summary = await screen.findByTestId("rule-summary");
    for (const name of ["Edit", "Resume"]) {
      const control = within(summary).getByRole("button", { name });
      expect(control.hasAttribute("disabled")).toBe(true);
      fireEvent.click(control);
    }
    expect(within(summary).getByText(SPENDING_CHANGES_NEED_ACCOUNT)).toBeTruthy();
    expect(screen.queryByTestId("rule-form")).toBeNull();
    expect(bridge.prepareAutoTopUp).not.toHaveBeenCalled();
  });

  it("with no stored rule, create is not offered and the reason is said", async () => {
    renderTab({ accountUnavailable: true });
    expect(await screen.findByText("No auto top-up rule can be set up right now.")).toBeTruthy();
    expect(screen.getByText(SPENDING_CHANGES_NEED_ACCOUNT)).toBeTruthy();
    expect(screen.queryByTestId("rule-form")).toBeNull();
  });
});
