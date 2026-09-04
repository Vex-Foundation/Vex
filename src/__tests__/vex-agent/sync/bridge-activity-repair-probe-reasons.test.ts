/**
 * The bridge verifier's UNVERIFIED reasons — F4 and F7.
 *
 * Two defects, one function:
 *
 *   F4. Every abandoned endpoint collapsed into a single `receipt_unavailable`.
 *       That string is rendered verbatim to the user (`AgentScanRow.tsx`) and to
 *       the agent (`inspect-views/transactions.ts`), where "the fill is mined in
 *       a minute, just not yet" and "we cannot see this chain at all" are
 *       different instructions — and were the same word.
 *   F7. Anything that was not the literal `"success"` was reported as
 *       `fill_reverted`, INCLUDING the nullish value viem's formatter emits for
 *       a receipt status it cannot read (it maps `0x1`/`0x0` and nothing else).
 *       Telling a user their bridge fill REVERTED when we merely could not read
 *       the status is a claim beyond the evidence — exactly what the EVM sweep
 *       already refuses to do.
 *
 * Precedence is asserted directly because with several RPCs the loop collects
 * several outcomes, and without a FIXED order the reported reason would depend
 * on which URL happened to be tried first.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const clientScript: Array<{ chainId?: number; receiptStatus?: unknown; throws?: Error }> = [];
let rpcUrls: string[] = [];

vi.mock("viem", () => ({
  http: (url: string) => url,
  createPublicClient: () => {
    const step = clientScript.shift() ?? {};
    return {
      getChainId: async () => {
        if (step.throws && step.chainId === undefined) throw step.throws;
        return step.chainId ?? 42161;
      },
      getTransactionReceipt: async () => {
        if (step.throws) throw step.throws;
        return { status: step.receiptStatus };
      },
    };
  },
}));

vi.mock("@vex-agent/sync/solana-rpc-safety.js", () => ({
  SOLANA_MAINNET_GENESIS: "genesis",
  selectVerificationRpcUrls: () => rpcUrls,
  solanaRpcCall: vi.fn(),
}));

vi.mock("@tools/evm-chains/registry.js", () => ({
  getLocalChain: () => null,
  getLocalChainRpcUrl: () => "",
}));
vi.mock("@tools/khalani/chains.js", () => ({ getCachedKhalaniChains: async () => [] }));
vi.mock("@tools/relay/client.js", () => ({ getCachedRelayChains: async () => [] }));

const { verifyBridgeLegOnChain, resolveEvmProbeReason, resolveSolanaProbeReason } = await import(
  "@vex-agent/sync/bridge-activity-repair-verification.js"
);

const HASH = `0x${"a".repeat(64)}`;

function input() {
  return {
    txHash: HASH,
    expectedChainId: 42161,
    chainFamily: "eip155" as const,
    protocol: "khalani",
    tokenOutAddress: null,
    recipient: null,
  };
}

/**
 * The error viem 2.54.3 actually raises when an endpoint ANSWERS with a
 * JSON-RPC `error` object, reproduced from a live probe of
 * `https://arbitrum-one.publicnode.com` on 2026-09-04 (eth_chainId 42161, then
 * `-32602` for a month-old receipt: "Archive requests require a personal
 * token"). Shape, not text: `InvalidParamsRpcError` (numeric `code`) whose
 * `cause` is `RpcRequestError` with the same numeric code.
 */
function refusedRequest(): Error {
  const cause = new Error("Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode");
  cause.name = "RpcRequestError";
  Object.assign(cause, { code: -32602 });
  const err = new Error("Invalid parameters were provided to the RPC method.", { cause });
  err.name = "InvalidParamsRpcError";
  Object.assign(err, { code: -32602 });
  return err;
}

/** A transport failure as viem raises it: NO numeric code anywhere in the chain. */
function transportFailure(): Error {
  const socket = new Error("getaddrinfo ENOTFOUND rpc.example");
  Object.assign(socket, { code: "ENOTFOUND" }); // a STRING code - not an answer.
  const err = new Error("HTTP request failed.", { cause: socket });
  err.name = "HttpRequestError";
  return err;
}

function notFound(): Error {
  // viem carries the RPC URL in this message, which is why the code matches on
  // `name` and never on the text.
  const err = new Error("Transaction receipt could not be found. URL: https://rpc.example/KEY");
  err.name = "TransactionReceiptNotFoundError";
  return err;
}

beforeEach(() => {
  clientScript.length = 0;
  rpcUrls = ["https://rpc.example/one"];
});

