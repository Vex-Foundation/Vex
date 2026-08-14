/**
 * Structured error class for Vex runtime and automation.
 */
export class VexError extends Error {
  retryable?: boolean;
  externalName?: string;
  /**
   * HTTP status of the response that produced this error, when it came from a
   * provider that ANSWERED (set by `utils/http.ts` on a non-ok response).
   * Absent for network/timeout/parse failures, where no status exists.
   *
   * Callers use it to tell a definitive provider refusal (4xx — the request
   * was understood and rejected, nothing was acted on) from an ambiguous
   * transport failure. Never assume its absence means success.
   */
  httpStatus?: number;
  /**
   * How long the provider said to wait before retrying, in WHOLE SECONDS, when
   * a rate-limited response advertised it (`Retry-After`, or the
   * `x-ratelimit-*` family on a 429). Set by `utils/http.ts`; always a
   * validated integer within `utils/http/retry-after.ts`'s bounds — never raw
   * header text, and absent whenever the provider named no interval.
   *
   * Flat and optional like `httpStatus` above, for the same reason: it is one
   * bounded number recovered from one response, and the agent-facing remedy
   * ("wait ~12s before retrying") reads it exactly once.
   */
  retryAfterSeconds?: number;

  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string
  ) {
    super(message);
    this.name = "VexError";
  }
}

/**
 * Standard error codes for automation consumers.
 */
