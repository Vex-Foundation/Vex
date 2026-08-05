export type ChainFamily = "eip155" | "solana";
export type TradeType = "EXACT_INPUT" | "EXACT_OUTPUT";
export type DepositMethod = "CONTRACT_CALL" | "PERMIT2" | "TRANSFER";
export type OrderStatus =
  | "created"
  | "deposited"
  | "published"
  | "filled"
  | "refund_pending"
  | "refunded"
  | "failed";

export interface KhalaniChain {
  type: ChainFamily;
  id: number;
  name: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  rpcUrls?: {
    default?: {
      http?: string[];
    };
  };
  blockExplorers?: {
    default?: {
      name: string;
      url: string;
      apiUrl?: string;
    };
  };
}

export interface KhalaniToken {
  address: string;
  chainId: number;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  extensions?: {
    balance?: string;
    isRiskToken?: boolean;
    price?: {
      usd?: string;
    };
    [key: string]: unknown;
  };
}

export interface TokenSearchResponse {
  data: KhalaniToken[];
}

export interface AutocompleteResult {
  description: string;
  chain: KhalaniChain;
  token: KhalaniToken;
  amount?: string;
  usdAmount?: string;
}

export interface AutocompleteResponse {
  data: AutocompleteResult[];
  parsed?: Record<string, unknown>;
  nextSlots?: string[];
}

/**
 * Outbound POST /v1/quotes body.
 *
 * Khalani's API also accepts `referrer` + `referrerFeeBps` (an integrator
 * referral fee skimmed off the bridged amount and paid to an arbitrary EVM
 * address). Vex charges NO bridge referral fee and deliberately OMITS both
 * fields from this type, so no code path — and in particular no model/tool
 * param — can put a fee-bearing field on the wire. See the fee policy in
 * `request.ts`; the same doctrine governs KyberSwap in
 * `src/tools/kyberswap/constants.ts`.
 */
export interface QuoteRequest {
  tradeType: TradeType;
  fromChainId: number;
  fromToken: string;
  toChainId: number;
  toToken: string;
  amount: string;
  fromAddress: string;
  recipient?: string;
  refundTo?: string;
  filler?: string;
}

export interface QuoteRoute {
  routeId: string;
  type: string;
  icon?: string;
  exactOutMethod?: string;
  depositMethods: DepositMethod[];
  quote: {
    amountIn: string;
    amountOut: string;
    expectedDurationSeconds: number;
    validBefore: number;
    quoteExpiresAt?: number;
    estimatedGas?: string;
    tags?: string[];
    // Live drift (undocumented): the quote endpoint returns the deposit methods
    // this route actually supports. Kept as raw strings — it is undocumented,
    // untrusted provider data, so it is NOT coerced into the closed
    // `DepositMethod` union. Absent when the provider omits it.
    supportedDepositMethods?: string[];
  };
}

export interface QuoteResponse {
  quoteId: string;
  routes: QuoteRoute[];
}

export interface QuoteStreamRoute extends QuoteRoute {
  quoteId: string;
}

export interface DepositBuildRequest {
  from: string;
  quoteId: string;
  routeId: string;
  depositMethod?: DepositMethod;
}

export interface EvmApproval {
  type: "eip1193_request";
  request: {
    method: string;
    params?: unknown[];
  };
  waitForReceipt?: boolean;
  deposit?: boolean;
}

export interface SolanaApproval {
  type: "solana_sendTransaction";
  transaction: string;
  deposit?: boolean;
}

export type Approval = EvmApproval | SolanaApproval;

export interface ContractCallDepositPlan {
  kind: "CONTRACT_CALL";
  approvals: Approval[];
}

export interface Permit2DepositPlan {
  kind: "PERMIT2";
  permit: Record<string, unknown>;
  transferDetails: Record<string, unknown>;
}

export interface TransferDepositPlan {
  kind: "TRANSFER";
  depositAddress: string;
  amount: string;
  token: string;
  chainId: number;
  memo?: string;
  expiresAt?: number;
}

export type DepositPlan = ContractCallDepositPlan | Permit2DepositPlan | TransferDepositPlan;

export interface SubmitRequest {
  quoteId: string;
  routeId: string;
  txHash?: string;
  signedTransaction?: string;
}

export interface SubmitResponse {
  orderId: string;
  txHash: string;
}

export interface KhalaniTransactionInfo {
  timestamp: string;
  txHash: string;
  chainId: number;
  amount?: string;
}

export interface KhalaniTokenMeta {
  symbol: string;
  decimals: number;
  logoURI?: string;
}

export interface KhalaniProviderStatus {
  provider: string;
  nativeStatus: string;
  substatus?: string;
  metadata?: Record<string, unknown>;
}

export interface KhalaniOrder {
  id: string;
  type: string;
  quoteId: string;
  routeId: string;
  fromChainId: number;
  fromToken: string;
  toChainId: number;
  toToken: string;
  srcAmount: string;
  destAmount: string;
  status: OrderStatus;
  author: string;
  recipient: string | null;
  refundTo: string | null;
  // Live drift: present on live orders (the address of the filler that settled
  // the destination leg), `null` before a filler is assigned. Modeled as
  // string | null, mirroring recipient/refundTo.
  fillerAddress: string | null;
  depositTxHash: string;
  externalOrderId?: string;
  createdAt: string;
  updatedAt: string;
  tradeType: TradeType;
  stepsCompleted: string[];
  transactions: Record<string, KhalaniTransactionInfo>;
  timestamps?: Record<string, string>;
  providerStatus?: KhalaniProviderStatus;
  fromTokenMeta: KhalaniTokenMeta | null;
  toTokenMeta: KhalaniTokenMeta | null;
}

export interface OrdersResponse {
  data: KhalaniOrder[];
  cursor?: number;
}

/**
 * Khalani's error envelope, as the API actually emits it (W2d).
 *
 * BOTH fields are optional because both are optional on the wire. Live
 * (2026-08-03): `GET /v1/nope` answers `404 Not Found` as PLAIN TEXT, and a
 * gateway JSON body can carry `message` with no `name`. Requiring `name` made
 * the parser return `null` for those, which collapsed the provider's own words
 * into a bare status line.
 *
 * `details` is the field Khalani's own docs tell integrators to read — "use the
 * details array to identify problematic fields". Live 400 body:
 * `{"message":"Validation failed","name":"ValidationException",
 *   "details":[{"field":"fromToken","message":"Must be a valid EVM, Solana,
 *   BTC, CKB, or Tron address","code":"custom"}]}`. The object form is kept
 * because other exceptions use it (e.g. `{"quoteId":"…"}`).
 */
export interface KhalaniErrorBody {
  message?: string;
  name?: string;
  details?: Record<string, unknown> | Array<Record<string, unknown>>;
}
