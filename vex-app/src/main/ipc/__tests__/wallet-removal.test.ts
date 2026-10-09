import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type { WalletRemovalResult } from "@shared/schemas/wallets.js";
import { CH } from "@shared/ipc/channels.js";
import { createMainFrame } from "./test-sender.js";
import { openExecutionGate, __resetExecutionGateForTests } from "../../lifecycle/execution-gate.js";
import { trackInFlightSigning, __resetInFlightSigningForTests } from "@vex-agent/engine/core/in-flight-signing.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>>(),
  verify: vi.fn(), confirm: vi.fn(), prepare: vi.fn(), commit: vi.fn(), secondary: vi.fn(), restore: vi.fn(),
  inspect: vi.fn(), removed: vi.fn(), lock: vi.fn(), failure: vi.fn(), success: vi.fn(), throttle: vi.fn(),
  unlocked: true, critical: false, destroyed: false,
  lifecycle: (() => undefined) as () => void,
}));
class PolicyError extends Error {}
class VaultError extends Error { readonly code = "invalid_password"; }
vi.mock("electron", () => ({
  app: { isPackaged: true },
  ipcMain: { handle: (channel: string, fn: (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>) => mocks.handlers.set(channel, fn), removeHandler: (channel: string) => mocks.handlers.delete(channel) },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => mocks.destroyed }) },
  dialog: { showMessageBox: (...args: unknown[]) => mocks.confirm(...args) },
}));
vi.mock("../../logger/index.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../lifecycle/cleanup-registry.js", () => ({ globalCleanup: { add: () => () => undefined } }));
vi.mock("../../secrets/session.js", () => ({
  getSecretSessionStatus: () => ({ unlocked: mocks.unlocked }), lockSecretSession: () => mocks.lock(),
  onSecretSessionLifecycle: (fn: () => void) => { mocks.lifecycle = fn; return () => undefined; },
}));
vi.mock("@vex-lib/local-secret-vault.js", () => ({ LocalSecretVaultError: VaultError, verifySecretVaultPassword: (...args: unknown[]) => mocks.verify(...args) }));
vi.mock("@vex-lib/wallet-removal.js", () => ({
  WalletLifecycleError: PolicyError, secondaryWallet: (...args: unknown[]) => mocks.secondary(...args),
  prepareWalletRemoval: (...args: unknown[]) => mocks.prepare(...args),
  restoreRemovedWallet: (...args: unknown[]) => mocks.restore(...args),
  listWalletRemovalRecords: () => mocks.removed(), recoveryDirectory: () => "/disposable/backups/recovery",
}));
vi.mock("@vex-agent/db/client.js", () => ({ withTransaction: async (fn: (client: object) => Promise<unknown>) => fn({}) }));
vi.mock("@vex-agent/db/repos/wallet-removal.js", () => ({ lockRemovalDependencies: async () => undefined, inspectRemovalDependencies: (...args: unknown[]) => mocks.inspect(...args) }));
vi.mock("../../database/engine-db-readiness.js", () => ({ ensureEngineDbUrl: async () => ({ ok: true, data: {} }) }));
vi.mock("../../updates/critical-ops.js", () => ({ criticalOpInFlight: () => mocks.critical, CRITICAL_OP: { secretVaultOp: "secretVaultOp" }, beginCriticalOp: () => () => undefined }));
vi.mock("../../wallet/removal-service.js", () => ({ commitWalletRemoval: (...args: unknown[]) => mocks.commit(...args) }));
vi.mock("../../wallet/export-throttle.js", () => ({
  checkExportAllowed: () => mocks.throttle(), recordExportSuccess: () => mocks.success(), recordExportFailure: () => mocks.failure(),
}));

