import {
  LIGHTER_CANDLE_RESOLUTIONS,
  LIGHTER_DEFAULT_ENVIRONMENT,
  LIGHTER_ENVIRONMENTS,
  LIGHTER_MARKET_FILTERS,
} from "@tools/lighter/constants.js";
import {
  LIGHTER_ORDER_SIDES,
} from "@tools/lighter/order-preview.js";
import {
  LIGHTER_PHASE_ONE_ORDER_TYPES,
  LIGHTER_PHASE_ONE_TIME_IN_FORCE,
} from "@tools/lighter/order-policy.js";
import type { ProtocolParamDef, ProtocolToolManifest } from "../../types.js";
import { LIGHTER_MARKET_DATA_DISCOVERY } from "../../embeddings/lighter/market-data.js";
import {
  LIGHTER_AGENT_CANDLE_OUTPUT_MAX,
  LIGHTER_AGENT_ACCOUNT_POSITION_MAX,
  LIGHTER_AGENT_ACCOUNT_ORDER_LIMIT_DEFAULT,
  LIGHTER_AGENT_ACCOUNT_ORDER_LIMIT_MAX,
  LIGHTER_AGENT_API_KEY_LIMIT_DEFAULT,
  LIGHTER_AGENT_API_KEY_LIMIT_MAX,
  LIGHTER_AGENT_ACCOUNT_ROW_MAX,
  LIGHTER_AGENT_MARKET_LIMIT_DEFAULT,
  LIGHTER_AGENT_MARKET_LIMIT_MAX,
  LIGHTER_AGENT_MARKET_PAGE_MAX,
  LIGHTER_AGENT_ORDERBOOK_LIMIT_DEFAULT,
  LIGHTER_AGENT_ORDERBOOK_LIMIT_MAX,
  LIGHTER_AGENT_RECENT_TRADES_LIMIT_DEFAULT,
  LIGHTER_AGENT_RECENT_TRADES_LIMIT_MAX,
  LIGHTER_ORDER_EXPIRY_OFFSET_MINUTES_MAX,
  LIGHTER_ORDER_EXPIRY_OFFSET_MINUTES_MIN,
  LIGHTER_ORDER_PREVIEW_MARKET_TYPES,
} from "../params.js";

const ENVIRONMENT_PARAM: ProtocolParamDef = {
  key: "environment",
  type: "string",
  enum: LIGHTER_ENVIRONMENTS,
  description:
    `Optional public Lighter environment to read: core for Lighter Core, rhc for Robinhood Chain. Defaults to ${LIGHTER_DEFAULT_ENVIRONMENT} for conversational Lighter requests. Any other value is rejected.`,
};

const MARKET_ID_REQUIRED_PARAM: ProtocolParamDef = {
  key: "marketId",
  type: "number",
  required: true,
  description:
    "Numeric Lighter market id from lighter__markets_list, as an integer from 0 to 65535. It names the order book to read.",
};

const MARKET_ID_OPTIONAL_PARAM: ProtocolParamDef = {
  ...MARKET_ID_REQUIRED_PARAM,
  required: false,
  description:
    "Optional numeric Lighter market id from lighter__markets_list. When omitted, the market list reads the environment's visible markets.",
};

const MARKET_SYMBOL_PARAM: ProtocolParamDef = {
  key: "marketSymbol",
  type: "string",
  description:
    "Optional market symbol such as ETH or ETH/USDC. Use this for conversational order previews when the user names an asset instead of a market id; Vex resolves it against live Lighter markets. Also pass marketType when the symbol can exist as both a perpetual and spot product.",
};

const ORDER_PREVIEW_MARKET_TYPE_PARAM: ProtocolParamDef = {
  key: "marketType",
  type: "string",
  enum: LIGHTER_ORDER_PREVIEW_MARKET_TYPES,
  description:
    "Optional exact Lighter product type for this order preview: perp or spot. Include it when resolving marketSymbol so a spot request cannot silently select the same asset's perpetual market. With marketId, the live market detail must match this value or the preview is refused.",
};

const MARKET_FILTER_PARAM: ProtocolParamDef = {
  key: "filter",
  type: "string",
  enum: LIGHTER_MARKET_FILTERS,
  description:
    "Optional market-type filter accepted by Lighter: all, spot, or perp. The value is exact and unsupported values are rejected.",
};

