/**
 * The cooling period on the funding page, against a mocked
 * `window.vex.vexCloud` bridge.
 *
 * Pinned: the approval card states the delay the backend reported in the
 * proposal (1 hour for 3600 s, 12 hours for 43200 s) and a release time, and
 * no number at all when the backend reported none;
 * a cooling withdrawal reads "Cooling, releases at HH:MM" with a Cancel key;
 * Cancel asks "Cancel this withdrawal? The VEX returns to your balance." with
 * Reject as the first focus, and the confirmed cancel turns the row into
 * Cancelled; an ambiguous cancel shows Status unknown and Check status calls
 * the same cancel again; `in_flight` says it can no longer be cancelled; a
 * withdrawal the backend does not mark cancellable has no Cancel key; a
 * notice for a withdrawal this app did not start carries the owner's
 * sentence, Cancel and "It was me".
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VexCloudAccount } from "@shared/schemas/vex-cloud.js";
import type { VexCloudWithdrawal, VexCloudWithdrawalNotice, VexCloudWithdrawalProposal } from "@shared/schemas/vex-cloud-funding.js";
import { VexCloudFundingPage } from "../VexCloudFundingScreen.js";
import { CANCEL_CONFIRM, CANCEL_UNKNOWN_DETAIL } from "../CancelWithdrawal.js";
import { IT_WAS_ME } from "../WithdrawalNotices.js";
import { COOLING_UNREPORTED_LINE } from "../WithdrawTab.js";
import { useUnresolvedWithdrawals } from "../unresolved-withdrawals.js";

const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";
const E18 = 10n ** 18n;
const NOW = "2026-10-21T12:00:00.000Z";
const HOUR = 3_600_000;

/** What the screen must print for a time on this machine's clock: "HH:MM", with the date when not today. */
function local(iso: string, nowMs: number = Date.now()): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const now = new Date(nowMs);
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay ? clock : `${at.toLocaleString("en-US", { month: "short" })} ${at.getDate()}, ${clock}`;
}

function amount(wei: bigint) {
  return { wei: wei.toString(), decimals: 18 as const, symbol: "VEX" as const, usdMicroEstimate: null };
}

function account(): VexCloudAccount {
  return {
    accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    paused: false,
    wallets: [{ address: W1, linkedAt: NOW }],
    balances: {
      available: amount(20_000n * E18),
      provisional: amount(0n),
      reserved: amount(0n),
      pendingWithdrawal: amount(0n),
      claimable: amount(0n),
      cashbackPending: null,
    },
    withdrawable: amount(10_000n * E18),
    depositAddress: "0x00000000000000000000000000000000000D3905",
    limits: {
      minDepositMicroUsd: "5000000",
      minWithdrawMicroUsd: "5000000",
      provisionalCapMicroUsd: "25000000",
      withdrawDailyLimitMicroUsd: "500000000",
      withdrawDailyRemainingWei: null,
    },
    rate: { available: true, source: "twap", observedAt: NOW, ageSeconds: 30, vexWeiPerMicroUsd: "1000000000000000", validUntil: NOW },
    readAt: NOW,
  };
}

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

function cooling(overrides: Partial<VexCloudWithdrawal> = {}): VexCloudWithdrawal {
  return {
    id: "wd_1",
    status: "debited",
    amountWei: PROPOSAL.amountWei,
    destination: W1,
    txHash: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    releaseAt: new Date(Date.now() + 12 * HOUR).toISOString(),
    cancellable: true,
    ...overrides,
  };
}

const bridge = {
  account: vi.fn(),
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

function invocation(result: unknown) {
  return { promise: Promise.resolve(result), cancel: vi.fn() };
}

function notices(list: readonly VexCloudWithdrawalNotice[]) {
  return invocation({ ok: true, data: { state: "signed_in", notices: list, complete: true, checkedAt: NOW } });
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <VexCloudFundingPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useUnresolvedWithdrawals.setState({ records: [] });
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.account.mockResolvedValue({ ok: true, data: { state: "signed_in", account: account(), localWallets: [W1], depositPin: { state: "matches", address: account().depositAddress } } });
  bridge.alertGet.mockResolvedValue({ ok: true, data: { alertPercent: 20, observation: null } });
  bridge.autoTopUpGet.mockReturnValue(invocation({ ok: true, data: { rule: null } }));
  bridge.depositWallets.mockReturnValue(invocation({ ok: true, data: { chainId: 4663, wallets: [], readAt: NOW } }));
  bridge.withdrawalNotices.mockReturnValue(notices([]));
  Object.defineProperty(window, "vex", { configurable: true, value: { vexCloud: bridge } });
});

afterEach(() => {
  cleanup();
});

