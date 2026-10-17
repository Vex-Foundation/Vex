/**
 * RestoreFromArchive - renderer parity for the C3 full-archive restore screen.
 *
 * Mocks `window.vex.onboarding.{listBackups,restoreArchive}` (skill §12).
 * Validates:
 *  - lists available backups (metadata only - counts + truncated addresses),
 *  - empty state when there are no backups,
 *  - restore happy path → restored summary + cache invalidation,
 *  - `vaultLocked: true` → prominent re-unlock note,
 *  - error path (`wallet.password_invalid`) → friendly message,
 *  - the master password is read once, NEVER retained, and the field is
 *    cleared after submit.
 *
 * The panel renders collapsed (a trigger button); each test expands it first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { Result } from "@shared/ipc/result.js";
import type {
  WalletListBackupsResult,
  WalletRestoreArchiveResult,
} from "@shared/schemas/wallets.js";

const listBackupsMock =
  vi.fn<() => Promise<Result<WalletListBackupsResult>>>();
const restoreArchiveMock =
  vi.fn<(id: string, password: string) => Promise<Result<WalletRestoreArchiveResult>>>();

const { RestoreFromArchive } = await import("../RestoreFromArchive.js");

const EVM_ADDR = "0x1111111111111111111111111111111111111111";
const SOL_ADDR = "SoLaddrBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const PASSWORD = "correct-horse-22";

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

function backupsFixture(): WalletListBackupsResult {
  return {
    backups: [
      {
        id: "backup-2026-05-01",
        timestamp: "2026-05-01T10:00:00.000Z",
        walletCount: 2,
        addresses: [EVM_ADDR, SOL_ADDR],
        vaultIncluded: true,
        envIncluded: true,
      },
      {
        id: "backup-2026-04-15",
        timestamp: "2026-04-15T08:30:00.000Z",
        walletCount: 1,
        addresses: [EVM_ADDR],
        vaultIncluded: true,
        envIncluded: false,
      },
    ],
  };
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderPanel(): {
  view: ReturnType<typeof render>;
  client: QueryClient;
} {
  const client = freshClient();
  const view = render(<RestoreFromArchive />, { wrapper: makeWrapper(client) });
  return { view, client };
}

function expand(view: ReturnType<typeof render>): void {
  const open = view.container.querySelector(
    "[data-vex-restore-open]",
  ) as HTMLButtonElement;
  fireEvent.click(open);
}

beforeEach(() => {
  listBackupsMock.mockReset();
  restoreArchiveMock.mockReset();
  listBackupsMock.mockResolvedValue(ok(backupsFixture()));
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      onboarding: {
        listBackups: listBackupsMock,
        restoreArchive: restoreArchiveMock,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "vex");
});

describe("RestoreFromArchive", () => {
  it("renders collapsed, then lists backups with counts and addresses on expand", async () => {
    const { view } = renderPanel();
    // Collapsed by default - only the trigger is present.
    expect(view.container.querySelector("[data-vex-restore-open]")).toBeTruthy();
    expect(view.container.querySelector("[data-vex-restore-list]")).toBeNull();

    expand(view);

    const list = await waitFor(() => {
      const node = view.container.querySelector("[data-vex-restore-list]");
      if (node === null) throw new Error("backup list not rendered");
      return node;
    });
    const items = list.querySelectorAll("[data-vex-restore-backup]");
    expect(items.length).toBe(2);
    expect(list.textContent).toMatch(/2 wallets/);
    expect(list.textContent).toMatch(/1 wallet/);
    // Truncated EVM address (AddressDisplay) is shown - no key material.
    expect(list.textContent).toMatch(/0x1111/);
  });

  it("shows an empty state when there are no backups", async () => {
    listBackupsMock.mockResolvedValue(ok({ backups: [] }));
    const { view } = renderPanel();
    expand(view);

    await waitFor(() => {
      const empty = view.container.querySelector("[data-vex-restore-empty]");
      if (empty === null) throw new Error("empty state not rendered");
      expect(empty.textContent).toMatch(/No backups yet/);
    });
    expect(view.container.querySelector("[data-vex-restore-submit]")).toBeNull();
  });

  it("restores successfully and shows the restored summary + invalidates caches", async () => {
    restoreArchiveMock.mockResolvedValue(
      ok({
        filesRestored: ["wallet-evm.json", "wallet-sol.json", ".env"],
        walletsRestored: [
          {
            id: "w1",
            address: EVM_ADDR,
            label: "EVM 1",
            createdAt: "2026-05-01T10:00:00.000Z",
          },
        ],
        vaultLocked: false,
      }),
    );
    const { view, client } = renderPanel();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    expand(view);

    await waitFor(() => {
      if (view.container.querySelector("[data-vex-restore-list]") === null) {
        throw new Error("list not ready");
      }
    });

    const radio = view.container.querySelector(
      '[data-vex-restore-backup="backup-2026-05-01"] input[type="radio"]',
    ) as HTMLInputElement;
    fireEvent.click(radio);
    const password = view.container.querySelector(
      "[data-vex-restore-password]",
    ) as HTMLInputElement;
    fireEvent.input(password, { target: { value: PASSWORD } });

    const submit = view.container.querySelector(
      "[data-vex-restore-submit]",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(restoreArchiveMock).toHaveBeenCalledWith("backup-2026-05-01", PASSWORD);
    });

    const summary = await waitFor(() => {
      const node = view.container.querySelector("[data-vex-restore-success]");
      if (node === null) throw new Error("summary not rendered");
      return node;
    });
    expect(summary.textContent).toMatch(/Restored 1 wallet/);
    expect(summary.textContent).toMatch(/3 files/);
    // Password field is cleared after submit - secret not retained in the DOM.
    expect(password.value).toBe("");
    // Restore form is gone once the summary renders.
    expect(view.container.querySelector("[data-vex-restore-submit]")).toBeNull();
    // Caches were invalidated (inventory + env + wizard + backups).
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it("surfaces the re-unlock note when the restored vault is locked", async () => {
    restoreArchiveMock.mockResolvedValue(
      ok({
        filesRestored: ["wallet-evm.json"],
        walletsRestored: [
          {
            id: "w1",
            address: EVM_ADDR,
            label: "EVM 1",
            createdAt: "2026-05-01T10:00:00.000Z",
          },
        ],
        vaultLocked: true,
      }),
    );
    const { view } = renderPanel();
    expand(view);

    await waitFor(() => {
      if (view.container.querySelector("[data-vex-restore-list]") === null) {
        throw new Error("list not ready");
      }
    });

    fireEvent.click(
      view.container.querySelector(
        '[data-vex-restore-backup="backup-2026-05-01"] input[type="radio"]',
      ) as HTMLInputElement,
    );
    fireEvent.input(
      view.container.querySelector(
        "[data-vex-restore-password]",
      ) as HTMLInputElement,
      { target: { value: PASSWORD } },
    );
    fireEvent.click(
      view.container.querySelector(
        "[data-vex-restore-submit]",
      ) as HTMLButtonElement,
    );

    await waitFor(() => {
      const note = view.container.querySelector(
        "[data-vex-restore-vault-locked]",
      );
      if (note === null) throw new Error("vault-locked note not rendered");
      expect(note.textContent).toMatch(/different master password/i);
      expect(note.textContent).toMatch(/this backup/i);
    });
  });

  it("maps password_invalid to a friendly message and clears the password field", async () => {
    restoreArchiveMock.mockResolvedValue({
      ok: false,
      error: {
        code: "wallet.password_invalid",
        domain: "wallet",
        message: "redacted",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "c-1",
      },
    });
    const { view } = renderPanel();
    expand(view);

    await waitFor(() => {
      if (view.container.querySelector("[data-vex-restore-list]") === null) {
        throw new Error("list not ready");
      }
    });

    fireEvent.click(
      view.container.querySelector(
        '[data-vex-restore-backup="backup-2026-05-01"] input[type="radio"]',
      ) as HTMLInputElement,
    );
    const password = view.container.querySelector(
      "[data-vex-restore-password]",
    ) as HTMLInputElement;
    fireEvent.input(password, { target: { value: "wrong-password-99" } });
    fireEvent.click(
      view.container.querySelector(
        "[data-vex-restore-submit]",
      ) as HTMLButtonElement,
    );

    await waitFor(() => {
      const err = view.container.querySelector("[data-vex-restore-error]");
      if (err === null) throw new Error("error not rendered");
      expect(err.textContent).toMatch(/Master password is incorrect/);
    });
    // Field is wiped even on a failed attempt.
    expect(password.value).toBe("");
    // No success summary on error.
    expect(view.container.querySelector("[data-vex-restore-success]")).toBeNull();
  });

  it("treats onboarding.env_persist_failed as a pre-write abort (nothing changed), not a partial restore", async () => {
    // In the archive-restore flow this code = AUTO_BACKUP_FAILED: C1 aborts
    // BEFORE any live write. The copy must say nothing changed, never imply a
    // successful/partial restore.
    restoreArchiveMock.mockResolvedValue({
      ok: false,
      error: {
        code: "onboarding.env_persist_failed",
        domain: "onboarding",
        message: "redacted",
        retryable: true,
        userActionable: true,
        redacted: true,
        correlationId: "c-2",
      },
    });
    const { view } = renderPanel();
    expand(view);

    await waitFor(() => {
      if (view.container.querySelector("[data-vex-restore-list]") === null) {
        throw new Error("list not ready");
      }
    });

    fireEvent.click(
      view.container.querySelector(
        '[data-vex-restore-backup="backup-2026-05-01"] input[type="radio"]',
      ) as HTMLInputElement,
    );
    const password = view.container.querySelector(
      "[data-vex-restore-password]",
    ) as HTMLInputElement;
    fireEvent.input(password, { target: { value: "any-password-00" } });
    fireEvent.click(
      view.container.querySelector(
        "[data-vex-restore-submit]",
      ) as HTMLButtonElement,
    );

    await waitFor(() => {
      const err = view.container.querySelector("[data-vex-restore-error]");
      if (err === null) throw new Error("error not rendered");
      expect(err.textContent).toMatch(/nothing was changed/i);
    });
    // Must NOT claim wallets were restored, and no success summary.
    const errText =
      view.container.querySelector("[data-vex-restore-error]")?.textContent ?? "";
    expect(errText).not.toMatch(/restored/i);
    expect(view.container.querySelector("[data-vex-restore-success]")).toBeNull();
  });
});
