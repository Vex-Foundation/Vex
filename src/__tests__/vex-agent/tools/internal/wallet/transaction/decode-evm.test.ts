/**
 * EVM decode GOLDENS, including the REFUSAL SET.
 *
 * The refusals are the point. An accept-only golden proves the decoder can
 * describe five known layouts; it says nothing about the property the money
 * path depends on, which is that everything else STOPS before an intent row
 * exists. Each refusal below is a case that, admitted, would put a sentence in
 * front of a user that nothing derived from the bytes being signed.
 *
 * No network: `eth_getCode` arrives through a one-method seam, and the tests
 * state what the chain answers.
 */

import { describe, it, expect } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";

import { decodeEvmTransaction, type EvmCodeReader } from
  "@vex-agent/tools/internal/wallet/transaction/decode-evm.js";
import { canonicalPermit2Address, PERMIT2_ABI } from
  "@vex-agent/tools/internal/wallet/transaction/permit2.js";
import { buildTransactionPreview } from
  "@vex-agent/tools/internal/wallet/transaction/preview.js";
import { computeProposalDigest, type ProposalDigestInput } from
  "@vex-agent/tools/internal/wallet/transaction/proposal-digest.js";
import type {
  DecodedEvmCall,
  WalletTransactionFeeBounds,
} from "@vex-agent/db/contracts/wallet-transaction-intent.js";

const BASE = 8453;
const EOA = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const SPENDER = "0x3333333333333333333333333333333333333333";
const OWNER = "0x4444444444444444444444444444444444444444";
const PERMIT2_RESULT = canonicalPermit2Address(BASE);
if (PERMIT2_RESULT === undefined) throw new Error("Base Permit2 address is missing");
const PERMIT2 = PERMIT2_RESULT;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;

const NO_CODE: EvmCodeReader = { getCode: async () => "0x" };
const HAS_CODE: EvmCodeReader = { getCode: async () => "0x6080604052" };

const ERC20 = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function increaseAllowance(address spender, uint256 addedValue) returns (bool)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);

function call(data: string, to = TOKEN, valueWei = "0") {
  return { to, data, valueWei, chainId: BASE };
}

// ── Accepts ──────────────────────────────────────────────────────────

