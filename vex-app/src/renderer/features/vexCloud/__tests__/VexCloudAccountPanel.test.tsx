/**
 * The Vex Cloud account panel (Settings "Vex Cloud" and the provider step's
 * Vex Cloud branch), against a mocked `window.vex.vexCloud` bridge only.
 *
 * Pinned per state: loading is a word and a quiet bar; a locked vault and an
 * outage are said in words with a retry; signed out lists the wallets that
 * will sign and the one Sign in press sends EXACTLY that list; no wallet
 * means no Sign in; signed in shows the balance with its unit, its USD
 * estimate and the rate age, a missing estimate reads "Not available",
 * linked and not-linked wallets are named; an expired session says so;
 * Cancel cancels; Sign out removes the session.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { VexCloudAccount, VexCloudAccountResult } from "@shared/schemas/vex-cloud.js";
import { VexCloudAccountPanel } from "../VexCloudAccountPanel.js";

const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";

const account = vi.fn<() => Promise<Result<VexCloudAccountResult>>>();
const signIn = vi.fn();
const signOut = vi.fn();

function vexAmount(wei: string, usdMicroEstimate: string | null) {
  return { wei, decimals: 18 as const, symbol: "VEX" as const, usdMicroEstimate };
}

function signedInAccount(overrides: Partial<VexCloudAccount> = {}): VexCloudAccount {
  return {
    accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    paused: false,
    wallets: [{ address: W1, linkedAt: "2026-10-20T12:00:00.000Z" }],
    balances: {
      available: vexAmount("1234567891234567891234", "1234567"),
      provisional: vexAmount("0", "0"),
      reserved: vexAmount("5000000000000000", null),
      pendingWithdrawal: vexAmount("0", "0"),
      claimable: vexAmount("0", "0"),
    },
    rate: { available: true, source: "fixed", observedAt: "2026-10-20T12:00:00.000Z", ageSeconds: 125 },
    readAt: "2026-10-20T12:01:00.000Z",
    ...overrides,
  };
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <VexCloudAccountPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  account.mockReset();
  signIn.mockReset();
  signOut.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: { vexCloud: { account, signIn, signOut } },
  });
});

afterEach(() => {
  cleanup();
});

describe("reads", () => {
  it("loading is a word, never fake figures", () => {
    account.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    expect(screen.getByText("Checking Vex Cloud")).toBeTruthy();
    expect(screen.queryByText(/VEX$/)).toBeNull();
  });

  it("a locked vault says to unlock, with a retry", async () => {
    account.mockResolvedValue({
      ok: false,
      error: {
        code: "wallet.keystore_locked",
        domain: "vexCloud",
        message: "Unlock Vex with your master password before using wallets or secrets.",
        retryable: false,
        userActionable: true,
        redacted: true,
        correlationId: "c1",
      },
    });
    renderPanel();
    expect(await screen.findByText("Unlock Vex to use Vex Cloud.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(account).toHaveBeenCalledTimes(2));
  });
});

describe("signed out", () => {
  it("lists the wallets that will sign and sends exactly that list", async () => {
    account.mockResolvedValue({ ok: true, data: { state: "signed_out", reason: "not_signed_in", localWallets: [W1, W2] } });
    signIn.mockReturnValue({
      promise: Promise.resolve({ ok: true, data: { accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", created: true, linkedNow: [W1, W2], account: null } }),
      cancel: vi.fn(),
    });
    renderPanel();

    expect(await screen.findByText("Signed out")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Wallets that will sign" });
    expect(within(list).getByText(W1)).toBeTruthy();
    expect(within(list).getByText(W2)).toBeTruthy();
    expect(screen.getByText(/No transaction is sent and no funds move/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sign in to Vex Cloud" }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith({ wallets: [W1, W2] }));
    // A success re-reads the account.
    await waitFor(() => expect(account).toHaveBeenCalledTimes(2));
  });

  it("without an EVM wallet there is nothing to sign with", async () => {
    account.mockResolvedValue({ ok: true, data: { state: "signed_out", reason: "not_signed_in", localWallets: [] } });
    renderPanel();
    expect(await screen.findByText(/none exists yet/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sign in to Vex Cloud" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an expired session says so", async () => {
    account.mockResolvedValue({ ok: true, data: { state: "signed_out", reason: "session_expired", localWallets: [W1] } });
    renderPanel();
    expect(await screen.findByText("Session expired")).toBeTruthy();
  });

  it("Cancel cancels the running sign-in and says nothing was stored", async () => {
    account.mockResolvedValue({ ok: true, data: { state: "signed_out", reason: "not_signed_in", localWallets: [W1] } });
    let settle: (value: unknown) => void = () => undefined;
    const cancel = vi.fn(() =>
      settle({
        ok: false,
        error: { code: "internal.cancelled", domain: "vexCloud", message: "Cancelled.", retryable: true, userActionable: false, redacted: true, correlationId: "c" },
      }),
    );
    signIn.mockReturnValue({ promise: new Promise((resolve) => (settle = resolve)), cancel });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Vex Cloud" }));
    expect(await screen.findByRole("button", { name: "Signing in…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(cancel).toHaveBeenCalledOnce();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Sign-in cancelled. Nothing was stored.");
  });

  it("a refusal shows the main process's own sentence", async () => {
    account.mockResolvedValue({ ok: true, data: { state: "signed_out", reason: "not_signed_in", localWallets: [W1] } });
    signIn.mockReturnValue({
      promise: Promise.resolve({
        ok: false,
        error: {
          code: "permissions.denied",
          domain: "vexCloud",
          message: "One of your wallets is already linked to a different Vex Cloud account. Nothing was linked; Vex Cloud never merges accounts on its own.",
          retryable: false,
          userActionable: true,
          redacted: true,
          correlationId: "c",
        },
      }),
      cancel: vi.fn(),
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Vex Cloud" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already linked to a different Vex Cloud account/);
  });
});

describe("signed in", () => {
  it("shows the balance with its unit, USD estimate and rate age; a missing estimate reads Not available", async () => {
    account.mockResolvedValue({ ok: true, data: { state: "signed_in", account: signedInAccount(), localWallets: [W1, W2] } });
    renderPanel();

    expect(await screen.findByText("Signed in")).toBeTruthy();
    const available = document.querySelector('[data-vex-cloud-balance="available"]');
    expect(available?.textContent).toContain("1,234.56 VEX");
    expect(document.querySelector('[data-vex-cloud-usd="available"]')?.textContent).toBe("about $1.23 · rate 2 min old");
    const reserved = document.querySelector('[data-vex-cloud-balance="reserved"]');
    expect(reserved?.textContent).toContain("less than 0.01 VEX");
    expect(document.querySelector('[data-vex-cloud-usd="reserved"]')?.textContent).toBe("USD estimate: Not available");
    // Zero phase-2 balances are not drawn.
    expect(document.querySelector('[data-vex-cloud-balance="claimable"]')).toBeNull();
  });

  it("names linked and not-linked wallets and offers to link", async () => {
    account.mockResolvedValue({ ok: true, data: { state: "signed_in", account: signedInAccount(), localWallets: [W1, W2] } });
    signIn.mockReturnValue({ promise: new Promise(() => undefined), cancel: vi.fn() });
    renderPanel();

    await screen.findByText("Signed in");
    expect(document.querySelectorAll('[data-vex-cloud-wallet="linked"]')).toHaveLength(1);
    const unlinked = document.querySelectorAll('[data-vex-cloud-wallet="unlinked"]');
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]?.textContent).toContain(W2);
    fireEvent.click(screen.getByRole("button", { name: "Link this wallet" }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith({ wallets: [W1, W2] }));
  });

  it("a stale rate says the USD rate is not available", async () => {
    account.mockResolvedValue({
      ok: true,
      data: {
        state: "signed_in",
        account: signedInAccount({ rate: { available: false, reason: "stale" }, balances: { ...signedInAccount().balances, available: vexAmount("1000000000000000000", null) } }),
        localWallets: [W1],
      },
    });
    renderPanel();
    await screen.findByText("Signed in");
    expect(screen.getByText(/USD rate: Not available/)).toBeTruthy();
    expect(document.querySelector('[data-vex-cloud-usd="available"]')?.textContent).toBe("USD estimate: Not available");
  });

  it("a paused account says so", async () => {
    account.mockResolvedValue({ ok: true, data: { state: "signed_in", account: signedInAccount({ paused: true }), localWallets: [W1] } });
    renderPanel();
    expect(await screen.findByText("Paused for review")).toBeTruthy();
  });

  it("Sign out removes the session and re-reads", async () => {
    account.mockResolvedValue({ ok: true, data: { state: "signed_in", account: signedInAccount(), localWallets: [W1] } });
    signOut.mockResolvedValue({ ok: true, data: { signedOut: true } });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    await waitFor(() => expect(account).toHaveBeenCalledTimes(2));
  });
});
