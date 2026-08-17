import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  renew: vi.fn(),
  release: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/lighter-evm-execution-leases.js", () => ({
  acquireLighterEvmExecutionLease: mocks.acquire,
  renewLighterEvmExecutionLease: mocks.renew,
  releaseLighterEvmExecutionLease: mocks.release,
  getLighterEvmExecutionLease: mocks.get,
}));

const { acquireLighterDepositExecutionLease } = await import(
  "@tools/lighter/wallet-funding/execution-lease.js"
);

const INPUT = {
  chainId: 1,
  walletAddress: "0xaCEE6141F6171491D34699C9266cb06A41FAA43C",
  intentId: "lighter-onboard-00000000-0000-4000-8000-000000000001",
};
const EXPIRY = new Date("2030-01-01T00:02:00.000Z");

function leaseRow(ownerId: string) {
  return {
    ...INPUT,
    walletAddress: INPUT.walletAddress.toLowerCase(),
    ownerId,
    acquiredAt: new Date("2030-01-01T00:00:00.000Z"),
    heartbeatAt: new Date("2030-01-01T00:00:00.000Z"),
    expiresAt: EXPIRY,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.release.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Lighter deposit execution lease handle", () => {
  it("re-proves the same random owner before use and releases it exactly", async () => {
    mocks.acquire.mockImplementation(async ({ ownerId }) => leaseRow(ownerId));
    mocks.renew.mockImplementation(async ({ ownerId }) => leaseRow(ownerId));

    const result = await acquireLighterDepositExecutionLease(INPUT);
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;

    await result.handle.assertOwned();
    await result.handle.release();
    await result.handle.release();

    const acquireInput = mocks.acquire.mock.calls[0]![0];
    expect(acquireInput.ownerId).toMatch(/^lighter-deposit:/);
    expect(acquireInput.ttlMs).toBe(120_000);
    expect(mocks.renew).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: acquireInput.ownerId,
      ttlMs: 120_000,
    }));
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith({
      chainId: 1,
      walletAddress: INPUT.walletAddress,
      ownerId: acquireInput.ownerId,
    });
  });

  it("reports the active lease expiry without creating a handle", async () => {
    mocks.acquire.mockResolvedValue(null);
    mocks.get.mockResolvedValue(leaseRow("other-owner"));

    await expect(acquireLighterDepositExecutionLease(INPUT)).resolves.toEqual({
      acquired: false,
      retryAfter: EXPIRY,
    });
    expect(mocks.renew).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("fails closed when ownership cannot be renewed", async () => {
    mocks.acquire.mockImplementation(async ({ ownerId }) => leaseRow(ownerId));
    mocks.renew.mockResolvedValue(null);

    const result = await acquireLighterDepositExecutionLease(INPUT);
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;

    await expect(result.handle.assertOwned()).rejects.toThrow("execution lease was lost");
    await result.handle.release();
  });

  it("heartbeats the lease while confirmation is in progress", async () => {
    vi.useFakeTimers();
    mocks.acquire.mockImplementation(async ({ ownerId }) => leaseRow(ownerId));
    mocks.renew.mockImplementation(async ({ ownerId }) => leaseRow(ownerId));

    const result = await acquireLighterDepositExecutionLease(INPUT);
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.renew).toHaveBeenCalledTimes(1);
    await result.handle.release();
  });
});