describe("EVM decode goldens - the closed v1 set", () => {
  it("a plain native transfer to an account with NO code", async () => {
    const result = await decodeEvmTransaction(call("0x", EOA, "1000000000000000000"), NO_CODE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      standard: "native",
      role: "native_transfer",
      functionName: "nativeTransfer",
      contract: null,
      unlimitedApproval: false,
    });
    expect(result.value.criticalArgs.valueWei).toBe("1000000000000000000");
  });

  it("ERC-20 transfer binds the recipient and the RAW amount", async () => {
    const data = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [EOA, 1000000n] });
    const result = await decodeEvmTransaction(call(data), NO_CODE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.functionName).toBe("transfer");
    expect(result.value.criticalArgs.amountRaw).toBe("1000000");
    expect(result.value.criticalArgs.recipient.toLowerCase()).toBe(EOA);
  });

  it("ERC-20 approve of max uint256 sets the unlimited-approval warning", async () => {
    const data = encodeFunctionData({
      abi: ERC20, functionName: "approve", args: [SPENDER, MAX_UINT256],
    });
    const result = await decodeEvmTransaction(call(data), NO_CODE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.role).toBe("approve");
    expect(result.value.unlimitedApproval).toBe(true);
    expect(result.value.warnings.join(" ")).toContain("UNLIMITED APPROVAL");
  });

  it("an ordinary ERC-20 approve is NOT flagged unlimited, but IS flagged unverified", async () => {
    const data = encodeFunctionData({ abi: ERC20, functionName: "approve", args: [SPENDER, 1n] });
    const result = await decodeEvmTransaction(call(data), NO_CODE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unlimitedApproval).toBe(false);
    // Not unlimited, so no unlimited warning - but the token identity is still
    // unproven, so the unverified warning is the only one present.
    expect(result.value.warnings).toEqual([
      expect.stringContaining("TOKEN IDENTITY UNVERIFIED"),
    ]);
    expect(result.value.criticalArgs.tokenIdentityVerified).toBe("false");
  });

  it("ERC-20 transferFrom binds the EMBEDDED `from`", async () => {
    const data = encodeFunctionData({
      abi: ERC20, functionName: "transferFrom", args: [OWNER, EOA, 5n],
    });
    const result = await decodeEvmTransaction(call(data), NO_CODE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The embedded `from` is whose tokens move. It is displayed, not dropped.
    expect(result.value.criticalArgs.from.toLowerCase()).toBe(OWNER);
  });

  it("increaseAllowance says it ADDS rather than replaces", async () => {
    const data = encodeFunctionData({
      abi: ERC20, functionName: "increaseAllowance", args: [SPENDER, 10n],
    });
    const result = await decodeEvmTransaction(call(data), NO_CODE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.criticalArgs.addedAmountRaw).toBe("10");
    expect(result.value.warnings.join(" ")).toContain("ADDS to the existing allowance");
  });

  it("EIP-2612 permit binds owner, spender and the deadline", async () => {
    const data = encodeFunctionData({
      abi: ERC20,
      functionName: "permit",
      args: [OWNER, SPENDER, 7n, 1900000000n, 27, `0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`],
    });
    const result = await decodeEvmTransaction(call(data), NO_CODE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.criticalArgs.owner.toLowerCase()).toBe(OWNER);
    expect(result.value.criticalArgs.spender.toLowerCase()).toBe(SPENDER);
    expect(result.value.criticalArgs.deadlineUnixSeconds).toBe("1900000000");
  });

  it("Permit2 approve at the CANONICAL address decodes and warns", async () => {
    const data = encodeFunctionData({
      abi: PERMIT2_ABI, functionName: "approve", args: [TOKEN, SPENDER, MAX_UINT160, 1900000000],
    });
    const result = await decodeEvmTransaction(call(data, PERMIT2), NO_CODE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.standard).toBe("permit2");
    // Permit2's own unlimited sentinel is uint160 max, NOT uint256 max.
    expect(result.value.unlimitedApproval).toBe(true);
    expect(result.value.warnings.join(" ")).toContain("shared approval contract");
  });

  it("Permit2 permit binds the embedded owner, spender, token and both deadlines", async () => {
    const data = encodeFunctionData({
      abi: PERMIT2_ABI,
      functionName: "permit",
      args: [
        OWNER,
        {
          details: { token: TOKEN, amount: 500n, expiration: 1900000000, nonce: 0 },
          spender: SPENDER,
          sigDeadline: 1900000123n,
        },
        "0x00",
      ],
    });
    const result = await decodeEvmTransaction(call(data, PERMIT2), NO_CODE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.criticalArgs.owner.toLowerCase()).toBe(OWNER);
    expect(result.value.criticalArgs.amountRaw).toBe("500");
    expect(result.value.criticalArgs.expirationUnixSeconds).toBe("1900000000");
    expect(result.value.criticalArgs.sigDeadlineUnixSeconds).toBe("1900000123");
    expect(result.value.unlimitedApproval).toBe(false);
  });
});

// ── THE REFUSAL SET ──────────────────────────────────────────────────