const ACCOUNT_INDEX_PARAM: ProtocolParamDef = {
  key: "accountIndex",
  type: "number",
  description:
    "Optional Lighter account index as a safe non-negative integer. Provide exactly one of accountIndex or walletAddress.",
};

const AUTH_ACCOUNT_INDEX_PARAM: ProtocolParamDef = {
  key: "accountIndex",
  type: "number",
  description:
    "Optional account index. Omit to use the account bound to the default saved Vex-managed Lighter trading credential. Derived read-only authorization refuses account mismatches.",
};

const REQUIRED_ACCOUNT_INDEX_PARAM: ProtocolParamDef = {
  key: "accountIndex",
  type: "number",
  required: true,
  description:
    "Required Lighter account index as a safe non-negative integer. This is public account-index metadata, not a private credential.",
};

const WALLET_ADDRESS_PARAM: ProtocolParamDef = {
  key: "walletAddress",
  type: "string",
  description:
    "Optional 0x-prefixed L1 EVM wallet address that owns the Lighter account. Provide exactly one of walletAddress or accountIndex.",
};

const ACTIVE_ONLY_PARAM: ProtocolParamDef = {
  key: "activeOnly",
  type: "boolean",
  description:
    "Optional Lighter account filter forwarded to the public account endpoint when supported.",
};

const MARKET_LIST_LIMIT_PARAM: ProtocolParamDef = {
  key: "limit",
  type: "number",
  description:
    `Max market rows to return after the provider response is read (default ${LIGHTER_AGENT_MARKET_LIMIT_DEFAULT}, max ${LIGHTER_AGENT_MARKET_LIMIT_MAX}). Out-of-range values are rejected.`,
};

const MARKET_LIST_PAGE_PARAM: ProtocolParamDef = {
  key: "page",
  type: "number",
  description:
    `1-based page over Vex's deterministic market ordering (default 1, max ${LIGHTER_AGENT_MARKET_PAGE_MAX}). Pair it with nextPage to continue broad lists.`,
};

const ORDERBOOK_LIMIT_PARAM: ProtocolParamDef = {
  key: "limit",
  type: "number",
  description:
    `Max ask rows and max bid rows to return (default ${LIGHTER_AGENT_ORDERBOOK_LIMIT_DEFAULT}, max ${LIGHTER_AGENT_ORDERBOOK_LIMIT_MAX}). The response reports provider totals and truncation flags.`,
};

const ACCOUNT_ORDER_LIMIT_PARAM: ProtocolParamDef = {
  key: "limit",
  type: "number",
  description:
    `Max account order/trade rows to return (default ${LIGHTER_AGENT_ACCOUNT_ORDER_LIMIT_DEFAULT}, max ${LIGHTER_AGENT_ACCOUNT_ORDER_LIMIT_MAX}). Out-of-range values are rejected.`,
};

const API_KEY_LIMIT_PARAM: ProtocolParamDef = {
  key: "limit",
  type: "number",
  description:
    `Max API-key metadata rows to return (default ${LIGHTER_AGENT_API_KEY_LIMIT_DEFAULT}, max ${LIGHTER_AGENT_API_KEY_LIMIT_MAX}). Out-of-range values are rejected.`,
};

const API_KEY_INSPECT_INDEX_PARAM: ProtocolParamDef = {
  key: "apiKeyIndex",
  type: "number",
  description:
    "Optional Lighter API-key index from 0 to 255. Omit it to request the provider's all-keys sentinel, which is useful for nonce planning before a future signer path.",
};

const TRADES_LIMIT_PARAM: ProtocolParamDef = {
  key: "limit",
  type: "number",
  description:
    `Max recent trade rows to return (default ${LIGHTER_AGENT_RECENT_TRADES_LIMIT_DEFAULT}, max ${LIGHTER_AGENT_RECENT_TRADES_LIMIT_MAX}). Out-of-range values are rejected, not clamped.`,
};

const ORDER_SIDE_PARAM: ProtocolParamDef = {
  key: "side",
  type: "string",
  required: true,
  enum: LIGHTER_ORDER_SIDES,
  description:
    "Order side to preview: buy or sell. If the user does not say which direction, ask a short clarification instead of guessing. Unsupported values are rejected.",
};

