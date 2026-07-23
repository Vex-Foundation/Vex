import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { VexError, ErrorCodes } from "../../errors.js";
import { parseBigintish } from "@tools/khalani/bridge-executor.js";
import type {
  ContractCallDepositPlan,
  DepositPlan,
  KhalaniChain,
  Permit2DepositPlan,
  TransferDepositPlan,
} from "@tools/khalani/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ETH_CHAIN: KhalaniChain = {
  type: "eip155",
  id: 1,
  name: "Ethereum",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://eth.example"] } },
  blockExplorers: { default: { name: "Etherscan", url: "https://etherscan.io" } },
};

const SOL_CHAIN: KhalaniChain = {
  type: "solana",
  id: 20011000000,
  name: "Solana",
  nativeCurrency: { name: "Sol", symbol: "SOL", decimals: 9 },
  rpcUrls: { default: { http: ["https://solana.example"] } },
};

const CHAINS: KhalaniChain[] = [ETH_CHAIN, SOL_CHAIN];

// We test parseBigintish directly (already imported at top-level).
// For executeDepositPlan and friends, we mock the heavy dependencies.

// 5D-protocols p4: executeDepositPlan now takes an explicit source-family signer
// (the executor no longer resolves a wallet itself).
const EVM_SIGNER = {
  family: "eip155" as const,
  address: "0x9f7cF98a82462575a3b25C664BfBE5dCeCF3dec2" as `0x${string}`,
  privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
};
const SOL_SIGNER = {
  family: "solana" as const,
  address: "11111111111111111111111111111111",
  secretKey: new Uint8Array(64),
};