describe("EVM decode goldens - the REFUSAL set", () => {
  it("an unknown selector refuses, and names routers explicitly", async () => {
    // A real router selector shape: four bytes we do not know, followed by
    // well-formed-looking words.
    const result = await decodeEvmTransaction(call(`0xdeadbeef${"00".repeat(32)}`), NO_CODE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("unsupported_call");
    expect(result.refusal.message).toContain("0xdeadbeef");
    expect(result.refusal.message).toContain("Router and aggregator calldata");
    expect(result.refusal.message).toContain("nothing was signed");
  });

  it("a MALFORMED argument layout under a known selector refuses", async () => {
    const good = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [EOA, 1n] });
    // Same selector, arguments truncated: viem cannot decode it, and neither
    // may we describe it.
    const result = await decodeEvmTransaction(call(good.slice(0, 30)), NO_CODE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("unsupported_call");
  });

  it("Permit2 calldata at a NON-CANONICAL address refuses by that name", async () => {
    const data = encodeFunctionData({
      abi: PERMIT2_ABI, functionName: "approve", args: [TOKEN, SPENDER, 1n, 0],
    });
    const impostor = "0x9999999999999999999999999999999999999999";
    const result = await decodeEvmTransaction(call(data, impostor), NO_CODE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("non_canonical_permit2");
    // The refusal must name BOTH the address it got and the one it expected,
    // or the caller cannot tell a typo from an attack.
    expect(result.refusal.message.toLowerCase()).toContain(impostor.slice(2, 10));
    expect(result.refusal.message.toLowerCase()).toContain(PERMIT2.slice(2, 10));
  });

  it("Permit2 calldata on a chain with NO canonical deployment refuses", async () => {
    const data = encodeFunctionData({
      abi: PERMIT2_ABI, functionName: "approve", args: [TOKEN, SPENDER, 1n, 0],
    });
    const result = await decodeEvmTransaction(
      { to: PERMIT2, data, valueWei: "0", chainId: 4663 },
      NO_CODE,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("non_canonical_permit2");
    expect(result.refusal.message).toContain("no canonical Permit2 address recorded");
  });

  it("`data = 0x` sent to an address WITH code refuses as a fallback invocation", async () => {
    const result = await decodeEvmTransaction(call("0x", TOKEN, "1"), HAS_CODE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("code_at_native_transfer_target");
    expect(result.refusal.message).toContain("receive or fallback");
  });

  it("`data = 0x` with a ZERO value refuses as an effect-free transaction", async () => {
    const result = await decodeEvmTransaction(call("0x", EOA, "0"), NO_CODE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("unsupported_call");
  });

  it("native value alongside a non-payable contract call refuses", async () => {
    const data = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [EOA, 1n] });
    const result = await decodeEvmTransaction(call(data, TOKEN, "5"), NO_CODE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("unsupported_call");
    expect(result.refusal.message).toContain("non-payable");
  });

  it("calldata shorter than a selector refuses", async () => {
    const result = await decodeEvmTransaction(call("0xab"), NO_CODE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("unsupported_call");
  });

  it("NO refusal message leaks the raw calldata blob", async () => {
    const blob = `0xdeadbeef${"ab".repeat(200)}`;
    const result = await decodeEvmTransaction(call(blob), NO_CODE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Rule 90: no raw hex blobs in errors. The SELECTOR is named because it is
    // the actionable fact; the payload is not.
    expect(result.refusal.message).not.toContain("ab".repeat(20));
  });
});

// ── V6: ERC-20 TARGET IDENTITY IS UNVERIFIED ─────────────────────────
//
// `decodeAgainstErc20` matches the ERC-20 layout on the calldata ALONE, with no
// chain read that could prove the target is a token. So an EOA target, a
// selector-impersonating contract, and a genuine token all decode to the SAME
// unverified result. The decoder does not pretend otherwise: it labels every
// one unverified rather than presenting any of them as a confirmed token
// transfer. Verifying identity would need an `eth_call decimals()` probe, a new
// chain seam the confirm re-decode's chain adapter would also have to carry;
// honest labeling needs neither and stays a pure function of the bytes.

const FEE_BOUNDS: WalletTransactionFeeBounds = {
  mode: "eip1559",
  gasLimit: "21000",
  maxFeePerGasWei: "1000000000",
  maxPriorityFeePerGasWei: "1000000000",
  maxTotalFeeWei: "21000000000000",
};

/** A contract whose bytecode happens to expose a `transfer(address,uint256)` selector but is not a token. */
const SELECTOR_COLLISION_CONTRACT = "0x5555555555555555555555555555555555555555";

function digestOf(decoded: DecodedEvmCall, to: string, dataHex: string): string {
  const input: ProposalDigestInput = {
    intentId: "wtx-v6-fixed",
    family: "eip155",
    walletAddress: "0x6666666666666666666666666666666666666666",
    chainAlias: "base",
    chainId: BASE,
    payload: { to: to.toLowerCase(), data: dataHex.toLowerCase(), valueWei: "0" },
    decoded,
    feeBounds: FEE_BOUNDS,
    recentBlockhash: null,
    lastValidBlockHeight: null,
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  return computeProposalDigest(input).digest;
}

describe("EVM decode - V6: ERC-20 target identity is UNVERIFIED", () => {
  const transferData = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [EOA, 1000000n] });

  it("transfer-shaped calldata to a CODELESS EOA is labeled unverified, not a confirmed transfer", async () => {
    // The target is an ordinary account with no code. Nothing here can execute
    // `transfer` on it, and the code reader confirms the codelessness is
    // irrelevant to the label: the decoder never presents it as a real token.
    const result = await decodeEvmTransaction(call(transferData, EOA), NO_CODE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.criticalArgs.tokenIdentityVerified).toBe("false");
    expect(result.value.warnings.join(" ")).toContain("TOKEN IDENTITY UNVERIFIED");

    const preview = buildTransactionPreview(result.value, FEE_BOUNDS, "base", "0");
    expect(preview.label).toContain("UNVERIFIED TOKEN");
    // The raw decoded args and the target are still shown in the bound panel.
    expect(preview.criticalArgs.recipient.toLowerCase()).toBe(EOA);
    expect(preview.criticalArgs.amountRaw).toBe("1000000");
    expect(preview.criticalArgs.tokenIdentityVerified).toBe("false");
  });

  it("transfer-shaped calldata to a SELECTOR-COLLISION contract is labeled unverified", async () => {
    // Has code, but the code is not a token: its `transfer` selector is a
    // collision. The decoder cannot tell it from a token without a probe, so it
    // refuses to assert token semantics.
    const result = await decodeEvmTransaction(call(transferData, SELECTOR_COLLISION_CONTRACT), HAS_CODE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.criticalArgs.tokenIdentityVerified).toBe("false");
    expect(result.value.warnings.join(" ")).toContain("TOKEN IDENTITY UNVERIFIED");
    const preview = buildTransactionPreview(result.value, FEE_BOUNDS, "base", "0");
    expect(preview.label).toContain("UNVERIFIED TOKEN");
  });

  it("a genuine ERC-20 token is ALSO labeled unverified - honesty over an unprovable claim", async () => {
    const result = await decodeEvmTransaction(call(transferData, TOKEN), HAS_CODE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Without a chain probe the decoder has no basis to distinguish this real
    // token from the two cases above, so it does not claim to.
    expect(result.value.criticalArgs.tokenIdentityVerified).toBe("false");
    expect(buildTransactionPreview(result.value, FEE_BOUNDS, "base", "0").label).toContain("UNVERIFIED TOKEN");
  });

  it("the unverified label is DETERMINISTIC across a prepare and a confirm re-decode", async () => {
    // The confirm path decodes the SAME payload again and recomputes the digest
    // over the fresh decode (revalidateDecodedEffects). If the label were not a
    // pure function of the calldata, the digests would diverge and confirm would
    // refuse a valid intent. Two independent decodes of the same bytes must be
    // byte-identical.
    const prepared = await decodeEvmTransaction(call(transferData, TOKEN), HAS_CODE);
    const reDecoded = await decodeEvmTransaction(call(transferData, TOKEN), HAS_CODE);
    expect(prepared.ok && reDecoded.ok).toBe(true);
    if (!prepared.ok || !reDecoded.ok) return;
    expect(reDecoded.value).toEqual(prepared.value);
    expect(digestOf(reDecoded.value, TOKEN, transferData)).toBe(
      digestOf(prepared.value, TOKEN, transferData),
    );
  });

  it("the unverified fact is BOUND in the digest - stripping it changes the digest", async () => {
    const result = await decodeEvmTransaction(call(transferData, TOKEN), HAS_CODE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const honest = digestOf(result.value, TOKEN, transferData);
    // A tampered decode that dropped the unverified marker and warning would be
    // a different proposal, so it must not share the digest the user approved.
    const stripped: DecodedEvmCall = {
      ...result.value,
      criticalArgs: { token: result.value.criticalArgs.token, recipient: EOA, amountRaw: "1000000" },
      warnings: [],
    };
    expect(digestOf(stripped, TOKEN, transferData)).not.toBe(honest);
  });
});