describe("verifyBridgeLegOnChain — one reason per real observation", () => {
  it("no URL survived SSRF selection → no_safe_rpc", async () => {
    rpcUrls = [];
    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: false, reason: "no_safe_rpc" });
  });

  it("a malformed hash never reaches an RPC", async () => {
    expect(await verifyBridgeLegOnChain({ ...input(), txHash: "0xnope" })).toEqual({
      verified: false,
      reason: "malformed_fill_hash",
    });
  });

  it("every endpoint echoed the WRONG chain → chain_echo_mismatch", async () => {
    rpcUrls = ["https://a", "https://b"];
    clientScript.push({ chainId: 1 }, { chainId: 8453 });
    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: false, reason: "chain_echo_mismatch" });
  });

  it("the right chain answered 'no receipt yet' → fill_not_mined (wait), not receipt_unavailable", async () => {
    clientScript.push({ chainId: 42161, throws: notFound() });
    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: false, reason: "fill_not_mined" });
  });

  it("every endpoint threw a TRANSPORT error → rpc_unreachable (we could not look)", async () => {
    rpcUrls = ["https://a", "https://b"];
    clientScript.push({ chainId: 42161, throws: new Error("connect ECONNREFUSED") },
      { chainId: 42161, throws: new Error("socket hang up") });
    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: false, reason: "rpc_unreachable" });
  });

  it("an endpoint that ANSWERED and refused is not 'unreachable' - the loop moves on and a later URL verifies", async () => {
    // The owner's row 132, replayed at the loop level: the first endpoint echoes
    // 42161 and refuses the archive read, the second serves the receipt.
    rpcUrls = ["https://refuses.example", "https://serves.example"];
    clientScript.push({ chainId: 42161, throws: refusedRequest() }, { chainId: 42161, receiptStatus: "success" });
    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: true });
  });

  it("EVERY endpoint refused → rpc_refused_request, never rpc_unreachable", async () => {
    rpcUrls = ["https://a", "https://b"];
    clientScript.push({ chainId: 42161, throws: refusedRequest() }, { chainId: 42161, throws: refusedRequest() });
    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: false, reason: "rpc_refused_request" });
  });

  it("transport failure, then a refusal, then 'no receipt yet' → fill_not_mined wins by precedence", async () => {
    rpcUrls = ["https://a", "https://b", "https://c"];
    clientScript.push(
      { chainId: 42161, throws: transportFailure() },
      { chainId: 42161, throws: refusedRequest() },
      { chainId: 42161, throws: notFound() },
    );
    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: false, reason: "fill_not_mined" });
  });

  it("a refusal on the CHAIN-ID call also counts as an answer, not silence", async () => {
    rpcUrls = ["https://a"];
    clientScript.push({ chainId: undefined, throws: refusedRequest() });
    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: false, reason: "rpc_refused_request" });
  });

  it("a receipt with status success verifies", async () => {
    clientScript.push({ chainId: 42161, receiptStatus: "success" });
    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: true });
  });

  it("only the LITERAL 'reverted' is a revert", async () => {
    clientScript.push({ chainId: 42161, receiptStatus: "reverted" });
    expect(await verifyBridgeLegOnChain(input())).toEqual({ verified: false, reason: "fill_reverted" });
  });

  it("F7: an UNREADABLE status is never reported as a revert", async () => {
    // viem's formatter maps `0x1`/`0x0` only; anything else arrives nullish. A
    // revert we cannot prove must not be claimed.
    clientScript.push({ chainId: 42161, receiptStatus: undefined });
    expect(await verifyBridgeLegOnChain(input())).toEqual({
      verified: false,
      reason: "unreadable_receipt_status",
    });
  });

  it("no longer produces receipt_unavailable for ANY of those paths", async () => {
    rpcUrls = ["https://a"];
    clientScript.push({ chainId: 42161, throws: notFound() });
    const result = await verifyBridgeLegOnChain(input());
    expect(result.reason).not.toBe("receipt_unavailable");
  });
});

describe("multi-endpoint precedence is fixed, not URL-order dependent", () => {
  it.each([
    [["rpc_unreachable", "fill_not_mined"], "fill_not_mined"],
    [["fill_not_mined", "rpc_unreachable"], "fill_not_mined"],
    [["chain_echo_mismatch", "rpc_unreachable"], "chain_echo_mismatch"],
    [["fill_not_mined", "unreadable_receipt_status"], "unreadable_receipt_status"],
    [["rpc_unreachable", "rpc_refused_request"], "rpc_refused_request"],
    [["rpc_refused_request", "rpc_unreachable"], "rpc_refused_request"],
    [["rpc_refused_request", "chain_echo_mismatch"], "chain_echo_mismatch"],
    [["rpc_refused_request"], "rpc_refused_request"],
    [["rpc_unreachable"], "rpc_unreachable"],
    [[], "no_safe_rpc"],
  ] as const)("%j → %s", (observations, expected) => {
    expect(resolveEvmProbeReason([...observations])).toBe(expected);
  });
});

describe("the Solana leg makes the same distinction", () => {
  it.each([
    [["rpc_unreachable", "signature_status_unavailable"], "signature_status_unavailable"],
    [["chain_echo_mismatch", "rpc_unreachable"], "chain_echo_mismatch"],
    [["rpc_unreachable"], "rpc_unreachable"],
  ] as const)("%j → %s", (observations, expected) => {
    // "a node answered and did not know this signature" is a different fact from
    // "no node answered": one means wait, the other means we never looked.
    expect(resolveSolanaProbeReason([...observations])).toBe(expected);
  });
});
