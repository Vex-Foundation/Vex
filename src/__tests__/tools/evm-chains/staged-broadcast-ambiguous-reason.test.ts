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
import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { mainnet } from "viem/chains";

import { signStageBroadcast } from "@tools/evm-chains/staged-broadcast.js";

const ACCOUNT_ADDRESS = "0x1111111111111111111111111111111111111111" as Address;

const TX = {
  to: "0x2222222222222222222222222222222222222222" as Address,
  data: "0x00" as Hex,
} as const;

/**
 * The three RPC actions this path drives, replaced on a real viem client so the
 * doubles are checked against viem's own contract.
 */
type BroadcastReads = Pick<
  PublicClient<Transport, Chain>,
  "estimateGas" | "sendRawTransaction" | "waitForTransactionReceipt"
>;

function publicClient(reads: Partial<BroadcastReads>): PublicClient<Transport, Chain> {
  const client: PublicClient<Transport, Chain> = createPublicClient({
    chain: mainnet,
    transport: http("http://127.0.0.1:1"),
  });
  return Object.assign(client, reads);
}

function walletClient(): WalletClient<Transport, Chain, Account> {
  const client = createWalletClient({
    account: ACCOUNT_ADDRESS,
    chain: mainnet,
    transport: http("http://127.0.0.1:1"),
  });
  return Object.assign(client, {
    prepareTransactionRequest: vi.fn().mockResolvedValue({ nonce: 7 }),
    signTransaction: vi.fn().mockResolvedValue("0xdeadbeef" as Hex),
  });
}

const HOOKS = () => ({ onHashStaged: vi.fn(), onAccepted: vi.fn() });

describe("signStageBroadcast — the ambiguous variant names its reason", () => {
  it("carries the sanitized send failure", async () => {
    const client = publicClient({
      estimateGas: vi.fn().mockResolvedValue(100_000n),
      sendRawTransaction: vi.fn().mockRejectedValue(
        new Error("rpc rejected: 429 too many requests https://rpc.example/v1?apikey=SECRETVALUE"),
      ),
      waitForTransactionReceipt: vi.fn(),
    });

    const result = await signStageBroadcast(
      client,
      walletClient(),
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
    const client = publicClient({
      estimateGas: vi.fn().mockResolvedValue(100_000n),
      sendRawTransaction: vi.fn().mockResolvedValue("0xhash" as Hex),
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error("receipt not found")),
    });

    const result = await signStageBroadcast(
      client,
      walletClient(),
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
