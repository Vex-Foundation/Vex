/**
 * W1 (SPEC §1.5): the `ambiguous` staged-broadcast outcome carries a SANITIZED
 * reason.
 *
 * Ambiguity still never terminalizes the durable row — that contract is
 * untouched. What changes is that "the RPC rate-limited the send" and "not
 * mined yet" stop being the same silent verdict: the caller can now log, and
 * the agent can now be told, why the stage could not be resolved, without any
 * provider bytes escaping the redactor.
 */

import { describe, it, expect, vi } from "vitest";

import { signStageBroadcast } from "@tools/evm-chains/staged-broadcast.js";

const ACCOUNT = { address: "0x1111111111111111111111111111111111111111" } as const;

const TX = {
  to: "0x2222222222222222222222222222222222222222",
  data: "0x00",
} as const;

function walletClient(): unknown {
  return {
    chain: { id: 8453 },
    account: ACCOUNT,
    prepareTransactionRequest: vi.fn().mockResolvedValue({ nonce: 7 }),
    signTransaction: vi.fn().mockResolvedValue("0xdeadbeef"),
  };
}

const HOOKS = () => ({ onHashStaged: vi.fn(), onAccepted: vi.fn() });

describe("signStageBroadcast — the ambiguous variant names its reason", () => {
  it("carries the sanitized send failure", async () => {
    const publicClient = {
      estimateGas: vi.fn().mockResolvedValue(100_000n),
      sendRawTransaction: vi.fn().mockRejectedValue(
        new Error("rpc rejected: 429 too many requests https://rpc.example/v1?apikey=SECRETVALUE"),
      ),
      waitForTransactionReceipt: vi.fn(),
    };

    const result = await signStageBroadcast(
      publicClient as never,
      walletClient() as never,
      TX,
      HOOKS(),
    );

    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.stage).toBe("send");
    expect(result.reason).toContain("429");
    expect(result.reason).not.toContain("SECRETVALUE");
    expect(result.reason).not.toContain("rpc.example");
  });

  it("carries the sanitized receipt-wait failure", async () => {
    const publicClient = {
      estimateGas: vi.fn().mockResolvedValue(100_000n),
      sendRawTransaction: vi.fn().mockResolvedValue("0xhash"),
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error("receipt not found")),
    };

    const result = await signStageBroadcast(
      publicClient as never,
      walletClient() as never,
      TX,
      HOOKS(),
      undefined,
      { delayMs: 0 },
    );

    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.stage).toBe("confirm");
    expect(result.reason).toContain("receipt not found");
  });
});
