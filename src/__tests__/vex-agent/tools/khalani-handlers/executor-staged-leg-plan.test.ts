import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress } from "viem";

import { planKhalaniDepositLegs } from "@tools/khalani/bridge-executor.js";

const BASE_CHAIN = {
  id: 8453,
  name: "Base",
  type: "eip155" as const,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
};
const EVM_ADDRESS = getAddress("0x1234567890abcdef1234567890abcdef12345678");

/**
 * Vex's own view of the bridge. The role-classification plan below approves
 * 100 units of `EVM_ADDRESS` to the deposit target, so the binding names that
 * token and that principal; anything else would be refused by rule 2 of
 * `@tools/evm-chains/erc20-approve-step-guard.ts`.
 */
const ORIGIN = {
  fromToken: EVM_ADDRESS,
  wallet: getAddress("0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA"),
  bridgedAmountRaw: "100",
};

describe("bridge-executor — planKhalaniDepositLegs", () => {
  it("classifies roles: deposit → bridge_deposit, approve(0) → allowance_reset, other approve → allowance", async () => {
    const resetCalldata = encodeFunctionData({
      abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }],
      functionName: "approve",
      args: [EVM_ADDRESS, 0n],
    });
    const grantCalldata = encodeFunctionData({
      abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }],
      functionName: "approve",
      args: [EVM_ADDRESS, 100n],
    });
    const plan = {
      kind: "CONTRACT_CALL" as const,
      approvals: [
        { type: "eip1193_request" as const, request: { method: "eth_sendTransaction", params: [{ to: EVM_ADDRESS, data: resetCalldata }] } },
        { type: "eip1193_request" as const, request: { method: "eth_sendTransaction", params: [{ to: EVM_ADDRESS, data: grantCalldata }] } },
        { type: "eip1193_request" as const, request: { method: "eth_sendTransaction", params: [{ to: EVM_ADDRESS, data: "0xdeadbeef" }] }, deposit: true },
      ],
    };
    const legs = planKhalaniDepositLegs(plan, BASE_CHAIN, null, ORIGIN);
    expect(legs.map((leg) => leg.role)).toEqual(["allowance_reset", "allowance", "bridge_deposit"]);
    expect(legs.filter((leg) => leg.isDeposit)).toHaveLength(1);
  });

  it("skips a wallet_switchEthereumChain approval (not a broadcast)", async () => {
    const plan = {
      kind: "CONTRACT_CALL" as const,
      approvals: [
        { type: "eip1193_request" as const, request: { method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] } },
        { type: "eip1193_request" as const, request: { method: "eth_sendTransaction", params: [{ to: EVM_ADDRESS, data: "0xdead" }] }, deposit: true },
      ],
    };
    const legs = planKhalaniDepositLegs(plan, BASE_CHAIN, null, ORIGIN);
    expect(legs).toHaveLength(1);
    expect(legs.at(0)?.role).toBe("bridge_deposit");
  });

  it("blocks PERMIT2", async () => {
    expect(() => planKhalaniDepositLegs({ kind: "PERMIT2", permit: {}, transferDetails: {} }, BASE_CHAIN, null, ORIGIN)).toThrow(/PERMIT2/);
  });

  it("plans nothing from a CONTRACT_CALL with no deposit leg", async () => {
    // The refusal now comes from the approval binding rather than the
    // deposit-count rule: a non-deposit call in a plan that makes no deposit
    // authorizes nothing, so it is refused before the count is reached
    // (`@tools/evm-chains/erc20-approve-step-guard.ts`). Same fail-closed
    // outcome, an earlier and more specific cause.
    const plan = { kind: "CONTRACT_CALL" as const, approvals: [{ type: "eip1193_request" as const, request: { method: "eth_sendTransaction", params: [{ to: EVM_ADDRESS, data: "0xdead" }] } }] };
    expect(() => planKhalaniDepositLegs(plan, BASE_CHAIN, null, ORIGIN)).toThrow(/token approval/i);
  });

  it("still refuses a plan that marks more than one deposit leg", async () => {
    const depositCall = (data: string) => ({
      type: "eip1193_request" as const,
      request: { method: "eth_sendTransaction", params: [{ to: EVM_ADDRESS, data }] },
      deposit: true,
    });
    const plan = { kind: "CONTRACT_CALL" as const, approvals: [depositCall("0xdead"), depositCall("0xbeef")] };
    expect(() => planKhalaniDepositLegs(plan, BASE_CHAIN, null, ORIGIN)).toThrow(/more than one action with deposit=true/);
  });
});
