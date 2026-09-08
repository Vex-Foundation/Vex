/**
 * VERBATIM JSON-RPC error bodies, copied byte for byte out of the live probes
 * archived under `agents-colab/agents_dm/rpc-endpoints-2026-09-05/`.
 *
 * WHY VERBATIM MATTERS HERE. `classifyRpcFailure` reads provider prose - "Archive
 * requests require a personal token", "ranges over 10000 blocks are not
 * supported on free plan", "limit exceeded" - because the numeric codes do not
 * distinguish these cases (three different refusals all arrive as -32602). A
 * fixture paraphrased from a provider's documentation would prove the classifier
 * matches the paraphrase, which is exactly the guess rule 10 forbids. Each
 * constant below names the endpoint, the method and the date it was captured.
 *
 * These are RESPONSE BODIES. The tests wrap them the way viem does before they
 * reach the classifier, so the assertions run against the shape production sees.
 */

export interface CapturedRpcError {
  /** Host that produced it. Host only - these are logs, not urls to call. */
  readonly host: string;
  readonly method: string;
  readonly capturedOn: string;
  readonly body: { readonly code: number; readonly message: string };
}

/** -32602 with archive prose. PublicNode's provider-wide gate. */
export const PUBLICNODE_ARCHIVE_RECEIPT: CapturedRpcError = {
  host: "optimism-rpc.publicnode.com",
  method: "eth_getTransactionReceipt",
  capturedOn: "2026-09-05",
  body: {
    code: -32602,
    message: "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode",
  },
};

/** The same gate on a different chain and a different method. */
export const PUBLICNODE_ARCHIVE_LOGS: CapturedRpcError = {
  host: "base-rpc.publicnode.com",
  method: "eth_getLogs",
  capturedOn: "2026-09-05",
  body: {
    code: -32602,
    message: "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode",
  },
};

/** -32600 with a block-range cap AND a suggested range. */
export const BLASTAPI_RANGE_CAP: CapturedRpcError = {
  host: "base-mainnet.public.blastapi.io",
  method: "eth_getLogs",
  capturedOn: "2026-09-05",
  body: {
    code: -32600,
    message:
      "You can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x308e0cd, 0x308e0d6]",
  },
};

/** -32020: a RESULT-SIZE cap, not a block-range cap. Same remedy: narrow the window. */
export const BASE_ORG_RESPONSE_TOO_LARGE: CapturedRpcError = {
  host: "developer-access-mainnet.base.org",
  method: "eth_getLogs",
  capturedOn: "2026-09-05",
  body: { code: -32020, message: "backend response too large" },
};

/** -32602 with a RESULT count cap and a suggested range. */
export const PUBLICNODE_MAX_RESULTS: CapturedRpcError = {
  host: "bsc-rpc.publicnode.com",
  method: "eth_getLogs",
  capturedOn: "2026-09-05",
  body: { code: -32602, message: "query exceeds max results 20000, retry with the range 120125206-120125806" },
};

/** Monad's own wording for the same class. */
export const MONADINFRA_RANGE_CAP: CapturedRpcError = {
  host: "rpc-mainnet.monadinfra.com",
  method: "eth_getLogs",
  capturedOn: "2026-09-05",
  body: { code: -32602, message: "block range too large" },
};

/** A THIRD wording and a private error code, from a second Monad endpoint. */
export const MONAD_RPC3_RANGE_CAP: CapturedRpcError = {
  host: "rpc3.monad.xyz",
  method: "eth_getLogs",
  capturedOn: "2026-09-05",
  body: { code: -32062, message: "Block range is too large" },
};

/** Tenderly states its cap and the range that would work. */
export const TENDERLY_RANGE_CAP: CapturedRpcError = {
  host: "base.gateway.tenderly.co",
  method: "eth_getLogs",
  capturedOn: "2026-09-05",
  body: {
    code: -32602,
    message:
      "invalid params: Block range too large for public access: maximum 1000 blocks. Try with this block range [0x308be15, 0x308c1fd], or use an access key for larger ranges.",
  },
};

/** drpc's free-plan range gate. A different provider, the same class. */
export const DRPC_FREE_PLAN_RANGE: CapturedRpcError = {
  host: "polygon.drpc.org",
  method: "eth_getLogs",
  capturedOn: "2026-09-05",
  body: { code: 35, message: "ranges over 10000 blocks are not supported on free plan" },
};

/** -32005 used as a flat method refusal, not as a per-second limit. */
export const BNBCHAIN_LIMIT_EXCEEDED: CapturedRpcError = {
  host: "bsc-dataseed1.bnbchain.org",
  method: "eth_getLogs",
  capturedOn: "2026-09-05",
  body: { code: -32005, message: "limit exceeded" },
};

/** -32005 as a real rate limit. */
export const HYPERLIQUID_RATE_LIMITED: CapturedRpcError = {
  host: "rpc.hyperliquid.xyz/evm",
  method: "eth_getLogs",
  capturedOn: "2026-09-05",
  body: { code: -32005, message: "rate limited" },
};

/**
 * The drpc free-plan COMPUTE budget. Named apart from a rate limit because it
 * is spent by work rather than by request count and does not recover by
 * waiting: this is the body that made `base.drpc.org` - the default for five
 * separate venue tables - unusable for every Base `eth_call`.
 */
export const DRPC_COMPUTE_BUDGET: CapturedRpcError = {
  host: "base.drpc.org",
  method: "eth_call",
  capturedOn: "2026-09-05",
  body: { code: 30, message: "Request timeout on the free plan, please upgrade to paid plan" },
};

/** A gateway that stopped serving a method entirely. */
export const ONERPC_DISCONTINUED: CapturedRpcError = {
  host: "1rpc.io/base",
  method: "eth_feeHistory",
  capturedOn: "2026-09-05",
  body: { code: -32601, message: "This endpoint has been discontinued. Please visit https://gateway.lavanet.xyz" },
};

/** A method moved behind a paid plan. */
export const ONERPC_PAID_ONLY: CapturedRpcError = {
  host: "1rpc.io/arb",
  method: "eth_call",
  capturedOn: "2026-09-05",
  body: { code: -16401, message: "Method 'eth_call' is available for paid plans only, see co.tatum.io/upgrade" },
};

/** drpc could not route a wide log query to any backend. */
export const DRPC_NO_ROUTE: CapturedRpcError = {
  host: "eth.drpc.org",
  method: "eth_getLogs",
  capturedOn: "2026-09-05",
  body: {
    code: 12,
    message: "Can't route your request to suitable provider, if you specified certain providers revise the list",
  },
};

/**
 * A node that answered `eth_getBlockByNumber` and then denied knowing the block
 * a transaction from that same block was in.
 */
export const DRPC_UNKNOWN_BLOCK: CapturedRpcError = {
  host: "arbitrum.drpc.org",
  method: "eth_getTransactionReceipt",
  capturedOn: "2026-09-05",
  body: { code: 26, message: "Unknown block" },
};

/** A revert. The chain's ANSWER, and the one class that must never fail over. */
export const EXECUTION_REVERTED: CapturedRpcError = {
  host: "any",
  method: "eth_call",
  capturedOn: "2026-09-05",
  body: { code: 3, message: "execution reverted: ERC20: transfer amount exceeds balance" },
};
