/**
 * WHAT MAY BE CARRIED FORWARD WITHOUT SIGNING.
 *
 * The setup modal reaches this route on a poll, so the question it answers is
 * narrow and worth pinning: a registration whose change-pub-key transaction is
 * already on chain may be finished from evidence, and nothing else may. A
 * registration that has not been submitted belongs to the prepare path, which
 * takes an approval; quietly reconciling one here would be a signature nobody
 * asked for, and a wallet with no Lighter account has nothing to reconcile at
 * all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSessionWallet: vi.fn(),
  readLighterAccount: vi.fn(),
  findLiveIntent: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("../onboarding-checklist.js", () => ({
  readSessionWalletFromEngine: mocks.readSessionWallet,
}));
vi.mock("@tools/lighter/wallet-funding/onboarding-readers.js", () => ({
  buildLighterOnboardingReaders: () => ({ readLighterAccount: mocks.readLighterAccount }),
}));
vi.mock("@vex-agent/db/repos/lighter-key-registration-intents.js", () => ({
  findLiveLighterKeyRegistrationIntentForAccount: mocks.findLiveIntent,
}));
vi.mock("../key-registration-execution.js", () => ({
  reconcileLighterKeyRegistration: mocks.reconcile,
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { reconcileSetupKeyRegistration } = await import("../key-registration-reconcile.js");

const SESSION = "11111111-1111-4111-8111-111111111111";
const INPUT = { sessionId: SESSION, environment: "rhc" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readSessionWallet.mockResolvedValue({
    walletAddress: "0x375BC39264a33f807843a208a3C601Aa01198944",
    walletResolution: { marker: "resolution" },
    walletPolicy: { marker: "policy" },
  });
  mocks.readLighterAccount.mockResolvedValue({ account_index: 30475 });
  mocks.findLiveIntent.mockResolvedValue({
    intentId: "lighter-onboard-1",
    executionState: "key_verified",
  });
  mocks.reconcile.mockResolvedValue({ status: "active", executionState: "active" });
});

describe("reconcileSetupKeyRegistration", () => {
  it("carries a verified registration forward, with the session's own wallet scope", async () => {
    await expect(reconcileSetupKeyRegistration(INPUT)).resolves.toEqual({
      attempted: true,
      status: "active",
    });
    expect(mocks.reconcile).toHaveBeenCalledWith({
      sessionId: SESSION,
      intentId: "lighter-onboard-1",
      walletResolution: { marker: "resolution" },
      walletPolicy: { marker: "policy" },
    });
  });

  it.each([
    "change_pub_key_submitted",
    "nonce_synchronized",
    "ambiguous",
  ])("carries %s forward too", async (executionState) => {
    mocks.findLiveIntent.mockResolvedValue({ intentId: "i", executionState });
    await expect(reconcileSetupKeyRegistration(INPUT)).resolves.toMatchObject({ attempted: true });
  });

  it.each([
    "slot_reserved",
    "key_generated_encrypted",
    "approval_pending",
    "approved",
    "active",
  ])("leaves %s to the path that owns it", async (executionState) => {
    mocks.findLiveIntent.mockResolvedValue({ intentId: "i", executionState });
    await expect(reconcileSetupKeyRegistration(INPUT)).resolves.toEqual({
      attempted: false,
      status: null,
    });
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("carries a staged registration forward once its signed transaction has expired", async () => {
    mocks.findLiveIntent.mockResolvedValue({
      intentId: "i",
      executionState: "key_registration_tx_staged",
      registrationTxExpiredAt: String(Date.now() - 1),
    });
    await expect(reconcileSetupKeyRegistration(INPUT)).resolves.toMatchObject({ attempted: true });
    expect(mocks.reconcile).toHaveBeenCalledOnce();
  });

  it.each([
    ["still live", () => String(Date.now() + 60_000)],
    ["with no recorded expiry", () => null],
  ])("leaves a staged registration %s to the executor that may still send it", async (_label, expiry) => {
    mocks.findLiveIntent.mockResolvedValue({
      intentId: "i",
      executionState: "key_registration_tx_staged",
      registrationTxExpiredAt: expiry(),
    });
    await expect(reconcileSetupKeyRegistration(INPUT)).resolves.toEqual({ attempted: false, status: null });
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("has nothing to do without a Lighter account", async () => {
    mocks.readLighterAccount.mockResolvedValue(null);
    await expect(reconcileSetupKeyRegistration(INPUT)).resolves.toEqual({
      attempted: false,
      status: null,
    });
    expect(mocks.findLiveIntent).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("has nothing to do without a live registration", async () => {
    mocks.findLiveIntent.mockResolvedValue(null);
    await expect(reconcileSetupKeyRegistration(INPUT)).resolves.toEqual({
      attempted: false,
      status: null,
    });
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
});
