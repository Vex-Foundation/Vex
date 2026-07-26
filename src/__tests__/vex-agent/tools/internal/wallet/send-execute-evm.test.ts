/**
 * executeEvmTransfer — chain-resolution branch tests (Wave 2 batch 2b).
 *
 * Pins the inclusive-resolver wiring:
 *   - source:"local"  → wallet/public clients come from the LOCAL registry
 *     factory (getLocalEvmClients), Khalani factory untouched, tx params pass
 *     through unchanged (native sendTransaction + ERC-20 writeContract).
 *   - source:"khalani" → byte-identical legacy path: createDynamicPublicClient/
 *     createDynamicWalletClient with (khalaniChain, khalaniChains[, pk]), local
 *     factory untouched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseUnits, getAddress } from "viem";

import type { EvmWallet } from "@tools/wallet/multi-auth.js";
import type { WalletIntent } from "@vex-agent/db/repos/wallet-intents.js";

type EvmChainResolverModule = typeof import("@tools/evm-chains/resolver.js");
type EvmClientModule = typeof import("@tools/evm-chains/evm-client.js");
type KhalaniEvmClientModule = typeof import("@tools/khalani/evm-client.js");

// ── Mocks ───────────────────────────────────────────────────────

const mockResolve = vi.fn<EvmChainResolverModule["resolveInclusiveEvmChain"]>();
vi.mock("@tools/evm-chains/resolver.js", () => ({
  resolveInclusiveEvmChain: (...args: Parameters<EvmChainResolverModule["resolveInclusiveEvmChain"]>) => mockResolve(...args),
}));

const localPublicClient = {
  waitForTransactionReceipt: vi.fn(),
  readContract: vi.fn(),
};
const localWalletClient = {
  sendTransaction: vi.fn(),
  writeContract: vi.fn(),
};
const mockGetLocalEvmClients = vi.fn<EvmClientModule["getLocalEvmClients"]>(() => ({
  publicClient: localPublicClient,
  walletClient: localWalletClient,
}));
vi.mock("@tools/evm-chains/evm-client.js", () => ({
  getLocalEvmClients: (...args: Parameters<EvmClientModule["getLocalEvmClients"]>) => mockGetLocalEvmClients(...args),
}));

const khalaniPublicClient = {
  waitForTransactionReceipt: vi.fn(),
  readContract: vi.fn(),
};
const khalaniWalletClient = {
  sendTransaction: vi.fn(),
  writeContract: vi.fn(),
};
const mockCreateDynamicPublicClient = vi.fn<KhalaniEvmClientModule["createDynamicPublicClient"]>(() => khalaniPublicClient);
const mockCreateDynamicWalletClient = vi.fn<KhalaniEvmClientModule["createDynamicWalletClient"]>(() => khalaniWalletClient);
vi.mock("@tools/khalani/evm-client.js", () => ({
  createDynamicPublicClient: (...args: Parameters<KhalaniEvmClientModule["createDynamicPublicClient"]>) => mockCreateDynamicPublicClient(...args),
  createDynamicWalletClient: (...args: Parameters<KhalaniEvmClientModule["createDynamicWalletClient"]>) => mockCreateDynamicWalletClient(...args),
}));

const { executeEvmTransfer } = await import(
  "../../../../../vex-agent/tools/internal/wallet/send-execute-evm.js"
);

// ── Fixtures ────────────────────────────────────────────────────

const PRIVATE_KEY = ("0x" + "1".repeat(64)) as `0x${string}`;
const WALLET: EvmWallet = {
  family: "eip155",
  address: "0xabcdef1234567890abcdef1234567890abcdef12" as EvmWallet["address"],
  privateKey: PRIVATE_KEY,
};
const TO = "0xffcf8fdee72ac11b5c542428b35eef5769c409f0";
const ERC20 = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TX_HASH = "0x" + "ab".repeat(32);

const LOCAL_CONFIG = {
  id: 4663,
  name: "Robinhood Chain",
  family: "eip155" as const,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};

const KHALANI_CHAIN = {
  type: "eip155" as const,
  id: 8453,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};
const KHALANI_CHAINS = [KHALANI_CHAIN];

function makeIntent(overrides: Partial<WalletIntent> = {}): WalletIntent {
  return {
    intentId: "intent-1",
    sessionId: "session-1",
    walletAddress: WALLET.address,
    network: "eip155" as WalletIntent["network"],
    chainAlias: "robinhood",
    toAddress: TO,
    amount: "0.5",
    token: null,
    previewJson: {},
    status: "pending" as WalletIntent["status"],
    expiresAt: "2099-01-01T00:00:00.000Z",
    consumedAt: null,
    cancelledAt: null,
    txHash: null,
    failureReason: null,
    idempotencyKey: null,
    createdAt: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localWalletClient.sendTransaction.mockResolvedValue(TX_HASH);
  localWalletClient.writeContract.mockResolvedValue(TX_HASH);
  localPublicClient.readContract.mockResolvedValue(6);
  localPublicClient.waitForTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 123n });
  khalaniWalletClient.sendTransaction.mockResolvedValue(TX_HASH);
  khalaniPublicClient.waitForTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 456n });
});

// ── Local branch ────────────────────────────────────────────────

describe("executeEvmTransfer — local registry branch", () => {
  beforeEach(() => {
    mockResolve.mockResolvedValue({
      source: "local",
      chainId: 4663,
      family: "eip155",
      config: LOCAL_CONFIG,
    });
  });

  it("builds clients from the LOCAL factory and passes native tx params through", async () => {
    const outcome = await executeEvmTransfer(makeIntent(), WALLET);

    expect(mockResolve).toHaveBeenCalledWith("robinhood");
    // Local factory got the registry config object + the signing key.
    expect(mockGetLocalEvmClients).toHaveBeenCalledWith(LOCAL_CONFIG, PRIVATE_KEY);
    // Khalani factory untouched — no Khalani dependency on this path.
    expect(mockCreateDynamicPublicClient).not.toHaveBeenCalled();
    expect(mockCreateDynamicWalletClient).not.toHaveBeenCalled();

    // Tx params pass through: checksummed recipient, 18-decimals value.
    expect(localWalletClient.sendTransaction).toHaveBeenCalledWith({
      to: getAddress(TO),
      value: parseUnits("0.5", 18),
      chain: undefined,
    });

    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind === "confirmed") {
      expect(outcome.txHash).toBe(TX_HASH);
      expect(outcome.data.chain).toBe("Robinhood Chain");
      const capture = outcome.data._tradeCapture as Record<string, unknown>;
      expect(capture.chain).toBe("Robinhood Chain");
      expect(capture.walletAddress).toBe(WALLET.address);
    }
  });

  it("routes ERC-20 transfers through the local clients (decimals read + writeContract)", async () => {
    const outcome = await executeEvmTransfer(makeIntent({ token: ERC20, amount: "25" }), WALLET);

    // decimals read via the LOCAL public client.
    expect(localPublicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: getAddress(ERC20), functionName: "decimals" }),
    );
    // transfer via the LOCAL wallet client, amount scaled by the read decimals.
    expect(localWalletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: getAddress(ERC20),
        functionName: "transfer",
        args: [getAddress(TO), parseUnits("25", 6)],
        chain: undefined,
      }),
    );
    expect(outcome.kind).toBe("confirmed");
  });
});

// ── Khalani branch regression ───────────────────────────────────

describe("executeEvmTransfer — khalani branch (regression)", () => {
  beforeEach(() => {
    mockResolve.mockResolvedValue({
      source: "khalani",
      chainId: 8453,
      family: "eip155",
      khalaniChain: KHALANI_CHAIN,
      khalaniChains: KHALANI_CHAINS,
    });
  });

  it("keeps the legacy Khalani client path byte-identical (factories + args)", async () => {
    const outcome = await executeEvmTransfer(makeIntent({ chainAlias: "base" }), WALLET);

    expect(mockCreateDynamicPublicClient).toHaveBeenCalledWith(KHALANI_CHAIN, KHALANI_CHAINS);
    expect(mockCreateDynamicWalletClient).toHaveBeenCalledWith(KHALANI_CHAIN, KHALANI_CHAINS, PRIVATE_KEY);
    // Local factory untouched on the Khalani path.
    expect(mockGetLocalEvmClients).not.toHaveBeenCalled();

    expect(khalaniWalletClient.sendTransaction).toHaveBeenCalledWith({
      to: getAddress(TO),
      value: parseUnits("0.5", 18),
      chain: undefined,
    });

    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind === "confirmed") {
      expect(outcome.data.chain).toBe("Base");
    }
  });
});

// ── Resolver failure stays pre-broadcast ────────────────────────

describe("executeEvmTransfer — resolver failure", () => {
  it("maps an unresolvable chain to pre_broadcast_failed (no client built, no tx)", async () => {
    mockResolve.mockRejectedValue(new Error("Unsupported chain: narnia"));

    const outcome = await executeEvmTransfer(makeIntent({ chainAlias: "narnia" }), WALLET);

    expect(outcome.kind).toBe("pre_broadcast_failed");
    expect(mockGetLocalEvmClients).not.toHaveBeenCalled();
    expect(mockCreateDynamicWalletClient).not.toHaveBeenCalled();
    expect(localWalletClient.sendTransaction).not.toHaveBeenCalled();
    expect(khalaniWalletClient.sendTransaction).not.toHaveBeenCalled();
  });
});