/** Through review and approve to the status view, the backend answering `withdrawal`. */
async function sendWithdrawal(withdrawal: VexCloudWithdrawal): Promise<HTMLElement> {
  bridge.prepareWithdrawal.mockReturnValue(invocation({ ok: true, data: PROPOSAL }));
  bridge.submitWithdrawal.mockResolvedValue({ ok: true, data: { outcome: "accepted", withdrawal } });
  bridge.withdrawal.mockResolvedValue({ ok: true, data: { withdrawal } });
  renderPage();
  fireEvent.click(await screen.findByRole("tab", { name: "Withdraw" }));
  fireEvent.change(await screen.findByLabelText("You withdraw"), { target: { value: "6000" } });
  fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
  const card = await screen.findByTestId("withdraw-approval");
  fireEvent.click(within(card).getByRole("button", { name: "Approve withdrawal" }));
  return screen.findByTestId("withdraw-status");
}

describe("the approval card", () => {
  async function cardLine(coolingSeconds: number | null): Promise<HTMLElement> {
    bridge.prepareWithdrawal.mockReturnValue(invocation({ ok: true, data: { ...PROPOSAL, coolingSeconds } }));
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Withdraw" }));
    fireEvent.change(await screen.findByLabelText("You withdraw"), { target: { value: "6000" } });
    fireEvent.click(screen.getByRole("button", { name: "Review withdrawal" }));
    const card = await screen.findByTestId("withdraw-approval");
    expect(within(card).getByText("Released")).toBeTruthy();
    return within(card).getByTestId("withdraw-cooling-line");
  }

  it.each([
    [3_600, "1-hour", HOUR],
    [43_200, "12-hour", 12 * HOUR],
    [5_400, "90-minute", 1.5 * HOUR],
  ])("a backend cooling of %s s reads a %s safety delay, its release time, and that it can be cancelled until then", async (coolingSeconds, words, delayMs) => {
    const line = (await cardLine(coolingSeconds)).textContent ?? "";
    const expectedAt = local(new Date(Date.now() + delayMs).toISOString());
    expect(line).toBe(`After a ${words} safety delay, at about ${expectedAt}. You can cancel it until then.`);
  });

  it("states no number when the backend did not report its cooling period", async () => {
    const line = (await cardLine(null)).textContent ?? "";
    expect(line).toBe(COOLING_UNREPORTED_LINE);
    expect(line).toBe("After the safety delay set by Vex Inference. The exact time shows once it is sent. You can cancel it until then.");
    expect(line).not.toMatch(/[0-9]/);
  });
});