const BASE_AMOUNT_PARAM: ProtocolParamDef = {
  key: "baseAmountIn",
  type: "string",
  required: true,
  description:
    "Order size in the BASE asset as a human decimal string, for example 0.25. Vex converts it exactly using live Lighter size decimals and refuses rounding.",
};

const ORDER_PRICE_PARAM: ProtocolParamDef = {
  key: "price",
  type: "string",
  required: true,
  description:
    "Hard execution-price bound as a human decimal string. For a market order this is the immediate worst acceptable price. For stop-loss or take-profit it is the worst price Lighter may execute after the trigger fires; it is not the trigger price.",
};

const TRIGGER_PRICE_PARAM: ProtocolParamDef = {
  key: "triggerPrice",
  type: "string",
  description:
    "Required for stop-loss and take-profit orders and forbidden for ordinary market orders. Human decimal trigger price. Vex verifies it is on the protective side of the live market for the current perpetual position.",
};

const ORDER_TYPE_PARAM: ProtocolParamDef = {
  key: "orderType",
  type: "string",
  enum: LIGHTER_PHASE_ONE_ORDER_TYPES,
  description:
    "Optional order type. Enabled values are market, stop-loss, and take-profit. Stop-loss and take-profit are perpetual-only, reduce-only protective orders and require triggerPrice. Resting limit, trigger-limit, TWAP, and grouped creation remain release-gated.",
};

const TIME_IN_FORCE_PARAM: ProtocolParamDef = {
  key: "timeInForce",
  type: "string",
  enum: LIGHTER_PHASE_ONE_TIME_IN_FORCE,
  description:
    "Optional time-in-force. The only enabled value is immediate-or-cancel, which is also the default. Good-till-time and post-only creation remain release-gated.",
};

const REDUCE_ONLY_PARAM: ProtocolParamDef = {
  key: "reduceOnly",
  type: "boolean",
  description:
    "Optional reduce-only flag. Defaults to false. When true, Vex requires live account position evidence that the side reduces the current position.",
};

const ORDER_EXPIRY_PARAM: ProtocolParamDef = {
  key: "orderExpiry",
  type: "number",
  description:
    "Exact order expiry as a JavaScript epoch-milliseconds integer. Use orderExpiryOffsetMinutes instead when the user says a relative expiry such as '30 minutes from now'. Vex requires the final expiry to be between 5 minutes and 30 days from preview time.",
};

const ORDER_EXPIRY_OFFSET_MINUTES_PARAM: ProtocolParamDef = {
  key: "orderExpiryOffsetMinutes",
  type: "number",
  description:
    `Preferred for relative expiries such as '30 minutes from now'. Whole minutes from preview time, between ${LIGHTER_ORDER_EXPIRY_OFFSET_MINUTES_MIN} and ${LIGHTER_ORDER_EXPIRY_OFFSET_MINUTES_MAX}. Do not combine with orderExpiry.`,
};

const API_KEY_INDEX_PARAM: ProtocolParamDef = {
  key: "apiKeyIndex",
  type: "number",
  description:
    "Optional Lighter API-key index override. Omit for normal order previews; Vex attempts to resolve a public trading API-key index for later approval preparation, but a missing trading key does not block the read-only preview. This does not require or expose API private key material.",
};

const ONBOARDING_WALLET_ADDRESS_PARAM: ProtocolParamDef = {
  key: "walletAddress",
  type: "string",
  description:
    "Optional 0x-prefixed EVM wallet address to check. Omit to use the session's selected Vex wallet (resolved address-only). Never a private key.",
};

const ONBOARDING_REQUIRED_COLLATERAL_PARAM: ProtocolParamDef = {
  key: "amountIn",
  type: "string",
  description:
    "Optional target collateral for an explicitly requested trade, in human settlement-asset decimals (USDC on Core or USDG on RHC, both 6 decimals), for example \"11\". This is not a direct deposit amount. Never pass a user's request to deposit or fund an exact amount here; call lighter__deposit_prepare with that amount unchanged instead. Pass a known trade amount with marketSymbol or marketId so Vex checks the live market minimum before comparing current collateral with the target. Omit during amount-free setup discovery. Never ask the user for account or API-key indexes.",
};