const { registerWalletRemovalHandlers } = await import("../wallet-removal.js");
const { __resetWalletMutexForTests } = await import("../../onboarding/wallet-mutex.js");
const input = { chain: "evm", walletId: "evm_11111111-1111-4111-8111-111111111111", password: "Disposable-password-2026" };
const entry = { id: input.walletId, address: "0x1234567890123456789012345678901234567890", label: "Secondary", createdAt: "2026-10-09T00:00:00Z" };
const dependencies = { sessionIds: ["chat"], missionCount: 1 };
let sender: EventEmitter & { mainFrame: ReturnType<typeof createMainFrame> };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.unlocked = true; mocks.critical = false; mocks.destroyed = false;
  mocks.handlers.clear();
  mocks.verify.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue({ response: 1 });
  mocks.secondary.mockReturnValue(entry);
  mocks.prepare.mockResolvedValue({ family: "evm", entry });
  mocks.commit.mockResolvedValue(dependencies);
  mocks.inspect.mockResolvedValue(dependencies);
  mocks.removed.mockReturnValue([]);
  mocks.throttle.mockReturnValue({ allowed: true });
  mocks.failure.mockReturnValue({ lockoutTriggered: false });
  __resetWalletMutexForTests();
  __resetInFlightSigningForTests();
  __resetExecutionGateForTests(); openExecutionGate();
  sender = Object.assign(new EventEmitter(), { mainFrame: createMainFrame() });
  registerWalletRemovalHandlers();
});
async function call(payload: unknown = input, frame = sender.mainFrame, channel: string = CH.wallet.remove): Promise<Result<WalletRemovalResult>> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error("Missing handler");
  return await handler({ sender, senderFrame: frame } as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111", payload,
  }) as Result<WalletRemovalResult>;
}

describe("owner-only wallet removal boundary", () => {
  it("requires fresh authentication and a native exact-address confirmation before preparing recovery", async () => {
    expect((await call()).ok).toBe(true);
    expect(mocks.verify).toHaveBeenCalledWith(input.password, expect.any(Object));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      defaultId: 0, cancelId: 0, detail: expect.stringContaining(entry.address),
    }));
    expect(mocks.prepare.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.confirm.mock.invocationCallOrder[0]!);
    expect(sender.listenerCount("did-start-navigation")).toBe(0);
  });
  it("refuses an untrusted frame and extra renderer authority", async () => {
    expect((await call(input, createMainFrame("https://untrusted.invalid/"))).ok).toBe(false);
    expect((await call({ ...input, confirmed: true })).ok).toBe(false);
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it("refuses while locked, during another protected operation, and while signing", async () => {
    mocks.unlocked = false;
    expect((await call()).ok).toBe(false);
    mocks.unlocked = true; mocks.critical = true;
    expect((await call()).ok).toBe(false);
    mocks.critical = false;
    await trackInFlightSigning("mutating_tool", async () => { expect((await call()).ok).toBe(false); });
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it("admits no new signing while the native confirmation is open", async () => {
    mocks.confirm.mockImplementationOnce(async () => {
      await expect(trackInFlightSigning("mutating_tool", async () => undefined)).rejects.toThrow();
      return { response: 0 };
    });
    expect((await call()).ok).toBe(false);
    expect(mocks.prepare).not.toHaveBeenCalled();
    await expect(trackInFlightSigning("mutating_tool", async () => undefined)).resolves.toBeUndefined();
  });
  it.each(["navigation", "lock", "timeout", "window"])("revokes an open confirmation after %s", async (cause) => {
    mocks.confirm.mockImplementationOnce(async () => {
      if (cause === "navigation") sender.emit("did-start-navigation");
      if (cause === "lock") mocks.lifecycle();
      if (cause === "window") mocks.destroyed = true;
      if (cause === "timeout") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
      return { response: 1 };
    });
    try { expect((await call()).ok).toBe(false); expect(mocks.prepare).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); }
  });
  it("rechecks authorization after asynchronous backup verification", async () => {
    mocks.prepare.mockImplementationOnce(async () => { mocks.lifecycle(); return { family: "evm", entry }; });
    expect((await call()).ok).toBe(false);
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it("shares the authentication throttle and relocks on password lockout", async () => {
    mocks.verify.mockRejectedValueOnce(new VaultError());
    mocks.failure.mockReturnValueOnce({ lockoutTriggered: true });
    expect((await call()).ok).toBe(false);
    expect(mocks.lock).toHaveBeenCalledOnce();
    mocks.throttle.mockReturnValueOnce({ allowed: false, retryAfterMs: 3000 });
    expect((await call()).ok).toBe(false);
    expect(mocks.verify).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("requires the owner confirmation for recovery and passes an older password only to the privileged recovery helper", async () => {
    const record = { entry, family: "evm", state: "removed" };
    mocks.removed.mockReturnValue([record]);
    mocks.restore.mockResolvedValue({ ...entry, id: "new-wallet-identity" });
    const result = await call({ ...input, recoveryPassword: "Older-backup-password" }, sender.mainFrame, CH.wallet.restoreRemoved);
    expect(result.ok && result.data.walletId).toBe("new-wallet-identity");
    expect(mocks.verify).toHaveBeenCalledWith(input.password, expect.any(Object));
    expect(mocks.restore).toHaveBeenCalledWith(record, input.password, expect.any(Function), "Older-backup-password");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ detail: expect.stringContaining(entry.address) }));
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