describe("a cooling withdrawal", () => {
  it('reads "Cooling, releases at HH:MM" with Cancel; the confirmation has Reject first, and Cancel through IPC moves it to Cancelled', async () => {
    const withdrawal = cooling();
    const status = await sendWithdrawal(withdrawal);
    expect(within(status).getByText(`Cooling, releases at ${local(withdrawal.releaseAt ?? "")}`)).toBeTruthy();
    fireEvent.click(within(status).getByRole("button", { name: "Cancel" }));
    const confirm = await screen.findByTestId("withdraw-cancel-confirm");
    expect(within(confirm).getByText(CANCEL_CONFIRM)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Reject"));
    // No REAL FUNDS card: a cancel only returns funds.
    expect(within(status).queryByText("REAL FUNDS")).toBeNull();
    const cancelled = { ...withdrawal, status: "cancelled" as const, cancellable: false };
    bridge.cancelWithdrawal.mockReturnValue(invocation({ ok: true, data: { outcome: "cancelled", withdrawal: cancelled } }));
    bridge.withdrawal.mockResolvedValue({ ok: true, data: { withdrawal: cancelled } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel withdrawal" }));
    expect(bridge.cancelWithdrawal).toHaveBeenCalledWith({ withdrawalId: "wd_1" });
    await waitFor(() => expect(within(screen.getByTestId("withdraw-status")).getByText("Cancelled")).toBeTruthy());
    expect(within(screen.getByTestId("withdraw-status")).getByText(/back in your Vex Inference balance/)).toBeTruthy();
  });

  it("Reject closes the confirmation and cancels nothing", async () => {
    const status = await sendWithdrawal(cooling());
    fireEvent.click(within(status).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(await screen.findByTestId("withdraw-cancel-confirm")).getByRole("button", { name: "Reject" }));
    expect(screen.queryByTestId("withdraw-cancel-confirm")).toBeNull();
    expect(bridge.cancelWithdrawal).not.toHaveBeenCalled();
  });

  it("an ambiguous cancel shows Status unknown; Check status asks again for the same withdrawal", async () => {
    const withdrawal = cooling();
    const status = await sendWithdrawal(withdrawal);
    bridge.cancelWithdrawal.mockReturnValue(invocation({ ok: true, data: { outcome: "unknown", withdrawalId: "wd_1" } }));
    fireEvent.click(within(status).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(await screen.findByTestId("withdraw-cancel-confirm")).getByRole("button", { name: "Cancel withdrawal" }));
    const unknown = await screen.findByTestId("withdraw-cancel-unknown");
    expect(within(unknown).getByText("Status unknown")).toBeTruthy();
    expect(within(unknown).getByText(CANCEL_UNKNOWN_DETAIL)).toBeTruthy();
    bridge.cancelWithdrawal.mockReturnValue(invocation({ ok: true, data: { outcome: "cancelled", withdrawal: { ...withdrawal, status: "cancelled", cancellable: false } } }));
    fireEvent.click(within(unknown).getByRole("button", { name: "Check status" }));
    expect(bridge.cancelWithdrawal).toHaveBeenCalledTimes(2);
    expect(bridge.cancelWithdrawal.mock.calls[1]).toEqual([{ withdrawalId: "wd_1" }]);
    expect(await screen.findByTestId("withdraw-cancelled")).toBeTruthy();
  });

  it("withdrawal_in_flight says it is already being sent and can no longer be cancelled", async () => {
    const status = await sendWithdrawal(cooling());
    bridge.cancelWithdrawal.mockReturnValue(
      invocation({
        ok: true,
        data: { outcome: "not_cancelled", reason: "in_flight", withdrawal: null, detail: "This withdrawal is already being sent; it can no longer be cancelled." },
      }),
    );
    fireEvent.click(within(status).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(await screen.findByTestId("withdraw-cancel-confirm")).getByRole("button", { name: "Cancel withdrawal" }));
    expect((await screen.findByTestId("withdraw-cancel-refused")).textContent).toMatch(/already being sent; it can no longer be cancelled/);
  });

  it("a withdrawal the backend does not mark cancellable has no Cancel key", async () => {
    const status = await sendWithdrawal(cooling({ cancellable: false }));
    expect(within(status).getByText(/^Cooling, releases at/)).toBeTruthy();
    expect(within(status).queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});

describe("a withdrawal this app did not start", () => {
  const NOTICE: VexCloudWithdrawalNotice = {
    withdrawalId: "wd_foreign",
    amountWei: String(6_000n * E18),
    destination: W2,
    releaseAt: new Date(Date.parse(NOW) + 12 * HOUR).toISOString(),
    cancellable: true,
    createdAt: NOW,
  };

  it("is a notice with the owner's sentence, Cancel and It was me", async () => {
    bridge.withdrawalNotices.mockReturnValue(notices([NOTICE]));
    renderPage();
    const notice = await screen.findByTestId("withdrawal-notice");
    expect(notice.textContent).toContain(
      `A withdrawal you did not start in this app is waiting: 6,000 VEX to 0x2222…2222, releases at ${local(NOTICE.releaseAt)}. If it was not you, cancel it now.`,
    );
    bridge.cancelWithdrawal.mockReturnValue(invocation({ ok: true, data: { outcome: "cancelled", withdrawal: { ...cooling({ id: "wd_foreign" }), status: "cancelled", cancellable: false } } }));
    fireEvent.click(within(notice).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(notice).getByRole("button", { name: "Cancel withdrawal" }));
    expect(bridge.cancelWithdrawal).toHaveBeenCalledWith({ withdrawalId: "wd_foreign" });
  });

  it('"It was me" dismisses it in main', async () => {
    bridge.withdrawalNotices.mockReturnValue(notices([NOTICE]));
    bridge.dismissWithdrawalNotice.mockResolvedValue({ ok: true, data: { dismissed: true } });
    renderPage();
    fireEvent.click(within(await screen.findByTestId("withdrawal-notice")).getByRole("button", { name: IT_WAS_ME }));
    expect(bridge.dismissWithdrawalNotice).toHaveBeenCalledWith({ withdrawalId: "wd_foreign" });
  });

  it("a notice the backend no longer lets be cancelled has no Cancel key", async () => {
    bridge.withdrawalNotices.mockReturnValue(notices([{ ...NOTICE, cancellable: false }]));
    renderPage();
    const notice = await screen.findByTestId("withdrawal-notice");
    expect(within(notice).queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(within(notice).getByRole("button", { name: IT_WAS_ME })).toBeTruthy();
  });

  it("a failed check is said, never shown as nothing waiting", async () => {
    bridge.withdrawalNotices.mockReturnValue(
      invocation({ ok: false, error: { code: "provider.unavailable", domain: "vexCloud", message: "Vex Inference could not be reached.", retryable: true, userActionable: true, redacted: true, correlationId: "c" } }),
    );
    renderPage();
    expect((await screen.findByTestId("withdrawal-notices-failed")).textContent).toMatch(/could not check/);
  });
});