const mockSendTransaction = vi.fn(async (): Promise<`0x${string}`> => "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
const mockWriteContract = vi.fn(async (): Promise<`0x${string}`> => "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
const mockWaitForTransactionReceipt = vi.fn(async () => ({ status: "success" as const }));
const mockSubmitDeposit = vi.fn(async () => ({
  orderId: "order-123",
  txHash: "0xdeadbeef",
}));

vi.mock("@tools/khalani/evm-client.js", () => ({
  createDynamicWalletClient: vi.fn(() => ({
    sendTransaction: mockSendTransaction,
    writeContract: mockWriteContract,
  })),
  createDynamicPublicClient: vi.fn(() => ({
    waitForTransactionReceipt: mockWaitForTransactionReceipt,
  })),
}));

vi.mock("@tools/khalani/solana-signer.js", () => ({
  signAndSendSolanaTransaction: vi.fn(async () => "5xFakeSignature123456789"),
}));

vi.mock("@tools/khalani/client.js", () => ({
  getKhalaniClient: vi.fn(() => ({
    submitDeposit: mockSubmitDeposit,
  })),
}));

vi.mock("@tools/khalani/chains.js", () => ({
  getChainRpcUrl: vi.fn(() => "https://eth.example"),
}));

describe("parseBigintish", () => {
  it("returns undefined for null/undefined", () => {
    expect(parseBigintish(null, "test")).toBeUndefined();
    expect(parseBigintish(undefined, "test")).toBeUndefined();
  });

  it("parses bigint directly", () => {
    expect(parseBigintish(42n, "test")).toBe(42n);
  });

  it("parses number", () => {
    expect(parseBigintish(42, "test")).toBe(42n);
  });

  it("parses string", () => {
    expect(parseBigintish("42", "test")).toBe(42n);
  });

  it("parses hex string", () => {
    expect(parseBigintish("0x2a", "test")).toBe(42n);
  });

  it("throws for invalid string", () => {
    expect(() => parseBigintish("abc", "test")).toThrow("Invalid bigint");
  });
});

describe("executeDepositPlan", () => {
  let executeDepositPlan: typeof import("@tools/khalani/bridge-executor.js").executeDepositPlan;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockWaitForTransactionReceipt.mockResolvedValue({ status: "success" });
    mockSubmitDeposit.mockResolvedValue({
      orderId: "order-123",
      txHash: "0xdeadbeef",
    });
    const mod = await import("@tools/khalani/bridge-executor.js");
    executeDepositPlan = mod.executeDepositPlan;
  });

  // Adapter: positional call sites → object args, with a source-family signer.
  function run(plan: DepositPlan, sourceChain: KhalaniChain, signer: typeof EVM_SIGNER | typeof SOL_SIGNER = EVM_SIGNER) {
    return executeDepositPlan({ plan, sourceChain, chains: CHAINS, quoteId: "q1", routeId: "r1", signer });
  }

  it("blocks PERMIT2 plans with KHALANI_PERMIT2_BLOCKED", async () => {
    const permit2Plan: Permit2DepositPlan = {
      kind: "PERMIT2",
      permit: { domain: {} },
      transferDetails: { to: "0x1" },
    };

    await expect(
      run(permit2Plan, ETH_CHAIN),
    ).rejects.toMatchObject({
      code: ErrorCodes.KHALANI_PERMIT2_BLOCKED,
    });
  });

  it("routes EVM CONTRACT_CALL to executeEvmContractCallPlan", async () => {
    const plan: ContractCallDepositPlan = {
      kind: "CONTRACT_CALL",
      approvals: [
        {
          type: "eip1193_request",
          request: {
            method: "eth_sendTransaction",
            params: [{ to: "0x2222222222222222222222222222222222222222", data: "0x", value: "0x0" }],
          },
          deposit: true,
        },
      ],
    };

    const result = await run(plan, ETH_CHAIN);
    expect(result).toHaveProperty("orderId");
    expect(result).toHaveProperty("txHash");
  });

  it("submits the hash from the action flagged as deposit=true", async () => {
    mockSendTransaction
      .mockResolvedValueOnce("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
      .mockResolvedValueOnce("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    const plan: ContractCallDepositPlan = {
      kind: "CONTRACT_CALL",
      approvals: [
        {
          type: "eip1193_request",
          request: {
            method: "eth_sendTransaction",
            params: [{ to: "0x2222222222222222222222222222222222222222", data: "0x", value: "0x0" }],
          },
        },
        {
          type: "eip1193_request",
          request: {
            method: "eth_sendTransaction",
            params: [{ to: "0x3333333333333333333333333333333333333333", data: "0x", value: "0x0" }],
          },
          deposit: true,
        },
      ],
    };

    await run(plan, ETH_CHAIN);

    expect(mockSubmitDeposit).toHaveBeenCalledWith(expect.objectContaining({
      txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }));
  });

  it("does not wait when Khalani marks an EVM approval broadcast-only", async () => {
    const plan: ContractCallDepositPlan = {
      kind: "CONTRACT_CALL",
      approvals: [{
        type: "eip1193_request",
        request: {
          method: "eth_sendTransaction",
          params: [{ to: "0x2222222222222222222222222222222222222222", data: "0x", value: "0x0" }],
        },
        waitForReceipt: false,
        deposit: true,
      }],
    };

    await run(plan, ETH_CHAIN);
    expect(mockWaitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("never submits a reverted EVM transfer deposit to Khalani", async () => {
    mockWaitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    const plan: TransferDepositPlan = {
      kind: "TRANSFER",
      token: "native",
      amount: "1",
      depositAddress: "0x2222222222222222222222222222222222222222",
    };

    await expect(run(plan, ETH_CHAIN)).rejects.toMatchObject({ code: ErrorCodes.KHALANI_DEPOSIT_FAILED });
    expect(mockSubmitDeposit).not.toHaveBeenCalled();
  });

  it("routes Solana CONTRACT_CALL to executeSolanaContractCallPlan", async () => {
    const plan: ContractCallDepositPlan = {
      kind: "CONTRACT_CALL",
      approvals: [
        {
          type: "solana_sendTransaction",
          transaction: "base64txdata",
          deposit: true,
        },
      ],
    };

    const result = await run(plan, SOL_CHAIN, SOL_SIGNER);
    expect(result).toHaveProperty("orderId");
    expect(result).toHaveProperty("txHash");
  });

  it("throws when EVM CONTRACT_CALL yields no deposit txHash (only wallet_switchEthereumChain)", async () => {
    const plan: ContractCallDepositPlan = {
      kind: "CONTRACT_CALL",
      approvals: [
        {
          type: "eip1193_request",
          request: {
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x1" }],
          },
        },
      ],
    };

    await expect(
      run(plan, ETH_CHAIN),
    ).rejects.toMatchObject({
      code: ErrorCodes.KHALANI_DEPOSIT_FAILED,
    });
  });

  it("throws when EVM CONTRACT_CALL omits deposit=true", async () => {
    const plan: ContractCallDepositPlan = {
      kind: "CONTRACT_CALL",
      approvals: [
        {
          type: "eip1193_request",
          request: {
            method: "eth_sendTransaction",
            params: [{ to: "0x2222222222222222222222222222222222222222", data: "0x", value: "0x0" }],
          },
        },
      ],
    };

    await expect(
      run(plan, ETH_CHAIN),
    ).rejects.toMatchObject({
      code: ErrorCodes.KHALANI_DEPOSIT_FAILED,
    });
  });

  it("throws CHAIN_MISMATCH when wallet_switchEthereumChain requests a different chain", async () => {
    const plan: ContractCallDepositPlan = {
      kind: "CONTRACT_CALL",
      approvals: [
        {
          type: "eip1193_request",
          request: {
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x89" }], // 137 = polygon, but route is ETH chain 1
          },
        },
      ],
    };

    await expect(
      run(plan, ETH_CHAIN),
    ).rejects.toMatchObject({
      code: ErrorCodes.CHAIN_MISMATCH,
    });
  });

  it("executes TRANSFER plan for EVM chain", async () => {
    const plan: TransferDepositPlan = {
      kind: "TRANSFER",
      depositAddress: "0x3333333333333333333333333333333333333333",
      amount: "1000000",
      token: "0x4444444444444444444444444444444444444444",
      chainId: 1,
    };

    const result = await run(plan, ETH_CHAIN);
    expect(result).toHaveProperty("orderId");
    expect(result).toHaveProperty("txHash");
  });

  it("rejects TRANSFER plan for Solana chain (not implemented)", async () => {
    const plan: TransferDepositPlan = {
      kind: "TRANSFER",
      depositAddress: "11111111111111111111111111111111",
      amount: "1000000",
      token: "native",
      chainId: 20011000000,
    };

    await expect(
      run(plan, SOL_CHAIN, SOL_SIGNER),
    ).rejects.toMatchObject({
      code: ErrorCodes.KHALANI_DEPOSIT_FAILED,
    });
  });

  it("sends native transfer when token is the zero address", async () => {
    const plan: TransferDepositPlan = {
      kind: "TRANSFER",
      depositAddress: "0x3333333333333333333333333333333333333333",
      amount: "1000000",
      token: "0x0000000000000000000000000000000000000000",
      chainId: 1,
    };

    const result = await run(plan, ETH_CHAIN);
    expect(result).toHaveProperty("orderId");
  });

  it("handles EVM approval with unsupported method", async () => {
    const plan: ContractCallDepositPlan = {
      kind: "CONTRACT_CALL",
      approvals: [
        {
          type: "eip1193_request",
          request: {
            method: "personal_sign",
            params: [],
          },
        },
      ],
    };

    await expect(
      run(plan, ETH_CHAIN),
    ).rejects.toMatchObject({
      code: ErrorCodes.KHALANI_DEPOSIT_FAILED,
    });
  });

  it("rejects an EVM source paired with a Solana signer (family guard, no submit)", async () => {
    const plan: ContractCallDepositPlan = {
      kind: "CONTRACT_CALL",
      approvals: [
        {
          type: "eip1193_request",
          request: {
            method: "eth_sendTransaction",
            params: [{ to: "0x2222222222222222222222222222222222222222", data: "0x", value: "0x0" }],
          },
          deposit: true,
        },
      ],
    };
    // EVM source dispatches to the EVM executor, whose family guard rejects a
    // Solana signer before any broadcast — never falls back to a primary wallet.
    await expect(run(plan, ETH_CHAIN, SOL_SIGNER)).rejects.toMatchObject({
      code: ErrorCodes.KHALANI_DEPOSIT_FAILED,
    });
    expect(mockSubmitDeposit).not.toHaveBeenCalled();
  });
});

describe("bridge-executor source-family signer regression", () => {
  it("bridge-executor.ts no longer imports the zero-arg signer primitives", () => {
    const src = readFileSync(join(process.cwd(), "src/tools/khalani/bridge-executor.ts"), "utf-8");
    expect(/\brequireEvmWallet\b/.test(src) || /\brequireSolanaWallet\b/.test(src)).toBe(false);
  });
});
