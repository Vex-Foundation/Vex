/** Safe transport facts captured before web3.js wraps away status and causes. */
export type SolanaRpcFailureReason =
  | "rate_limited" | "dns" | "tls" | "timeout" | "connection_failed"
  | "invalid_response" | "rpc_failed" | `http_${number}` | `rpc_${number}`;

export interface SolanaRpcFailure {
  readonly reason: SolanaRpcFailureReason;
  readonly endpointHost: string | null;
}

export class SolanaRpcTransportError extends Error {
  override readonly name = "SolanaRpcTransportError";
  constructor(readonly failure: SolanaRpcFailure, cause: unknown) {
    super(`Solana RPC ${failure.reason}${failure.endpointHost === null ? "" : ` at ${failure.endpointHost}`}`, { cause });
  }
}

/** Classify only known runtime codes, never copy provider messages into logs. */
export function classifySolanaRpcFailure(error: unknown): SolanaRpcFailure {
  if (error instanceof SolanaRpcTransportError) return error.failure;
  const fallback = { endpointHost: error instanceof Error && "endpointHost" in error && typeof error.endpointHost === "string" ? error.endpointHost : null };
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current.name === "SolanaRpcRateLimited") return { ...fallback, reason: "rate_limited" };
    if (current.name === "SolanaRpcDeadlineExceeded" || current.name === "TimeoutError") return { ...fallback, reason: "timeout" };
    if (current.name === "SolanaRpcResponseInvalidError" || current.name === "SyntaxError" || current.name === "StructError") return { ...fallback, reason: "invalid_response" };
    const code = "code" in current ? current.code : undefined;
    if (typeof code === "number" && Number.isSafeInteger(code)) return { ...fallback, reason: `rpc_${code}` };
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { ...fallback, reason: "dns" };
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return { ...fallback, reason: "timeout" };
    if (typeof code === "string" && (/^(?:ERR_TLS_|ERR_SSL_|CERT_)/.test(code) || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" || code === "EPROTO" || code === "SELF_SIGNED_CERT_IN_CHAIN")) return { ...fallback, reason: "tls" };
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "UND_ERR_SOCKET") return { ...fallback, reason: "connection_failed" };
    current = current.cause;
  }
  return { ...fallback, reason: "rpc_failed" };
}
