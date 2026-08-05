/**
 * WalletsStep — verifies the skip-card / setup-tabs branching, advance
 * chain, and ChainActions integration. Mocks the API hooks so we don't
 * touch any IPC.
 *
 * ChainActions is NOT mocked; its full UI (tabs / actions / import
 * panel) is exercised here so we get end-to-end coverage of M8 user
 * flows. Generate / restore mutations are mocked at the wallets.js
 * module level.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { JSX } from "react";
import type { Result } from "@shared/ipc/result.js";
import type { EnvState } from "@shared/schemas/onboarding.js";
import type {
  WalletAddInput,
  WalletAddResult,
  WalletExportAllResult,
  WalletGenerateEvmResult,
  WalletGenerateSolanaResult,
  WalletListBackupsResult,
  WalletOpenBackupFolderInput,
  WalletOpenBackupFolderResult,
  WalletRestoreResult,
} from "@shared/schemas/wallets.js";
import type {
  SetWizardStateInput,
  WizardState,
  WizardStepId,
} from "@shared/schemas/wizard.js";
import type { WizardFlowMode } from "../../../../lib/api/wizard.js";

const mockUseEnvState = vi.fn();
const mockGenerateMutate = vi.fn();
const mockRestoreMutate = vi.fn();
const mockOpenBackupMutate = vi.fn();
const mockSetWizardMutate = vi.fn();
const mockImportEvm = vi.fn();
const mockImportSolana = vi.fn();
const mockOnAdvance = vi.fn();
const mockInvalidateEnv = vi.fn();
const mockWalletAdd = vi.fn();
const mockImportAddEvm = vi.fn();
const mockImportAddSolana = vi.fn();
const mockExportAll = vi.fn();
const mockUseAvailableWallets = vi.fn();
const mockInvalidateArchiveRestore = vi.fn();
const mockRestoreArchive = vi.fn();

vi.mock("../../../../lib/api/onboarding.js", () => ({
  useEnvState: () => mockUseEnvState(),
}));

vi.mock("../../../../lib/api/wizard.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../../lib/api/wizard.js")>(
      "../../../../lib/api/wizard.js"
    );
  const { makeMockUseStepAdvance } = await import("../../__tests__/useStepAdvance-mock.js");
  return {
    ...actual,
    useSetWizardState: () =>
      ({
        mutateAsync: (input: SetWizardStateInput) => mockSetWizardMutate(input),
        isPending: false,
      }) as unknown as UseMutationResult<
        Result<WizardState>,
        Error,
        SetWizardStateInput
      >,
    useStepAdvance: makeMockUseStepAdvance(mockSetWizardMutate),
  };
});

vi.mock("../../../../lib/api/wallets.js", () => ({
  useWalletGenerate: () =>
    ({
      mutateAsync: () => mockGenerateMutate(),
      isPending: false,
    }) as unknown as UseMutationResult<
      Result<WalletGenerateEvmResult | WalletGenerateSolanaResult>,
      Error,
      void
    >,
  useWalletRestore: () =>
    ({
      mutateAsync: () => mockRestoreMutate(),
      isPending: false,
    }) as unknown as UseMutationResult<
      Result<WalletRestoreResult>,
      Error,
      void
    >,
  useOpenBackupFolder: () =>
    ({
      mutateAsync: (input: WalletOpenBackupFolderInput) =>
        mockOpenBackupMutate(input),
      isPending: false,
    }) as unknown as UseMutationResult<
      Result<WalletOpenBackupFolderResult>,
      Error,
      WalletOpenBackupFolderInput
    >,
  useInvalidateEnvStateAfterWalletWrite: () => mockInvalidateEnv,
  importWalletEvm: (rawKey: string) => mockImportEvm(rawKey),
  importWalletSolana: (rawKey: string) => mockImportSolana(rawKey),
  useWalletAdd: () =>
    ({
      mutateAsync: (input: WalletAddInput) => mockWalletAdd(input),
      isPending: false,
    }) as unknown as UseMutationResult<
      Result<WalletAddResult>,
      Error,
      WalletAddInput
    >,
  importAddWalletEvm: (rawKey: string) => mockImportAddEvm(rawKey),
  importAddWalletSolana: (rawKey: string) => mockImportAddSolana(rawKey),
  useExportAllWallets: () =>
    ({
      mutateAsync: () => mockExportAll(),
      isPending: false,
    }) as unknown as UseMutationResult<
      Result<WalletExportAllResult>,
      Error,
      void
    >,
  // C3 — RestoreFromArchive (rendered collapsed in WalletsStep). Stubbed so the
  // panel mounts without hitting IPC; its full behaviour lives in
  // wallets/__tests__/RestoreFromArchive.test.tsx.
  useListBackups: () =>
    ({
      data: { ok: true, data: { backups: [] } },
      isLoading: false,
      isFetching: false,
      isError: false,
      isSuccess: true,
      refetch: vi.fn(),
    }) as unknown as UseQueryResult<Result<WalletListBackupsResult>>,
  useInvalidateAfterArchiveRestore: () => mockInvalidateArchiveRestore,
  restoreArchive: (id: string, password: string) =>
    mockRestoreArchive(id, password),
}));

vi.mock("../../../../lib/api/wallet-inventory.js", () => ({
  useAvailableWallets: () => mockUseAvailableWallets(),
}));

const { WalletsStep } = await import("../WalletsStep.js");

function renderStep(
  completedSteps: ReadonlyArray<WizardStepId> = ["keystore"],
  flowMode: WizardFlowMode = "first-pass"
): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <WalletsStep completedSteps={completedSteps} onAdvance={mockOnAdvance} flowMode={flowMode} />
    </QueryClientProvider>
  );
}

const evmAddress = "0xabcdef0123456789abcdef0123456789abcdef01";
const solanaAddress = "DRpbCBMxVnDK7maPM5tGv6MvCsx1WTokJBKVz5Pk5Hxe";

function envQueryFor(walletStatus: {
  readonly evm: "present" | "missing";
  readonly solana: "present" | "missing";
  readonly addresses?: { evm: string | null; solana: string | null };
}): UseQueryResult<Result<EnvState>> {
  return {
    data: {
      ok: true,
      data: {
        hasKeystorePassword: true,
        hasJupiterApiKey: false,
        apiKeys: {
          jupiterConfigured: false,
          tavilyConfigured: false,
          rettiwtConfigured: false,
          relayConfigured: false,
        },
        embeddings: {
          configured: false,
          reachable: false,
          baseUrlRedacted: null,
          allFieldsConfigured: false,
          dbReachable: null,
        },
        walletStatus,
        ...(walletStatus.addresses
          ? { walletAddresses: walletStatus.addresses }
          : {}),
        provider: { configured: false, name: null, modelLabel: null },
        setupCompleteFlag: false,
      },
    },
    isLoading: false,
    isError: false,
    isSuccess: true,
  } as UseQueryResult<Result<EnvState>>;
}

beforeEach(() => {
  mockUseEnvState.mockReset();
  mockGenerateMutate.mockReset();
  mockRestoreMutate.mockReset();
  mockOpenBackupMutate.mockReset();
  mockSetWizardMutate.mockReset();
  mockImportEvm.mockReset();
  mockImportSolana.mockReset();
  mockOnAdvance.mockReset();
  mockInvalidateEnv.mockReset();
  mockWalletAdd.mockReset();
  mockImportAddEvm.mockReset();
  mockImportAddSolana.mockReset();
  mockExportAll.mockReset();
  mockUseAvailableWallets.mockReset();
  mockInvalidateArchiveRestore.mockReset();
  mockRestoreArchive.mockReset();
  // Default: empty inventory so configured-branch flows render the
  // WalletInventoryPanel without surfacing extra addresses.
  mockUseAvailableWallets.mockReturnValue({
    data: { ok: true, data: { evm: [], solana: [] } },
    isLoading: false,
    isError: false,
    isSuccess: true,
  });
});

afterEach(() => {
  cleanup();
});

describe("WalletsStep", () => {
  it("renders setup card when neither chain has a wallet", () => {
    mockUseEnvState.mockReturnValue(
      envQueryFor({ evm: "missing", solana: "missing" })
    );
    const { getByText, getByRole } = renderStep();
    expect(getByText(/Set up wallets/i)).toBeTruthy();
    expect(getByRole("tab", { name: /EVM/i })).toBeTruthy();
    expect(getByRole("tab", { name: /Solana/i })).toBeTruthy();
  });

  it("first-pass with no wallet: surfaces the configure-later alert + 'Continue without a wallet' and advances (optional model)", async () => {
    mockUseEnvState.mockReturnValue(
      envQueryFor({ evm: "missing", solana: "missing" })
    );
    mockSetWizardMutate.mockResolvedValue({
      ok: true,
      data: {
        schemaVersion: 1,
        currentStepId: "apiKeys",
        completedSteps: ["keystore", "wallets"],
        completed: false,
      },
    });
    const view = renderStep(["keystore"]);
    // Consequence alert is shown.
    expect(
      view.container.querySelector("[data-vex-wallets-configure-later-alert]")
    ).not.toBeNull();
    // Advance is allowed even with no wallet configured.
    fireEvent.click(
      view.getByRole("button", { name: /Continue without a wallet/i })
    );
    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalledWith("apiKeys");
    });
  });

  it("renders skip card when both chains have wallets, with both addresses + Continue", async () => {
    mockUseEnvState.mockReturnValue(
      envQueryFor({
        evm: "present",
        solana: "present",
        addresses: { evm: evmAddress, solana: solanaAddress },
      })
    );
    const { findByText, getByRole } = renderStep();
    await findByText(/Wallets configured/i);
    expect(getByRole("button", { name: /Continue/i })).toBeTruthy();
  });

  it("Continue calls setWizardState then onAdvance('apiKeys')", async () => {
    mockUseEnvState.mockReturnValue(
      envQueryFor({
        evm: "present",
        solana: "present",
        addresses: { evm: evmAddress, solana: solanaAddress },
      })
    );
    mockSetWizardMutate.mockResolvedValue({
      ok: true,
      data: {
        schemaVersion: 1,
        currentStepId: "apiKeys",
        completedSteps: ["keystore", "wallets"],
        completed: false,
      },
    });
    const view = renderStep(["keystore"]);
    fireEvent.click(view.getByRole("button", { name: /Continue/i }));
    await waitFor(() => {
      expect(mockSetWizardMutate).toHaveBeenCalledWith({
        currentStepId: "apiKeys",
        completedSteps: ["keystore", "wallets"],
      });
    });
    await waitFor(() => {
      expect(mockOnAdvance).toHaveBeenCalledWith("apiKeys");
    });
  });

  it("EVM Generate button calls walletGenerate, surfaces address inline", async () => {
    mockUseEnvState.mockReturnValue(
      envQueryFor({ evm: "missing", solana: "missing" })
    );
    mockGenerateMutate.mockResolvedValue({
      ok: true,
      data: { address: evmAddress },
    });
    const view = renderStep();
    fireEvent.click(view.getByRole("button", { name: /Generate new/i }));
    await waitFor(() => {
      expect(mockGenerateMutate).toHaveBeenCalled();
    });
    // After success, ChainActions flips to data-vex-wallet-state="configured"
    // and renders the AddressDisplay with the truncated address.
    await waitFor(() => {
      const configuredEl = view.container.querySelector(
        '[data-vex-wallet-state="configured"][data-vex-wallet-chain="evm"]'
      );
      expect(configuredEl).not.toBeNull();
      expect(configuredEl?.textContent).toContain("EVM wallet");
    });
    expect(view.getByText(new RegExp(evmAddress.slice(0, 6)))).toBeTruthy();
  });

  it("EVM Import: clears the input synchronously before the IPC await resolves", async () => {
    mockUseEnvState.mockReturnValue(
      envQueryFor({ evm: "missing", solana: "missing" })
    );
    let resolveImport: (v: unknown) => void = () => {};
    mockImportEvm.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve;
        })
    );
    const view = renderStep();
    fireEvent.click(view.getByRole("button", { name: /Import existing/i }));
    const input = (await view.findByLabelText(
      /EVM private key/i
    )) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "0xprivkey" } });
    fireEvent.click(view.getByRole("button", { name: /^Import$/i }));
    // Synchronously the input.value is cleared even though the IPC is pending.
    await waitFor(() => {
      expect(mockImportEvm).toHaveBeenCalledWith("0xprivkey");
    });
    expect(input.value).toBe("");
    // Resolve the IPC; advance to "configured" state.
    resolveImport({ ok: true, data: { address: evmAddress } });
    await view.findByText(/EVM wallet/i);
  });

  it("Restore success — surfaces backup folder warning + Open backup folder button", async () => {
    mockUseEnvState.mockReturnValue(
      envQueryFor({ evm: "missing", solana: "missing" })
    );
    mockRestoreMutate.mockResolvedValue({
      ok: true,
      data: {
        chain: "evm",
        address: evmAddress,
        replacedAddress: null,
        backupDir: "/home/user/.config/vex/backups/T123",
      },
    });
    const view = renderStep();
    fireEvent.click(view.getByRole("button", { name: /Restore from backup/i }));
    await view.findByText(/Backup created/i);
    expect(view.getByRole("button", { name: /Open backup folder/i })).toBeTruthy();
  });

  it("Restore cancelled by user (internal.cancelled) — no action error shown", async () => {
    mockUseEnvState.mockReturnValue(
      envQueryFor({ evm: "missing", solana: "missing" })
    );
    mockRestoreMutate.mockResolvedValue({
      ok: false,
      error: {
        code: "internal.cancelled",
        domain: "onboarding",
        message: "Restore cancelled.",
        retryable: false,
        userActionable: false,
        redacted: true,
      },
    });
    const view = renderStep();
    fireEvent.click(view.getByRole("button", { name: /Restore from backup/i }));
    await waitFor(() => {
      expect(mockRestoreMutate).toHaveBeenCalled();
    });
    // No "Restore cancelled" error visible — silent cancellation.
    expect(view.queryByText(/Restore cancelled/i)).toBeNull();
  });

  it("Restore failure surfaces error message inline", async () => {
    mockUseEnvState.mockReturnValue(
      envQueryFor({ evm: "missing", solana: "missing" })
    );
    mockRestoreMutate.mockResolvedValue({
      ok: false,
      error: {
        code: "wallet.password_invalid",
        domain: "wallet",
        message: "Wrong password or corrupted keystore.",
        retryable: true,
        userActionable: true,
        redacted: true,
      },
    });
    const view = renderStep();
    fireEvent.click(view.getByRole("button", { name: /Restore from backup/i }));
    await view.findByText(/Wrong password/i);
  });

  it("Solana tab — switching shows Solana action menu", async () => {
    mockUseEnvState.mockReturnValue(
      envQueryFor({ evm: "missing", solana: "missing" })
    );
    const view = renderStep();
    fireEvent.click(view.getByRole("tab", { name: /Solana/i }));
    await waitFor(() => {
      const solanaPanel = view.container.querySelector(
        '[data-vex-wallet-chain="solana"][data-vex-wallet-state="empty"]'
      );
      expect(solanaPanel).not.toBeNull();
    });
  });

  it("EVM existing-only (Solana missing) does NOT show skip card", () => {
    mockUseEnvState.mockReturnValue(
      envQueryFor({
        evm: "present",
        solana: "missing",
        addresses: { evm: evmAddress, solana: null },
      })
    );
    const { queryByText, getByRole } = renderStep();
    expect(queryByText(/Wallets configured/i)).toBeNull();
    // Setup card with tabs is rendered.
    expect(getByRole("tab", { name: /EVM/i })).toBeTruthy();
  });

  it("back-edit + both wallets present (legacy addresses null) shows inventory-sourced management + Done affordance", () => {
    // walletStatus present but NO walletAddresses (multi-wallet config model:
    // legacy addresses are not written). Inventory is the source of truth.
    mockUseEnvState.mockReturnValue(
      envQueryFor({ evm: "present", solana: "present" })
    );
    mockUseAvailableWallets.mockReturnValue({
      data: {
        ok: true,
        data: {
          evm: [{ id: "evm-1", address: evmAddress, label: "EVM 1" }],
          solana: [{ id: "sol-1", address: solanaAddress, label: "Solana 1" }],
        },
      },
      isLoading: false,
      isError: false,
      isSuccess: true,
    });
    const view = renderStep(["keystore"], "back-edit");

    // NOT the skip/summary card — back-edit always shows full management.
    expect(view.queryByText(/Wallets configured/i)).toBeNull();
    // EVM resolved from inventory → ChainActions renders the configured view
    // (existing wallet) with the "Add another" affordance from WalletInventoryPanel.
    const configuredEl = view.container.querySelector(
      '[data-vex-wallet-state="configured"][data-vex-wallet-chain="evm"]'
    );
    expect(configuredEl).not.toBeNull();
    expect(view.getByText(/Add another/i)).toBeTruthy();
    // Back-edit exit affordance (the Tabs path footer) — context-neutral
    // "Done", since Settings hosts the same form (Phase 2b).
    expect(view.getByRole("button", { name: /^Done$/ })).toBeTruthy();
  });
});
