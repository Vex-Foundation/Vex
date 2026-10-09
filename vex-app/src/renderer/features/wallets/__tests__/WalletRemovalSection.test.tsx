import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, err } from "@shared/ipc/result.js";
import type { WalletRemovalInput } from "@shared/schemas/wallets.js";
import { WalletRemovalSection } from "../WalletRemovalSection.js";

const primary = { id: "evm_primary", family: "evm" as const, address: `0x${"a".repeat(40)}`, label: "Primary" };
const secondary = { id: "evm_secondary", family: "evm" as const, address: `0x${"b".repeat(40)}`, label: "Savings" };
const remove = vi.fn();
const restore = vi.fn();
const listRemoved = vi.fn();
const listAvailable = vi.fn();
const openBackup = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  listAvailable.mockResolvedValue(ok({ evm: [primary, secondary], solana: [] }));
  listRemoved.mockResolvedValue(ok([]));
  Object.defineProperty(window, "vex", { configurable: true, value: {
    wallets: { listAvailable }, wallet: { remove, restoreRemoved: restore, listRemoved },
    onboarding: { walletOpenBackupFolder: openBackup },
  } });
});
afterEach(cleanup);

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><WalletRemovalSection /></QueryClientProvider>);
  return client;
}

describe("wallet removal settings", () => {
  it("offers removal only for secondary wallets and names the full address before asking for a password", async () => {
    mount();
    const buttons = await screen.findAllByRole("button", { name: "Remove from Vex" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] ?? document.body);
    expect(screen.getAllByText(secondary.address)).toHaveLength(2);
    expect(screen.getByLabelText("Master password")).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
  });

  it("clears the password before IPC finishes, blocks duplicate submits, and retains no secret in query or mutation caches", async () => {
    let finish: (value: ReturnType<typeof ok<{ walletId: string; address: string; backupDir: string; affectedChats: number; pausedMissions: number }>>) => void = () => undefined;
    remove.mockImplementation((_input: WalletRemovalInput) => new Promise((resolve) => { finish = resolve; }));
    const client = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Remove from Vex" }));
    const input = screen.getByLabelText<HTMLInputElement>("Master password");
    fireEvent.change(input, { target: { value: "A-private-test-password" } });
    const form = input.closest("form");
    if (!form) throw new Error("No confirmation form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(input.value).toBe("");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain("A-private-test-password");
    finish(ok({ walletId: secondary.id, address: secondary.address, backupDir: "/recovery", affectedChats: 1, pausedMissions: 0 }));
    await screen.findByText(/Wallet removed\. Its encrypted recovery copy/);
    expect(screen.getByRole("button", { name: "Open recovery folder" })).toBeTruthy();
  });

  it("shows the privileged refusal and requires a newly entered password on retry", async () => {
    remove.mockResolvedValue(err({ code: "wallet.policy_blocked", domain: "wallet", message: "A transaction is unresolved.", retryable: true, userActionable: true, redacted: true, correlationId: "test" }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Remove from Vex" }));
    const input = screen.getByLabelText<HTMLInputElement>("Master password");
    fireEvent.change(input, { target: { value: "A-private-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to removal" }));
    await screen.findByText("A transaction is unresolved.");
    expect(input.value).toBe("");
  });

  it("keeps interrupted removal unavailable for restore", async () => {
    listRemoved.mockResolvedValue(ok([{ walletId: "evm_old", chain: "evm", address: `0x${"c".repeat(40)}`, label: "Old wallet", state: "removing", removedAt: new Date().toISOString() }]));
    mount();
    await screen.findByText("Access is disabled. Restart Vex to finish recovery.");
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Restore wallet" });
    expect(button.disabled).toBe(true);
    expect(restore).not.toHaveBeenCalled();
    await waitFor(() => expect(listAvailable).toHaveBeenCalled());
  });

  it("passes separate recovery credentials directly and clears both password fields", async () => {
    listAvailable.mockResolvedValue(ok({ evm: [primary], solana: [] }));
    listRemoved.mockResolvedValue(ok([{ walletId: secondary.id, chain: "evm", address: secondary.address, label: secondary.label, state: "removed", removedAt: new Date().toISOString() }]));
    restore.mockResolvedValue(ok({ walletId: "evm_new", address: secondary.address, backupDir: "/recovery", affectedChats: 0, pausedMissions: 0 }));
    const client = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Restore wallet" }));
    const master = screen.getByLabelText<HTMLInputElement>("Master password");
    const recovery = screen.getByLabelText<HTMLInputElement>("Recovery password (if different)");
    fireEvent.change(master, { target: { value: "Current-private-password" } });
    fireEvent.change(recovery, { target: { value: "Archived-private-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue to restore" }));
    expect(master.value).toBe("");
    expect(recovery.value).toBe("");
    expect(restore).toHaveBeenCalledWith({ chain: "evm", walletId: secondary.id, password: "Current-private-password", recoveryPassword: "Archived-private-password" });
    await screen.findByText("Wallet restored. Select it explicitly in a new chat.");
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    const cached = JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data));
    expect(cached).not.toContain("Current-private-password");
    expect(cached).not.toContain("Archived-private-password");
  });
});
