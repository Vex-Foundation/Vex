import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";

import { ErrorCodes } from "../../errors.js";
import {
  ARBITRUM_NATIVE_USDC_ADDRESS,
  ARBITRUM_ONE_CHAIN_ID,
  HYPERLIQUID_BRIDGE2_MAINNET_ADDRESS,
  HYPERLIQUID_BRIDGE2_MIN_DEPOSIT_USDC,
} from "@tools/hyperliquid/constants.js";
import { executeHyperliquidBridge2Deposit } from "@tools/hyperliquid/deposit.js";
import {
  HYPERLIQUID_HANDLERS,
  hyperliquidDepositCapture,
} from "@vex-agent/tools/protocols/hyperliquid/handlers.js";
import { HYPERLIQUID_TOOLS } from "@vex-agent/tools/protocols/hyperliquid/manifest.js";
import { lintEmbeddingPassage } from "@vex-agent/tools/protocols/_embedding-lint.js";
import { validateCaptureContract } from "@vex-agent/tools/protocols/capture-validator.js";
import { MUTATION_MATRIX } from "@vex-agent/tools/protocols/mutation-matrix.js";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hex;
const initialHyperliquidNetwork = process.env.VEX_HYPERLIQUID_NETWORK;

function clients(balance: bigint, receiptStatus: "success" | "reverted" = "success") {
  const readContract = vi.fn().mockResolvedValue(balance);
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: receiptStatus });
  const writeContract = vi.fn().mockResolvedValue(HASH);
  return {
    clients: {
      publicClient: { readContract, waitForTransactionReceipt },
      walletClient: { account: { address: OWNER }, writeContract },
    } as never,
    readContract,
    waitForTransactionReceipt,
    writeContract,
  };
}

afterEach(() => {
  if (initialHyperliquidNetwork === undefined) delete process.env.VEX_HYPERLIQUID_NETWORK;
  else process.env.VEX_HYPERLIQUID_NETWORK = initialHyperliquidNetwork;
});

describe("Hyperliquid Bridge2 deposit", () => {
  it("pins the official mainnet Bridge2 and native-USDC addresses", () => {
    // Sources: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/bridge2
    // https://arbiscan.io/address/0x2df1c51e09aecf9cacb7bc98cb1742757f163df7 , and
    // https://arbiscan.io/token/0xaf88d065e77c8cC2239327C5EDb3A432268e5831 .
    expect(ARBITRUM_ONE_CHAIN_ID).toBe(42_161);
    expect(ARBITRUM_NATIVE_USDC_ADDRESS).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
    expect(HYPERLIQUID_BRIDGE2_MAINNET_ADDRESS).toBe("0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7");
    expect(HYPERLIQUID_BRIDGE2_MIN_DEPOSIT_USDC).toBe("5");
  });

  it("exposes only amountUsd as a user-wallet broadcast with a valid discovery passage", () => {
    const manifest = HYPERLIQUID_TOOLS.find((tool) => tool.toolId === "hyperliquid.deposit");
    expect(manifest).toMatchObject({
      mutating: true,
      actionKind: "user_wallet_broadcast",
      params: [{ key: "amountUsd", type: "string", required: true }],
    });
    if (!manifest) throw new Error("Missing Hyperliquid deposit manifest.");
    expect(lintEmbeddingPassage(manifest.toolId, manifest.discovery?.embeddingText ?? "", manifest.mutating)).toEqual([]);
  });

  it("rejects deposits below 5 USDC before chain IO because they are permanently lost", async () => {
    const mock = clients(10_000_000n);
    await expect(executeHyperliquidBridge2Deposit({ network: "mainnet", amountUsd: "4.999999", owner: OWNER }, mock.clients))
      .rejects.toMatchObject({
        code: ErrorCodes.INVALID_AMOUNT,
        message: expect.stringContaining("permanently lost"),
      });
    expect(mock.readContract).not.toHaveBeenCalled();
    expect(mock.writeContract).not.toHaveBeenCalled();
  });

  it("fails the native-USDC balance preflight without broadcasting", async () => {
    const mock = clients(4_999_999n);
    await expect(executeHyperliquidBridge2Deposit({ network: "mainnet", amountUsd: "5", owner: OWNER }, mock.clients))
      .rejects.toMatchObject({ code: ErrorCodes.INSUFFICIENT_BALANCE });
    expect(mock.readContract).toHaveBeenCalledOnce();
    expect(mock.writeContract).not.toHaveBeenCalled();
  });

  it("fails closed under VEX_HYPERLIQUID_NETWORK=testnet before wallet resolution", async () => {
    process.env.VEX_HYPERLIQUID_NETWORK = "testnet";
    const handler = HYPERLIQUID_HANDLERS["hyperliquid.deposit"];
    if (!handler) throw new Error("Missing Hyperliquid deposit handler.");

    await expect(handler({ amountUsd: "5" }, {} as never)).resolves.toMatchObject({
      success: false,
      output: expect.stringContaining("mainnet-only"),
    });
  });

  it("transfers the exact native-USDC amount to the pinned Bridge2 contract", async () => {
    const mock = clients(5_000_000n);
    await expect(executeHyperliquidBridge2Deposit({ network: "mainnet", amountUsd: "5", owner: OWNER }, mock.clients))
      .resolves.toEqual({ amountBaseUnits: 5_000_000n, txHash: HASH });
    expect(mock.writeContract).toHaveBeenCalledWith(expect.objectContaining({
      address: ARBITRUM_NATIVE_USDC_ADDRESS,
      functionName: "transfer",
      args: [HYPERLIQUID_BRIDGE2_MAINNET_ADDRESS, 5_000_000n],
    }));
    expect(mock.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: HASH });
  });

  it("records the deposit as an audit-only funding capture accepted by the mutation contract", () => {
    const capture = hyperliquidDepositCapture(OWNER, "5", HASH);
    expect(capture).toMatchObject({
      type: "transfer",
      chain: "arbitrum",
      status: "executed",
      walletAddress: OWNER,
      meta: {
        action: "bridge2Deposit",
        bridgeAddress: HYPERLIQUID_BRIDGE2_MAINNET_ADDRESS,
        creditedTo: OWNER,
      },
    });
    expect(MUTATION_MATRIX.get("hyperliquid.deposit")).toMatchObject({
      role: "audit",
      capture: "full",
      expectedType: "transfer",
    });
    expect(validateCaptureContract("hyperliquid.deposit", capture)).toBe(true);
  });

  it("fails loudly when the mined Bridge2 transfer reverted", async () => {
    const mock = clients(5_000_000n, "reverted");
    await expect(executeHyperliquidBridge2Deposit({ network: "mainnet", amountUsd: "5", owner: OWNER }, mock.clients))
      .rejects.toMatchObject({
        code: ErrorCodes.HYPERLIQUID_DEPOSIT_FAILED,
        message: expect.stringContaining(HASH),
      });
    expect(mock.writeContract).toHaveBeenCalledOnce();
  });
});