export const LIGHTER_READ_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "lighter.account.onboarding.status",
    publicName: "lighter__account_onboarding_status",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Report the selected Vex wallet's managed Lighter trade readiness on Core or Robinhood Chain and the minimal setup steps still required. Do not use this tool to resize a direct deposit request: when the user says deposit or fund an explicit amount, call lighter__deposit_prepare with that amount unchanged. Omit walletAddress to use the selected wallet; never ask for account, API-key, nonce, fingerprint, or key material. Read-only: for an explicitly requested trade it checks the live market quote minimum, wallet-owned Lighter collateral, the environment-specific settlement asset (Ethereum USDC or Robinhood Chain USDG), native ETH gas balance, gateway allowance, live deposit minimum, and exact locally managed trading-credential readiness. Returns deterministic trade-funding and trading-access routes. A sub-minimum trade/top-up or insufficient settlement balance stops before preparation. Eligible trade funding may route to lighter__deposit_prepare; once funding and account ownership are proven, missing managed access may route separately to lighter__key_register_prepare. This tool moves no funds and signs nothing.",
    mutating: false,
    actionKind: "read",
    params: [
      ENVIRONMENT_PARAM,
      ONBOARDING_WALLET_ADDRESS_PARAM,
      ONBOARDING_REQUIRED_COLLATERAL_PARAM,
      MARKET_ID_OPTIONAL_PARAM,
      MARKET_SYMBOL_PARAM,
    ],
    atMostOne: [["marketId", "marketSymbol"]],
    exampleParams: { environment: "rhc", amountIn: "11", marketSymbol: "SUI" },
    discovery:
      LIGHTER_MARKET_DATA_DISCOVERY["lighter.account.onboarding.status"],
  },
  {
    toolId: "lighter.system",
    publicName: "lighter__system_get",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Read Lighter public system status and system configuration for Core or Robinhood Chain. Use when checking whether an environment is reachable, matching a market-data read to a network id, or reviewing public fee/cooldown configuration before deeper reads. Returns status code, network id, timestamp, pool indexes, cooldown periods, and public integrator fee ceilings. Read-only: no account lookup, credentials, wallet, signer, order, deposit, or withdrawal path.",
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM],
    exampleParams: { environment: "rhc" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.system"],
  },
  {
    toolId: "lighter.markets",
    publicName: "lighter__markets_list",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "List Lighter public markets/order books on Core or Robinhood Chain. Use when the user needs symbols, market ids, active/inactive status, spot versus perp coverage, fee strings, minimum order amounts, quote limits, or decimal metadata before requesting detail, depth, trades, or candles. Returns deterministically ordered, bounded market rows plus provider row count, page, nextPage, and truncation disclosure so broad market lists are walkable instead of silently shortened. Read-only: no account, key, signing, order, deposit, or withdrawal access.",
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, MARKET_ID_OPTIONAL_PARAM, MARKET_FILTER_PARAM, MARKET_LIST_LIMIT_PARAM, MARKET_LIST_PAGE_PARAM],
    exampleParams: { environment: "rhc", filter: "all", limit: 25, page: 1 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.markets"],
  },
  {
    toolId: "lighter.market.get",
    publicName: "lighter__market_get",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Get detailed public metadata for one Lighter market on Core or Robinhood Chain by numeric marketId. Use when the user already has a market id and needs last trade price, daily activity, volume, open interest, fees, decimals, funding fields, minimums, and status before inspecting depth, trades, or candles. Returns matching detail rows and fails clearly if the market id is not found. Base and quote asset ids are numeric provider identifiers, not symbols; never infer labels for them from the market symbol. Read-only: no account data, signing, order placement, deposit, or withdrawal support.",
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, MARKET_ID_REQUIRED_PARAM, MARKET_FILTER_PARAM],
    exampleParams: { environment: "rhc", marketId: 0, filter: "all" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.market.get"],
  },
  {
    toolId: "lighter.account.get",
    publicName: "lighter__account_get",
    namespace: "lighter",
    lifecycle: "active",
    description:
      `Read public Lighter account state on Core or Robinhood Chain by account index or the owning L1 walletAddress. Use when the user asks for public account balances, collateral, account status, assets, or account rows before deeper order/trade reads. Returns at most ${LIGHTER_AGENT_ACCOUNT_ROW_MAX} account rows and ${LIGHTER_AGENT_ACCOUNT_POSITION_MAX} inline positions/assets per account. Public read: no credential, wallet, signer, order placement, cancellation, deposit, or withdrawal support.`,
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, ACCOUNT_INDEX_PARAM, WALLET_ADDRESS_PARAM, ACTIVE_ONLY_PARAM],
    atMostOne: [["accountIndex", "walletAddress"]],
    atLeastOneOf: [["accountIndex", "walletAddress"]],
    exampleParams: { environment: "rhc", accountIndex: 42 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.account.get"],
  },
  {
    toolId: "lighter.positions",
    publicName: "lighter__positions_list",
    namespace: "lighter",
    lifecycle: "active",
    description:
      `Read positions exposed through Lighter's public account endpoint on Core or Robinhood Chain by account index or the owning L1 walletAddress. Use when the user asks for public account positions, exposure, or holdings visible in Lighter account data. Returns bounded account rows and at most ${LIGHTER_AGENT_ACCOUNT_POSITION_MAX} positions per account. Public read: no credential, wallet, signer, order placement, cancellation, deposit, or withdrawal support.`,
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, ACCOUNT_INDEX_PARAM, WALLET_ADDRESS_PARAM, ACTIVE_ONLY_PARAM],
    atMostOne: [["accountIndex", "walletAddress"]],
    atLeastOneOf: [["accountIndex", "walletAddress"]],
    exampleParams: { environment: "rhc", accountIndex: 42 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.positions"],
  },
  {
    toolId: "lighter.openOrders",
    publicName: "lighter__open_orders_list",
    namespace: "lighter",
    lifecycle: "active",
    description:
      `Read authenticated open Lighter orders using short-lived read-only authorization derived locally from the saved Core or Robinhood Chain trading credential. Use when the user asks for their active/resting orders, open bids/asks, or order exposure. Defaults to the saved credential's account when accountIndex is omitted and refuses account mismatches. Returns exact provider string order identifiers for future safety. Read-only: no signing, order placement, cancellation, deposit, or withdrawal support.`,
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, AUTH_ACCOUNT_INDEX_PARAM, MARKET_ID_OPTIONAL_PARAM, MARKET_FILTER_PARAM, ACCOUNT_ORDER_LIMIT_PARAM],
    exampleParams: { environment: "rhc", marketId: 0, limit: 25 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.openOrders"],
  },
  {
    toolId: "lighter.orderHistory",
    publicName: "lighter__order_history_list",
    namespace: "lighter",
    lifecycle: "active",
    description:
      `Read authenticated inactive Lighter order history using short-lived read-only authorization derived locally from the saved Core or Robinhood Chain trading credential. Use when the user asks for filled, cancelled, inactive, or historical orders. Defaults to the saved credential's account when accountIndex is omitted and refuses account mismatches. Returns exact provider string order identifiers. Read-only: no signing, order placement, cancellation, deposit, or withdrawal support.`,
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, AUTH_ACCOUNT_INDEX_PARAM, MARKET_ID_OPTIONAL_PARAM, MARKET_FILTER_PARAM, ACCOUNT_ORDER_LIMIT_PARAM],
    exampleParams: { environment: "rhc", limit: 25 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.orderHistory"],
  },
  {
    toolId: "lighter.trades",
    publicName: "lighter__trades_list",
    namespace: "lighter",
    lifecycle: "active",
    description:
      `Read authenticated Lighter account trade history using short-lived read-only authorization derived locally from the saved Core or Robinhood Chain trading credential. Use when the user asks for their fills, personal account trades, or executed trades rather than public market tape. Defaults to the saved credential's account when accountIndex is omitted and refuses account mismatches. Returns exact provider string trade and order ids. Read-only: no signing, order placement, cancellation, deposit, or withdrawal support.`,
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, AUTH_ACCOUNT_INDEX_PARAM, ACCOUNT_ORDER_LIMIT_PARAM],
    exampleParams: { environment: "rhc", limit: 25 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.trades"],
  },
  {
    toolId: "lighter.apiKeys.inspect",
    publicName: "lighter__api_keys_inspect",
    namespace: "lighter",
    lifecycle: "active",
    description:
      `Read public Lighter API-key metadata for an account on Core or Robinhood Chain. Use when checking which API-key slots exist on an account, their registered public keys, or current nonce values needed for nonce planning. Requires accountIndex and optionally apiKeyIndex. Returns bounded API-key rows with account index, api key index, public key, nonce, and transaction time. Public read: no credential, API private key, wallet, signer, auth-token minting, order placement, cancellation, deposit, or withdrawal support.`,
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, REQUIRED_ACCOUNT_INDEX_PARAM, API_KEY_INSPECT_INDEX_PARAM, API_KEY_LIMIT_PARAM],
    exampleParams: { environment: "rhc", accountIndex: 1, apiKeyIndex: 255, limit: 25 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.apiKeys.inspect"],
  },
  {
    toolId: "lighter.order.preview",
    publicName: "lighter__order_preview",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Create a live-data-backed Lighter order preview for an ordinary IOC market order or one standalone reduce-only perpetual stop-loss/take-profit order. Prefer marketSymbol over marketId when the user names an asset and include marketType whenever stated; Vex refuses a product mismatch instead of silently switching markets. Protective orders require an explicit triggerPrice, hard execution-price bound, reduceOnly=true, and a side that reduces the live position; if any required value is missing, ask instead of guessing. For paired stop-loss plus take-profit protection use lighter__position_protect. Combined entry-plus-protection, OTO, and OTOCO remain unavailable, so never silently preview only part of such a request. Returns the exact persisted preview and, when managed trading is ready, one approval card. Previewing never signs or submits anything.",
    mutating: false,
    actionKind: "read",
    params: [
      ENVIRONMENT_PARAM,
      AUTH_ACCOUNT_INDEX_PARAM,
      API_KEY_INDEX_PARAM,
      MARKET_ID_OPTIONAL_PARAM,
      MARKET_SYMBOL_PARAM,
      ORDER_PREVIEW_MARKET_TYPE_PARAM,
      ORDER_SIDE_PARAM,
      BASE_AMOUNT_PARAM,
      ORDER_PRICE_PARAM,
      TRIGGER_PRICE_PARAM,
      ORDER_TYPE_PARAM,
      TIME_IN_FORCE_PARAM,
      REDUCE_ONLY_PARAM,
      ORDER_EXPIRY_PARAM,
      ORDER_EXPIRY_OFFSET_MINUTES_PARAM,
    ],
    atMostOne: [["marketId", "marketSymbol"], ["orderExpiry", "orderExpiryOffsetMinutes"]],
    atLeastOneOf: [["marketId", "marketSymbol"], ["orderExpiry", "orderExpiryOffsetMinutes"]],
    exampleParams: {
      environment: "core",
      marketSymbol: "ETH/USDC",
      marketType: "spot",
      side: "buy",
      baseAmountIn: "0.005",
      price: "3000",
      orderType: "market",
      timeInForce: "immediate-or-cancel",
      orderExpiryOffsetMinutes: 30,
    },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.preview"],
  },
  {
    toolId: "lighter.position.protect",
    publicName: "lighter__position_protect",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Preview and prepare one native Lighter one-cancels-the-other group that protects an existing perpetual position with exactly two same-size reduce-only children: one stop-loss and one take-profit. Requires explicit trigger and hard execution-bound prices for both legs, exact side, size, and expiry. Vex verifies the live position, persists both child identities, and shows one approval card. After approval it submits one native grouped transaction and calls protection active only when both exact children are proven from authenticated account evidence. It never emulates sibling cancellation, creates an entry order, automatically retries uncertainty, or supports OTO/OTOCO here.",
    mutating: false,
    actionKind: "read",
    params: [
      ENVIRONMENT_PARAM,
      AUTH_ACCOUNT_INDEX_PARAM,
      API_KEY_INDEX_PARAM,
      MARKET_ID_OPTIONAL_PARAM,
      MARKET_SYMBOL_PARAM,
      ORDER_SIDE_PARAM,
      BASE_AMOUNT_PARAM,
      { key: "stopLossTriggerPrice", type: "string", required: true, description: "Exact human-decimal stop-loss trigger price. Vex never guesses it." },
      { key: "stopLossPrice", type: "string", required: true, description: "Exact human-decimal worst execution-price bound after the stop-loss triggers." },
      { key: "takeProfitTriggerPrice", type: "string", required: true, description: "Exact human-decimal take-profit trigger price. Vex never guesses it." },
      { key: "takeProfitPrice", type: "string", required: true, description: "Exact human-decimal worst execution-price bound after the take-profit triggers." },
      ORDER_EXPIRY_PARAM,
      ORDER_EXPIRY_OFFSET_MINUTES_PARAM,
    ],
    atMostOne: [["marketId", "marketSymbol"], ["orderExpiry", "orderExpiryOffsetMinutes"]],
    atLeastOneOf: [["marketId", "marketSymbol"], ["orderExpiry", "orderExpiryOffsetMinutes"]],
    exampleParams: {
      environment: "rhc",
      marketSymbol: "ETH",
      side: "sell",
      baseAmountIn: "0.1",
      stopLossTriggerPrice: "2900",
      stopLossPrice: "2850",
      takeProfitTriggerPrice: "3300",
      takeProfitPrice: "3250",
      orderExpiryOffsetMinutes: 1440,
    },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.position.protect"],
  },
  {
    toolId: "lighter.deposit.status",
    publicName: "lighter__deposit_status",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Check and reconcile the durable state of this Vex wallet's Lighter deposit intents. Use after an approval, a pending or ambiguous Ethereum outcome, or when a second deposit is refused because an earlier intent is unresolved. Repair reads only already-staged Ethereum transaction identities, accepts only provider-proven same-calldata fee repricings within the original approval ceiling, rechecks canonical Ethereum receipts, and requires exact Lighter credit plus wallet ownership evidence; it never infers credit from generic account existence. Returns approval and execution state, original and replacement transaction identities, exact L1/Lighter evidence, repair reports, and explicit next-action guidance. An optional intent id checks one local intent; omitting it checks this wallet's unresolved deposit intents. This tool never signs, broadcasts, retries, or creates a replacement transaction and moves no funds.",
    mutating: false,
    actionKind: "read",
    params: [
      ENVIRONMENT_PARAM,
      {
        key: "intentId",
        type: "string",
        description:
          "Optional Lighter deposit intent id returned by lighter__deposit_prepare. Omit to list every unresolved deposit intent for the selected Vex wallet and environment.",
      },
    ],
    exampleParams: { environment: "core" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.deposit.status"],
  },
  {
    toolId: "lighter.withdraw.status",
    publicName: "lighter__withdraw_status",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Reconcile one durable Core USDC or RHC USDG withdrawal from exact evidence. Use when a submitted withdrawal is pending, claimable, completed, ambiguous, or needs final-delivery proof. It reads the environment-specific TxType 13 transaction, authenticated paginated history, current gateway pending balance, and any canonical destination receipt and block. It adopts only one exact amount/time/history identity and marks delivery only after a matching gateway event, exact token transfer to the owner, canonical block membership, zero pending balance, and 12 confirmations. Returns durable execution, approval, history, claim, destination, confirmation, and next-action fields. Missing or contradictory evidence never triggers a retry; omit intentId to recover the latest withdrawal for the selected wallet, including one created in an earlier session.",
    mutating: false,
    actionKind: "read",
    params: [{
      key: "intentId",
      type: "string",
      description: "Optional Core or RHC withdrawal intent id from lighter__withdraw_prepare or lighter__withdraw. Exact ids may be recovered from an earlier session only when they belong to the selected wallet.",
    }],
    exampleParams: {},
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.withdraw.status"],
  },
  {
    toolId: "lighter.key.register.status",
    publicName: "lighter__key_register_status",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Check and reconcile one already-staged Lighter Core or Robinhood Chain key registration from exact provider and local vault evidence. Use after the approved registration returns submitted_pending_verification, ambiguity_unresolved, registered_key_conflict, or key_verified_pending_nonce. It reads the exact environment-specific public API-key slot, verifies that it equals the vault-derived public key, runs the official CheckClient equivalent against that environment, and requires the next nonce to equal the approved nonce plus one before promoting the local encrypted credential to active. This evidence-only path structurally refuses intents that have not staged a TxType 8 transaction and never signs, calls sendTx, retries, deposits, trades, transfers, or withdraws.",
    mutating: false,
    actionKind: "read",
    params: [{
      key: "intentId",
      type: "string",
      required: true,
      description:
        "Session-scoped Lighter key-registration intent id returned by lighter__key_register_prepare or the approved registration result.",
    }],
    exampleParams: { intentId: "lighter-onboard-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.key.register.status"],
  },
  {
    toolId: "lighter.order.status",
    publicName: "lighter__order_status",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Check and reconcile the true state of Vex-submitted Lighter create orders and lifecycle actions (cancel one, modify, cancel all, and reduce-only close). Use when an action ended sequencer_pending or ambiguous, the user asks what happened, or a new action is blocked by an unresolved nonce reservation. Reads live nextNonce plus exact account order, trade, and position evidence, then updates durable records without signing or retrying. Returns each checked durable intent with its proven execution state and provider evidence; close results include executed amount, remaining order amount, average fill price, provider status, and resulting position when proven. A stuck nonce is released only when the signed transaction provably never left Vex or expired while its nonce remained unconsumed; a consumed nonce is unblocked without guessing the final action outcome. It never signs, submits, retries, cancels, modifies, or moves funds.",
    mutating: false,
    actionKind: "read",
    params: [
      ENVIRONMENT_PARAM,
      {
        key: "intentId",
        type: "string",
        description:
          "Optional Lighter create-order or lifecycle intent id to check, from a prepare tool or earlier status report. Omit for a bounded check of unresolved local intents in the environment.",
      },
    ],
    exampleParams: { environment: "rhc" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.status"],
  },
  {
    toolId: "lighter.orderbook",
    publicName: "lighter__orderbook_get",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Read public resting order book orders for one Lighter market on Core or Robinhood Chain. Use when the user asks for current bids, asks, spread context, or visible liquidity around a known market id before making a market decision. Returns bounded ask and bid rows with order id, owner account index, price, initial size, remaining size, raw epoch-millisecond expiry, ISO expiry, provider totals, and truncation flags. Prefer the ISO expiry for user-facing output. Read-only: this does not place, cancel, sign, fill, deposit, or withdraw.",
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, MARKET_ID_REQUIRED_PARAM, ORDERBOOK_LIMIT_PARAM],
    exampleParams: { environment: "rhc", marketId: 0, limit: 25 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.orderbook"],
  },
  {
    toolId: "lighter.recentTrades",
    publicName: "lighter__recent_trades_list",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Read the recent public trade tape for one Lighter market on Core or Robinhood Chain. Use when the user asks for latest fills, trade prices, sizes, maker side, USD amount, block height, transaction hash, or short-term activity before comparing with depth or candles. Returns bounded trade rows plus provider row count, truncation state, and next cursor when Lighter supplies one. Read-only: no private account data, signing, order placement, deposit, or withdrawal support.",
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, MARKET_ID_REQUIRED_PARAM, TRADES_LIMIT_PARAM],
    exampleParams: { environment: "rhc", marketId: 0, limit: 25 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.recentTrades"],
  },
  {
    toolId: "lighter.candles",
    publicName: "lighter__candles_list",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Read public OHLCV candles for one Lighter market on Core or Robinhood Chain using epoch-millisecond start/end timestamps. Use when the user asks for chart history, recent price movement, volatility, or candle data after choosing a market id. Returns provider rows bounded by countBack and the newest projected rows, plus provider row count, requested window, resolution, countBack, and truncation disclosure. Read-only: no account lookup, signing, order, deposit, or withdrawal path.",
    mutating: false,
    actionKind: "read",
    params: [
      ENVIRONMENT_PARAM,
      MARKET_ID_REQUIRED_PARAM,
      {
        key: "resolution",
        type: "string",
        required: true,
        enum: LIGHTER_CANDLE_RESOLUTIONS,
        description:
          "Candle bucket size accepted by Lighter: 1m, 5m, 15m, 30m, 1h, 4h, 12h, 1d, or 1w. Unsupported values are rejected.",
      },
      {
        key: "startTimestamp",
        type: "number",
        required: true,
        description:
          "Window start as a JavaScript epoch-milliseconds integer. Seconds-scale Unix timestamps are rejected before any provider request.",
      },
      {
        key: "endTimestamp",
        type: "number",
        required: true,
        description:
          "Window end as a JavaScript epoch-milliseconds integer. It must be greater than startTimestamp or the call is rejected.",
      },
      {
        key: "countBack",
        type: "number",
        description:
          "Provider candle row cap for the requested range (max 500). Vex also shows at most "
          + `${LIGHTER_AGENT_CANDLE_OUTPUT_MAX} newest rows in the agent response.`,
      },
      {
        key: "setTimestampToEnd",
        type: "boolean",
        description:
          "Optional Lighter candle flag controlling whether returned timestamps point at the candle end instead of its start.",
      },
    ],
    exampleParams: {
      environment: "rhc",
      marketId: 0,
      resolution: "1h",
      startTimestamp: 1786147200000,
      endTimestamp: 1786233600000,
      countBack: 24,
    },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.candles"],
  },
];
