import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSessionWallet: vi.fn(),
  readWorkflow: vi.fn(),
  findDeposit: vi.fn(),
  repairDeposit: vi.fn(),
  reconcileKey: vi.fn(),
}));

vi.mock("../onboarding-checklist.js", () => ({ readSessionWalletFromEngine: mocks.readSessionWallet }));
vi.mock("@vex-agent/db/repos/lighter-onboarding-workflows.js", () => ({ getLighterOnboardingWorkflow: mocks.readWorkflow }));
vi.mock("@vex-agent/db/repos/lighter-onboarding-intents.js", () => ({ findByIntentId: mocks.findDeposit }));
vi.mock("@vex-agent/sync/lighter-deposit-repair.js", () => ({
  buildProductionLighterDepositRepairDeps: () => ({ marker: "read-only" }),
  repairLighterDepositIntent: mocks.repairDeposit,
}));
vi.mock("../key-registration-reconcile.js", () => ({ reconcileSetupKeyRegistration: mocks.reconcileKey }));

const { reconcileSetupAttempt } = await import("../setup-reconcile.js");
const WALLET = "0x1111111111111111111111111111111111111111";
const INPUT = { sessionId: "11111111-1111-4111-8111-111111111111", environment: "rhc" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readSessionWallet.mockResolvedValue({ walletAddress: WALLET });
  mocks.readWorkflow.mockResolvedValue({ workflowState: "ambiguous", activeDepositIntentId: "deposit-1" });
  mocks.findDeposit.mockResolvedValue({ intentId: "deposit-1", environment: "rhc", walletAddress: WALLET });
  mocks.repairDeposit.mockResolvedValue({ resolution: "credited" });
  mocks.reconcileKey.mockResolvedValue({ attempted: false, status: null });
});

describe("reconcileSetupAttempt", () => {
  it("repairs only the selected wallet's saved deposit from provider evidence", async () => {
    await expect(reconcileSetupAttempt(INPUT)).resolves.toEqual({ attempted: true, status: "pending" });
    expect(mocks.findDeposit).toHaveBeenCalledWith("deposit-1");
    expect(mocks.repairDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: WALLET, environment: "rhc" }),
      { marker: "read-only" },
    );
  });

  it("refuses to repair a deposit belonging to another wallet", async () => {
    mocks.findDeposit.mockResolvedValue({ intentId: "deposit-1", environment: "rhc", walletAddress: "0x2222222222222222222222222222222222222222" });
    await expect(reconcileSetupAttempt(INPUT)).resolves.toEqual({ attempted: false, status: "manual_review" });
    expect(mocks.repairDeposit).not.toHaveBeenCalled();
    expect(mocks.reconcileKey).not.toHaveBeenCalled();
  });

  it("keeps an unproven deposit pending without advancing to key registration", async () => {
    mocks.repairDeposit.mockResolvedValue({ resolution: "awaiting_lighter" });
    await expect(reconcileSetupAttempt(INPUT)).resolves.toEqual({ attempted: true, status: "pending" });
    expect(mocks.reconcileKey).not.toHaveBeenCalled();
  });

  it("checks an already credited deposit when the Lighter account read is temporarily missing", async () => {
    mocks.readWorkflow.mockResolvedValue({ workflowState: "account_resolved", activeDepositIntentId: "deposit-1" });
    mocks.repairDeposit.mockResolvedValue({ resolution: "terminal" });
    await expect(reconcileSetupAttempt(INPUT)).resolves.toEqual({ attempted: false, status: null });
    expect(mocks.repairDeposit).toHaveBeenCalledOnce();
  });

  it("leaves an untraceable workflow for manual review", async () => {
    mocks.readWorkflow.mockResolvedValue({ workflowState: "ambiguous", activeDepositIntentId: null });
    await expect(reconcileSetupAttempt(INPUT)).resolves.toEqual({ attempted: true, status: "pending" });
    expect(mocks.repairDeposit).not.toHaveBeenCalled();
  });

  it("reconciles the existing key attempt without a deposit when no deposit is uncertain", async () => {
    mocks.readWorkflow.mockResolvedValue({ workflowState: "change_pub_key_submitted", activeDepositIntentId: null });
    mocks.reconcileKey.mockResolvedValue({ attempted: true, status: "active" });
    await expect(reconcileSetupAttempt(INPUT)).resolves.toEqual({ attempted: true, status: "active" });
    expect(mocks.repairDeposit).not.toHaveBeenCalled();
    expect(mocks.reconcileKey).toHaveBeenCalledWith(INPUT);
  });
});