export const ErrorCodes = {
  // Wallet & Config
  KEYSTORE_PASSWORD_NOT_SET: "KEYSTORE_PASSWORD_NOT_SET",
  WALLET_NOT_CONFIGURED: "WALLET_NOT_CONFIGURED",
  KEYSTORE_NOT_FOUND: "KEYSTORE_NOT_FOUND",
  KEYSTORE_ALREADY_EXISTS: "KEYSTORE_ALREADY_EXISTS",
  KEYSTORE_DECRYPT_FAILED: "KEYSTORE_DECRYPT_FAILED",
  // Multi-wallet inventory (puzzle 5 stage 1)
  WALLET_INVENTORY_FULL: "WALLET_INVENTORY_FULL",
  WALLET_DUPLICATE_ADDRESS: "WALLET_DUPLICATE_ADDRESS",
  WALLET_ID_INVALID: "WALLET_ID_INVALID",
  WALLET_NOT_SELECTED: "WALLET_NOT_SELECTED",
  WALLET_SCOPE_MISMATCH: "WALLET_SCOPE_MISMATCH",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  INTENT_NOT_FOUND: "INTENT_NOT_FOUND",
  INTENT_EXPIRED: "INTENT_EXPIRED",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  // Broadcast completed but receipt confirmation failed or timed out. The
  // transaction may still settle, so callers must not blindly retry it.
  CONFIRMATION_UNKNOWN: "CONFIRMATION_UNKNOWN",
  INVALID_ADDRESS: "INVALID_ADDRESS",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  CHAIN_MISMATCH: "CHAIN_MISMATCH",
  RPC_ERROR: "RPC_ERROR",
  SIGNER_MISMATCH: "SIGNER_MISMATCH",
  INTERACTIVE_COMMAND_NOT_SUPPORTED: "INTERACTIVE_COMMAND_NOT_SUPPORTED",
  PASSWORD_MISMATCH: "PASSWORD_MISMATCH",
  PASSWORD_TOO_SHORT: "PASSWORD_TOO_SHORT",
  APPROVAL_FAILED: "APPROVAL_FAILED",
  SWAP_FAILED: "SWAP_FAILED",
  INVALID_SPENDER: "INVALID_SPENDER",

  // Vex Agent daemon
  AGENT_START_FAILED: "AGENT_START_FAILED",
  AGENT_NOT_RUNNING: "AGENT_NOT_RUNNING",

  // Vex Agent runtime
  AGENT_VALIDATION_ERROR: "AGENT_VALIDATION_ERROR",
  AGENT_INFERENCE_FAILED: "AGENT_INFERENCE_FAILED",
  AGENT_TOOL_EXECUTION_FAILED: "AGENT_TOOL_EXECUTION_FAILED",
  AGENT_COMPACTION_FAILED: "AGENT_COMPACTION_FAILED",
  AGENT_APPROVAL_NOT_FOUND: "AGENT_APPROVAL_NOT_FOUND",
  AGENT_SCHEDULER_FAILED: "AGENT_SCHEDULER_FAILED",
  AGENT_BACKUP_FAILED: "AGENT_BACKUP_FAILED",
  AGENT_RESTORE_FAILED: "AGENT_RESTORE_FAILED",
  AGENT_EXTERNAL_SERVICE_FAILED: "AGENT_EXTERNAL_SERVICE_FAILED",

  // HTTP
  HTTP_REQUEST_FAILED: "HTTP_REQUEST_FAILED",
  HTTP_TIMEOUT: "HTTP_TIMEOUT",
  // Response body failed schema validation (codex-002). Distinct from
  // HTTP_REQUEST_FAILED so callers can treat a malformed/hostile payload as
  // non-retryable while still retrying genuine network failures.
  HTTP_RESPONSE_INVALID: "HTTP_RESPONSE_INVALID",

  // Khalani / HyperStream
  KHALANI_API_ERROR: "KHALANI_API_ERROR",
  KHALANI_TIMEOUT: "KHALANI_TIMEOUT",
  KHALANI_RATE_LIMITED: "KHALANI_RATE_LIMITED",
  KHALANI_QUOTE_NOT_FOUND: "KHALANI_QUOTE_NOT_FOUND",
  KHALANI_QUOTE_EXPIRED: "KHALANI_QUOTE_EXPIRED",
  KHALANI_VALIDATION_ERROR: "KHALANI_VALIDATION_ERROR",
  KHALANI_CANNOT_FILL: "KHALANI_CANNOT_FILL",
  KHALANI_UNSUPPORTED_TOKEN: "KHALANI_UNSUPPORTED_TOKEN",
  KHALANI_UNSUPPORTED_CHAIN: "KHALANI_UNSUPPORTED_CHAIN",
  KHALANI_DEPOSIT_FAILED: "KHALANI_DEPOSIT_FAILED",
  KHALANI_BROADCAST_FAILED: "KHALANI_BROADCAST_FAILED",
  KHALANI_PERMIT2_BLOCKED: "KHALANI_PERMIT2_BLOCKED",
  KHALANI_ORDER_NOT_FOUND: "KHALANI_ORDER_NOT_FOUND",
  KHALANI_SOLANA_SIGN_FAILED: "KHALANI_SOLANA_SIGN_FAILED",
  KHALANI_SOLANA_KEYSTORE_NOT_FOUND: "KHALANI_SOLANA_KEYSTORE_NOT_FOUND",
  KHALANI_ADDRESS_MISMATCH: "KHALANI_ADDRESS_MISMATCH",
  KHALANI_UNSUPPORTED_DEPOSIT_METHOD: "KHALANI_UNSUPPORTED_DEPOSIT_METHOD",
  /**
   * An EVM transaction's `tx.value` could not be fully attributed to proven
   * cost components, or the transaction reaching the signer is not the one
   * whose value was authorized. An AUTHORIZATION failure, not an economics one
   * — maps to the `agent_activity` failure code `allowance_or_balance` with a
   * structured reason. Nothing is signed.
   * See `src/tools/evm-chains/native-value-authorization`.
   */
  NATIVE_VALUE_UNAUTHORIZED: "NATIVE_VALUE_UNAUTHORIZED",
  /**
   * A provider quoted a gas limit so far above Vex's own fresh
   * `eth_estimateGas` for the same call that Vex will not sign it. The inverse
   * of the lowball defect: our floor stops a provider lowering the limit, this
   * stops one raising Vex's signed exposure without bound. A PRE-SIGN refusal —
   * nothing is signed, staged, or broadcast.
   * See `src/tools/evm-chains/gas-limit-headroom.ts`.
   */
  PROVIDER_GAS_LIMIT_EXCESSIVE: "PROVIDER_GAS_LIMIT_EXCESSIVE",

  // Relay (api.relay.link) — keyless cross-chain bridge
  RELAY_API_ERROR: "RELAY_API_ERROR",
  RELAY_TIMEOUT: "RELAY_TIMEOUT",
  RELAY_RATE_LIMITED: "RELAY_RATE_LIMITED",
  RELAY_UNSUPPORTED_CHAIN: "RELAY_UNSUPPORTED_CHAIN",
  RELAY_NO_ROUTE: "RELAY_NO_ROUTE",
  RELAY_UNSUPPORTED_STEP: "RELAY_UNSUPPORTED_STEP",
  RELAY_STEP_CHAIN_MISMATCH: "RELAY_STEP_CHAIN_MISMATCH",
  RELAY_BRIDGE_FAILED: "RELAY_BRIDGE_FAILED",

  // KyberSwap — shared
  KYBER_API_ERROR: "KYBER_API_ERROR",
  KYBER_TIMEOUT: "KYBER_TIMEOUT",
  KYBER_RATE_LIMITED: "KYBER_RATE_LIMITED",
  /**
   * The venue was never reached: DNS, TLS, connection reset, or any other
   * transport failure that produced no HTTP response at all. Distinct from
   * KYBER_API_ERROR, which means a response DID arrive and we could not use
   * it. The split is load-bearing, not cosmetic: only the first is evidence
   * that KyberSwap cannot serve this client, and `verifyRouterAddress` plus
   * the response-schema validators also throw KYBER_API_ERROR with no status,
   * so "KYBER_API_ERROR and no httpStatus" cannot stand in for "unreachable".
   */
  KYBER_UNREACHABLE: "KYBER_UNREACHABLE",
  KYBER_UNSUPPORTED_CHAIN: "KYBER_UNSUPPORTED_CHAIN",

  // KyberSwap Aggregator
  KYBER_ROUTE_NOT_FOUND: "KYBER_ROUTE_NOT_FOUND",
  KYBER_TOKEN_NOT_FOUND: "KYBER_TOKEN_NOT_FOUND",
  KYBER_BUILD_FAILED: "KYBER_BUILD_FAILED",
  KYBER_MALFORMED_PARAMS: "KYBER_MALFORMED_PARAMS",
  KYBER_FEE_EXCEEDS_AMOUNT: "KYBER_FEE_EXCEEDS_AMOUNT",
  KYBER_AMOUNT_TOO_LARGE: "KYBER_AMOUNT_TOO_LARGE",
  KYBER_WETH_NOT_CONFIGURED: "KYBER_WETH_NOT_CONFIGURED",
  /**
   * The built swap calldata's embedded `minReturnAmount` is below the price
   * floor Vex approved at quote time (or below the floor the fresh route
   * implies). A genuine slippage abort — maps to the `agent_activity`
   * failure code `slippage`. Nothing is signed.
   */
  KYBER_PRICE_FLOOR_VIOLATED: "KYBER_PRICE_FLOOR_VIOLATED",
  /**
   * The built swap calldata does not match the transaction Vex approved in a
   * NON-price way: wrong router/target, an unexpected approve spender, an
   * unexpected native value, a fee line that is not the Vex constant, or a
   * flag set (partial fill / fee-on-destination) we never approve. Maps to
   * `route_not_found`, mirroring Solana's fee-policy divergence abort.
   * Nothing is signed.
   */
  KYBER_UNSAFE_BUILD: "KYBER_UNSAFE_BUILD",

  // KyberSwap Token API
  KYBER_TOKEN_SEARCH_FAILED: "KYBER_TOKEN_SEARCH_FAILED",
  KYBER_HONEYPOT_CHECK_FAILED: "KYBER_HONEYPOT_CHECK_FAILED",

  // Setup
  SETUP_TARGET_EXISTS: "SETUP_TARGET_EXISTS",
  SETUP_LINK_FAILED: "SETUP_LINK_FAILED",
  SETUP_SOURCE_NOT_FOUND: "SETUP_SOURCE_NOT_FOUND",
  SYSTEM_CHECK_FAILED: "SYSTEM_CHECK_FAILED",
  CONNECTOR_WRITE_FAILED: "CONNECTOR_WRITE_FAILED",
  SETUP_CANCELLED: "SETUP_CANCELLED",

  // Openclaw
  OPENCLAW_CONFIG_WRITE_FAILED: "OPENCLAW_CONFIG_WRITE_FAILED",
  OPENCLAW_CONFIG_PARSE_FAILED: "OPENCLAW_CONFIG_PARSE_FAILED",
  OPENCLAW_HOOKS_VALIDATION_FAILED: "OPENCLAW_HOOKS_VALIDATION_FAILED",
  OPENCLAW_HOOKS_TOKEN_MISMATCH: "OPENCLAW_HOOKS_TOKEN_MISMATCH",
  OPENCLAW_HOOKS_PROBE_FAILED: "OPENCLAW_HOOKS_PROBE_FAILED",

  KEYSTORE_CORRUPT: "KEYSTORE_CORRUPT",

  // Wallet import/export
  INVALID_PRIVATE_KEY: "INVALID_PRIVATE_KEY",
  EXPORT_BLOCKED_HEADLESS: "EXPORT_BLOCKED_HEADLESS",
  EXPORT_REQUIRES_ACKNOWLEDGE: "EXPORT_REQUIRES_ACKNOWLEDGE",

  // Backup
  BACKUP_NOT_FOUND: "BACKUP_NOT_FOUND",
  BACKUP_CREATE_FAILED: "BACKUP_CREATE_FAILED",
  AUTO_BACKUP_FAILED: "AUTO_BACKUP_FAILED",

  // Backup archive restore
  ARCHIVE_MANIFEST_MALFORMED: "ARCHIVE_MANIFEST_MALFORMED",
  ARCHIVE_INCOMPLETE: "ARCHIVE_INCOMPLETE",
  ARCHIVE_RESTORE_FAILED: "ARCHIVE_RESTORE_FAILED",
  WALLET_USER_REJECTED: "WALLET_USER_REJECTED",

  // Bot
  BOT_ALREADY_RUNNING: "BOT_ALREADY_RUNNING",
  BOT_NOT_RUNNING: "BOT_NOT_RUNNING",
  BOT_ORDER_NOT_FOUND: "BOT_ORDER_NOT_FOUND",
  BOT_INVALID_TRIGGER: "BOT_INVALID_TRIGGER",
  BOT_INVALID_ORDER: "BOT_INVALID_ORDER",
  BOT_STREAM_FAILED: "BOT_STREAM_FAILED",
  BOT_TRADE_FAILED: "BOT_TRADE_FAILED",
  BOT_GUARDRAIL_EXCEEDED: "BOT_GUARDRAIL_EXCEEDED",

  // Update Daemon
  UPDATE_DAEMON_ALREADY_RUNNING: "UPDATE_DAEMON_ALREADY_RUNNING",
  UPDATE_DAEMON_NOT_RUNNING: "UPDATE_DAEMON_NOT_RUNNING",

  // Guardrails
  WALLET_MUTATION_BLOCKED_HEADLESS: "WALLET_MUTATION_BLOCKED_HEADLESS",

  // Onboard
  ONBOARD_REQUIRES_TTY: "ONBOARD_REQUIRES_TTY",

  // Claude Proxy
  CLAUDE_PROXY_ALREADY_RUNNING: "CLAUDE_PROXY_ALREADY_RUNNING",
  CLAUDE_PROXY_NOT_RUNNING: "CLAUDE_PROXY_NOT_RUNNING",
  CLAUDE_PROXY_START_FAILED: "CLAUDE_PROXY_START_FAILED",
  CLAUDE_CONFIG_PARSE_FAILED: "CLAUDE_CONFIG_PARSE_FAILED",
  CLAUDE_CONFIG_WRITE_FAILED: "CLAUDE_CONFIG_WRITE_FAILED",
  CLAUDE_CONFIG_RESTORE_FAILED: "CLAUDE_CONFIG_RESTORE_FAILED",
  CLAUDE_CONFIG_NOT_CONFIGURED: "CLAUDE_CONFIG_NOT_CONFIGURED",

  // Launcher
  LAUNCHER_START_FAILED: "LAUNCHER_START_FAILED",
  LAUNCHER_NOT_RUNNING: "LAUNCHER_NOT_RUNNING",

  // Solana
  SOLANA_INVALID_ADDRESS: "SOLANA_INVALID_ADDRESS",
  SOLANA_INSUFFICIENT_BALANCE: "SOLANA_INSUFFICIENT_BALANCE",
  SOLANA_TRANSFER_FAILED: "SOLANA_TRANSFER_FAILED",
  SOLANA_TX_FAILED: "SOLANA_TX_FAILED",
  SOLANA_TX_TIMEOUT: "SOLANA_TX_TIMEOUT",
  // W5 staged seam (design §2/R2b): the strict sole-signer check refused to
  // sign (wrong required-signer count, signer mismatch, or a preserved
  // nonzero signature that a blockhash replacement would invalidate).
  SOLANA_TX_SOLE_SIGNER_VIOLATION: "SOLANA_TX_SOLE_SIGNER_VIOLATION",
  // W5 staged seam: caller-supplied blockhash evidence (VERIFY mode) does not
  // match the transaction's own embedded `recentBlockhash`.
  SOLANA_TX_BLOCKHASH_MISMATCH: "SOLANA_TX_BLOCKHASH_MISMATCH",
  SOLANA_TOKEN_NOT_FOUND: "SOLANA_TOKEN_NOT_FOUND",
  SOLANA_RPC_ERROR: "SOLANA_RPC_ERROR",
  SOLANA_QUOTE_FAILED: "SOLANA_QUOTE_FAILED",
  SOLANA_SWAP_FAILED: "SOLANA_SWAP_FAILED",
  SOLANA_STAKE_FAILED: "SOLANA_STAKE_FAILED",
  SOLANA_ORDER_FAILED: "SOLANA_ORDER_FAILED",


  // Jupiter Portfolio
  SOLANA_PORTFOLIO_FAILED: "SOLANA_PORTFOLIO_FAILED",

  // Jupiter Lend
  SOLANA_LEND_DEPOSIT_FAILED: "SOLANA_LEND_DEPOSIT_FAILED",
  SOLANA_LEND_WITHDRAW_FAILED: "SOLANA_LEND_WITHDRAW_FAILED",
  SOLANA_LEND_RATES_FAILED: "SOLANA_LEND_RATES_FAILED",

  // Jupiter Send
  SOLANA_SEND_INVITE_FAILED: "SOLANA_SEND_INVITE_FAILED",
  SOLANA_SEND_CLAWBACK_FAILED: "SOLANA_SEND_CLAWBACK_FAILED",

  // Jupiter Prediction
  SOLANA_PREDICT_ORDER_FAILED: "SOLANA_PREDICT_ORDER_FAILED",
  SOLANA_PREDICT_CLAIM_FAILED: "SOLANA_PREDICT_CLAIM_FAILED",

  // Jupiter Studio
  SOLANA_STUDIO_CREATE_FAILED: "SOLANA_STUDIO_CREATE_FAILED",
  SOLANA_STUDIO_CLAIM_FAILED: "SOLANA_STUDIO_CLAIM_FAILED",

  // Solana LP
  SOLANA_LP_POOL_NOT_FOUND: "SOLANA_LP_POOL_NOT_FOUND",
  SOLANA_LP_POSITION_NOT_FOUND: "SOLANA_LP_POSITION_NOT_FOUND",
  SOLANA_LP_DEPOSIT_FAILED: "SOLANA_LP_DEPOSIT_FAILED",
  SOLANA_LP_WITHDRAW_FAILED: "SOLANA_LP_WITHDRAW_FAILED",
  SOLANA_LP_CLAIM_FAILED: "SOLANA_LP_CLAIM_FAILED",

  // DexScreener
  DEXSCREENER_API_ERROR: "DEXSCREENER_API_ERROR",
  DEXSCREENER_RATE_LIMITED: "DEXSCREENER_RATE_LIMITED",
  DEXSCREENER_TIMEOUT: "DEXSCREENER_TIMEOUT",
  DEXSCREENER_INVALID_RESPONSE: "DEXSCREENER_INVALID_RESPONSE",
  DEXSCREENER_NOT_FOUND: "DEXSCREENER_NOT_FOUND",

  // Virtuals Protocol (agent-token intelligence — read-only)
  VIRTUALS_API_ERROR: "VIRTUALS_API_ERROR",
  VIRTUALS_RATE_LIMITED: "VIRTUALS_RATE_LIMITED",
  VIRTUALS_TIMEOUT: "VIRTUALS_TIMEOUT",
  VIRTUALS_INVALID_RESPONSE: "VIRTUALS_INVALID_RESPONSE",
  VIRTUALS_NOT_FOUND: "VIRTUALS_NOT_FOUND",

  // Pendle v2 (fixed-yield PT — Ethereum v1)
  PENDLE_API_ERROR: "PENDLE_API_ERROR",
  PENDLE_RATE_LIMITED: "PENDLE_RATE_LIMITED",
  PENDLE_TIMEOUT: "PENDLE_TIMEOUT",
  PENDLE_INVALID_RESPONSE: "PENDLE_INVALID_RESPONSE",
  PENDLE_VALUATION_TOO_LOW: "PENDLE_VALUATION_TOO_LOW",
  PENDLE_VALUATION_TOO_HIGH: "PENDLE_VALUATION_TOO_HIGH",
  PENDLE_TOKEN_NOT_FOUND: "PENDLE_TOKEN_NOT_FOUND",
  PENDLE_MARKET_EXPIRED: "PENDLE_MARKET_EXPIRED",
  PENDLE_NO_ROUTE: "PENDLE_NO_ROUTE",
  PENDLE_UNSAFE_TX: "PENDLE_UNSAFE_TX",
  PENDLE_MARKET_NOT_FOUND: "PENDLE_MARKET_NOT_FOUND",

  // Morpho (EVM variable-rate lending - keyless GraphQL read client, batch 1)
  MORPHO_API_ERROR: "MORPHO_API_ERROR",
  MORPHO_RATE_LIMITED: "MORPHO_RATE_LIMITED",
  MORPHO_TIMEOUT: "MORPHO_TIMEOUT",
  MORPHO_INVALID_RESPONSE: "MORPHO_INVALID_RESPONSE",
  MORPHO_MARKET_NOT_FOUND: "MORPHO_MARKET_NOT_FOUND",
  /**
   * Named vault does not exist on the named chain, or exists in the OTHER
   * generation. Distinct from a schema refusal: Morpho answers both with HTTP
   * 200 and an `errors[]` array, and an agent that cannot tell "wrong address"
   * from "our query broke" retries the wrong one.
   */
  MORPHO_VAULT_NOT_FOUND: "MORPHO_VAULT_NOT_FOUND",
  MORPHO_UNSUPPORTED_CHAIN: "MORPHO_UNSUPPORTED_CHAIN",
  /**
   * The client's own budget or circuit breaker refused BEFORE any request left
   * the process. Distinct from `MORPHO_RATE_LIMITED`, which is Morpho's own
   * verdict: one is our restraint, the other is their refusal, and an agent that
   * cannot tell them apart cannot report what happened.
   */
  MORPHO_BUDGET_EXHAUSTED: "MORPHO_BUDGET_EXHAUSTED",

  // Trench Express (RBC 4663 launchpad — read-only client, P1)
  TRENCH_API_ERROR: "TRENCH_API_ERROR",
  TRENCH_TIMEOUT: "TRENCH_TIMEOUT",
  TRENCH_INVALID_RESPONSE: "TRENCH_INVALID_RESPONSE",
  TRENCH_INVALID_REQUEST: "TRENCH_INVALID_REQUEST",
  TRENCH_NOT_FOUND: "TRENCH_NOT_FOUND",

  // AgentScan wallet-binding handshake (Sprint 3)
  AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED: "AGENTSCAN_HANDSHAKE_TEMPLATE_REJECTED",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
