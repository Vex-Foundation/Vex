import { describe, expect, it } from "vitest";

import {
  resolveRelayOnlyPublicClient,
  resolveRelayOnlyStepClients,
} from "@tools/relay/chain-client.js";
import type { RelayChain } from "@tools/relay/types.js";

const PRIVATE_KEY = `0x${"11".repeat(32)}` as `0x${string}`;

describe("Relay public metadata client", () => {
  it("refuses a Relay EVM chain that has no public HTTPS RPC", () => {
    const chain: RelayChain = { id: 999, name: "relay-only", vmType: "evm" };
    expect(() => resolveRelayOnlyPublicClient(999, [chain])).toThrow(/no safe public HTTPS RPC/);
  });

  it("constructs a credential-free client for the exact Relay registry chain", () => {
    const chain: RelayChain = {
      id: 999,
      name: "relay-only",
      vmType: "evm",
      currency: { name: "Ether", symbol: "ETH", decimals: 18 },
      httpRpcUrl: "https://rpc.example.com",
    };
    const client = resolveRelayOnlyPublicClient(999, [chain]);
    expect(client.chain?.id).toBe(999);
    const signing = resolveRelayOnlyStepClients(999, [chain], PRIVATE_KEY);
    expect(signing.publicClient.chain?.id).toBe(999);
    expect(signing.walletClient.chain?.id).toBe(999);
  });

  it.each([
    {
      label: "missing registry entry",
      chainId: 999,
      chains: [] as RelayChain[],
      error: /not in the Relay registry/,
    },
    {
      label: "non-EVM chain",
      chainId: 999,
      chains: [{ id: 999, name: "solana", vmType: "svm", httpRpcUrl: "https://rpc.example.com" }] as RelayChain[],
      error: /not an EVM chain/,
    },
    {
      label: "unsafe RPC",
      chainId: 999,
      chains: [{ id: 999, name: "unsafe", vmType: "evm", httpRpcUrl: "http://127.0.0.1" }] as RelayChain[],
      error: /no safe public HTTPS RPC/,
    },
  ])("applies the same refusal to public and signing clients: $label", ({ chainId, chains, error }) => {
    expect(() => resolveRelayOnlyPublicClient(chainId, chains)).toThrow(error);
    expect(() => resolveRelayOnlyStepClients(chainId, chains, PRIVATE_KEY)).toThrow(error);
  });
});
