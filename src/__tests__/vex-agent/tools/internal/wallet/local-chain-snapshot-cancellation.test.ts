/**
 * `readLocalChainSnapshot` treats a caller's Stop as a CANCELLATION, never as a
 * degraded chain read.
 *
 * WHY THIS FILE EXISTS. The Blockscout client correctly throws on abort, but
 * this lane's fail-soft catch used to swallow that throw into
 * `{ ok: false, message: "local chain RPC read failed: ..." }` - a per-chain
 * error like any other. `WalletBalances` survives a per-chain error by design,
 * so a stopped turn could publish a successful-looking envelope in which the
 * user's Stop appears as a chain that happened to be down. Cancelled is a
 * distinct state (rule 05), and the whole read must reject.
 *
 * The two halves pull in opposite directions and both are pinned here: an abort
 * must propagate, and a genuine provider failure must STILL degrade softly, or
 * one dead RPC would take a whole wallet answer down with it.
 *
 * Ordering is established with a gate the test resolves, never a wall-clock
 * sleep, so the abort is guaranteed to land while the read is in flight
 * (structure follows vscode's own cancellation tests, e.g.
 * `src/vs/platform/files/test/browser/fileService.test.ts`, which gates the
 * provider on a deferred promise and then asserts the operation rejected).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const CHAIN_ID = 4663;
const WALLET = "0x1234567890abcdef1234567890abcdef12345678";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockBuildInventory = vi.fn();
vi.mock("@vex-agent/sync/local-chain-balance-sync.js", () => ({
  buildLocalChainInventory: (...args: unknown[]) => mockBuildInventory(...args),
}));

const mockReadBalances = vi.fn();
vi.mock("@tools/evm-chains/balances.js", () => ({
  readLocalChainBalances: (...args: unknown[]) => mockReadBalances(...args),
}));

const { readLocalChainSnapshot } = await import(
  "@vex-agent/tools/internal/wallet/local-chain-snapshot.js"
);

/** An empty but well-formed scan set for the chain under test. */
function emptyScan() {
  return {
    chainId: CHAIN_ID,
    entries: [],
    addresses: [],
    exhaustive: true,
    droppedAddresses: [],
    indexer: null,
  };
}

/** A read that answered nothing: no native balance, no tokens, no failures. */
function emptyRead() {
  return {
    nativeWei: 0n,
    nativePriceUsd: null,
    tokens: [],
    tokenFailures: [],
    priceTiers: { tier0: 0, tier1: 0, unpriced: 0 },
  };
}

/**
 * A gate the test opens by hand. `open` resolves the promise the scripted
 * provider is parked on, so the abort is observably inside the read.
 */
function gate(): { waited: Promise<void>; reached: Promise<void>; open: () => void } {
  let open = (): void => {};
  let signalReached = (): void => {};
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  const waited = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return {
    waited: (async () => {
      signalReached();
      await waited;
    })(),
    reached,
    open,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildInventory.mockResolvedValue(emptyScan());
  mockReadBalances.mockResolvedValue(emptyRead());
});

describe("readLocalChainSnapshot - cancellation", () => {
  it("REJECTS when the enumeration throws the caller's abort", async () => {
    const controller = new AbortController();
    const barrier = gate();
    mockBuildInventory.mockImplementation(async () => {
      await barrier.waited;
      controller.signal.throwIfAborted();
      return emptyScan();
    });

    const promise = readLocalChainSnapshot(WALLET, CHAIN_ID, controller.signal);
    await barrier.reached;
    controller.abort();
    barrier.open();

    // Not `{ ok: false }`: a stopped turn must not be reportable as a chain
    // that merely failed to answer.
    await expect(promise).rejects.toThrow();
    expect(mockReadBalances).not.toHaveBeenCalled();
  });

  it("REJECTS when the abort lands inside a balance read that raises nothing", async () => {
    // `readLocalChainBalances` takes no signal, so a Stop during it produces no
    // throw at all. Without the publication-point check this returned a full,
    // successful snapshot out of a cancelled turn.
    const controller = new AbortController();
    const barrier = gate();
    mockReadBalances.mockImplementation(async () => {
      await barrier.waited;
      return emptyRead();
    });

    const promise = readLocalChainSnapshot(WALLET, CHAIN_ID, controller.signal);
    await barrier.reached;
    controller.abort();
    barrier.open();

    await expect(promise).rejects.toThrow();
  });

  it("REJECTS rather than degrading when a provider error follows the abort", async () => {
    // The exact swallow this fixes: the client throws, and the abort must win
    // over the fail-soft mapping regardless of which error object arrived.
    const controller = new AbortController();
    const barrier = gate();
    mockBuildInventory.mockImplementation(async () => {
      await barrier.waited;
      throw new Error("blockscout: aborted");
    });

    const promise = readLocalChainSnapshot(WALLET, CHAIN_ID, controller.signal);
    await barrier.reached;
    controller.abort();
    barrier.open();

    await expect(promise).rejects.toThrow();
  });
});

describe("readLocalChainSnapshot - fail-soft is preserved", () => {
  it("still degrades a genuine provider failure into a per-chain error", async () => {
    mockReadBalances.mockRejectedValue(new Error("rpc 502 bad gateway"));

    const result = await readLocalChainSnapshot(WALLET, CHAIN_ID, undefined);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a degraded result");
    expect(result.message).toContain("local chain RPC read failed");
    // The enumeration that DID complete is carried out, so the caller can still
    // report what the chain could and could not claim.
    expect(result.scan?.chainId).toBe(CHAIN_ID);
  });

  it("returns a snapshot for an uncancelled read", async () => {
    const controller = new AbortController();

    const result = await readLocalChainSnapshot(WALLET, CHAIN_ID, controller.signal);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a successful snapshot");
    expect(result.tokens).toEqual([]);
    expect(result.tokenErrors).toEqual([]);
  });
});
