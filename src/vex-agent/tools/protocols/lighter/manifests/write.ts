import type { ProtocolParamDef, ProtocolToolManifest } from "../../types.js";
import { LIGHTER_DEFAULT_ENVIRONMENT, LIGHTER_ENVIRONMENTS } from "@tools/lighter/constants.js";
import { LIGHTER_MARKET_DATA_DISCOVERY } from "../../embeddings/lighter/market-data.js";

const ENVIRONMENT_PARAM: ProtocolParamDef = {
  key: "environment",
  type: "string",
  enum: LIGHTER_ENVIRONMENTS,
  description:
    `Optional Lighter environment for the persisted preview: core for Lighter Core, rhc for Robinhood Chain. Defaults to ${LIGHTER_DEFAULT_ENVIRONMENT}. Any other value is rejected.`,
};

const PREVIEW_ID_PARAM: ProtocolParamDef = {
  key: "previewId",
  type: "string",
  description:
    "Optional session-scoped Lighter order preview id returned by lighter.order.preview. Omit for normal 'prepare that order' requests; Vex uses the latest fresh preview in this session and environment.",
};

const INTENT_ID_PARAM: ProtocolParamDef = {
  key: "intentId",
  type: "string",
  required: true,
  description:
    "Session-scoped Lighter order execution intent id produced by lighter.order.create.prepare. The approved create path refuses ids from other sessions.",
};

const LIFECYCLE_INTENT_ID_PARAM: ProtocolParamDef = {
  key: "intentId",
  type: "string",
  required: true,
  description: "Session-scoped exact Lighter order lifecycle intent produced by the matching prepare tool.",
};

const LIFECYCLE_ACCOUNT_PARAM: ProtocolParamDef = {
  key: "accountIndex",
  type: "number",
  description: "Optional saved Lighter account index. Omit when exactly one managed account exists in the selected environment.",
};

const LIFECYCLE_MARKET_PARAM: ProtocolParamDef = {
  key: "marketId",
  type: "number",
  required: true,
  description: "Exact Lighter market index of the active provider order.",
};

const PROVIDER_ORDER_ID_PARAM: ProtocolParamDef = {
  key: "orderId",
  type: "string",
  required: true,
  description: "Exact decimal provider order_id string from authenticated Lighter open orders. It is never converted to a JavaScript number.",
};

const MODIFY_TOTAL_BASE_AMOUNT_PARAM: ProtocolParamDef = {
  key: "totalBaseAmount",
  type: "string",
  required: true,
  description: "Replacement total order size in human market units. This is the new total size, not the remaining size, and cannot be below the amount already filled.",
};

const MODIFY_PRICE_PARAM: ProtocolParamDef = {
  key: "price",
  type: "string",
  required: true,
  description: "Replacement limit price in human market units, converted exactly using current Lighter market precision.",
};

const MAX_SLIPPAGE_BPS_PARAM: ProtocolParamDef = {
  key: "maxSlippageBps",
  type: "number",
  required: true,
  description: "Explicit maximum slippage in basis points from 1 through 500. Vex refuses the close unless visible live depth can fill the entire position inside this bound.",
};

const DEPOSIT_AMOUNT_PARAM: ProtocolParamDef = {
  key: "amountIn",
  type: "string",
  required: true,
  description:
    'Settlement amount to deposit in human decimals: USDC on Core or USDG on Robinhood Chain (both use 6 decimals), for example "11". Minimum 1 settlement token; a smaller deposit is not credited.',
};

const DEPOSIT_INTENT_ID_PARAM: ProtocolParamDef = {
  key: "intentId",
  type: "string",
  required: true,
  description:
    "Session-scoped Lighter deposit intent id produced by lighter.deposit.prepare. The approved deposit path refuses ids from other sessions.",
};

const KEY_REGISTRATION_INTENT_ID_PARAM: ProtocolParamDef = {
  key: "intentId",
  type: "string",
  required: true,
  description:
    "Session-scoped Lighter key-registration intent id produced by lighter.key.register.prepare.",
};

const WITHDRAW_AMOUNT_PARAM: ProtocolParamDef = {
  key: "amountIn",
  type: "string",
  required: true,
  description:
    'Exact stablecoin amount to withdraw in human decimals, for example "2": USDC for environment=core or USDG for environment=rhc. Vex proves the environment-specific live minimum, collateral safety, owner destination, delay, and settlement gateway before approval.',
};

const WITHDRAW_INTENT_ID_PARAM: ProtocolParamDef = {
  key: "intentId",
  type: "string",
  required: true,
  description: "Session-scoped environment-bound withdrawal intent produced by lighter.withdraw.prepare.",
};

const WITHDRAW_CLAIM_ID_PARAM: ProtocolParamDef = {
  key: "claimId",
  type: "string",
  required: true,
  description: "Session-scoped environment-bound manual settlement claim id produced by lighter.withdraw.claim.prepare.",
};

export const LIGHTER_WRITE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "lighter.order.cancel.prepare",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Prepare a user approval for canceling one exact active Lighter order. Reads authenticated provider state for the selected Core or RHC account, matches the exact string order_id and market, and persists immutable side, price, remaining amount, fills, status, credential scope, and expiry. Returns a trusted approval card; it never loads a private key, reserves a nonce, signs, submits, or treats absence as cancellation.",
    mutating: false,
    actionKind: "approval_prepare",
    params: [ENVIRONMENT_PARAM, LIFECYCLE_ACCOUNT_PARAM, LIFECYCLE_MARKET_PARAM, PROVIDER_ORDER_ID_PARAM],
    exampleParams: { environment: "rhc", marketId: 0, orderId: "123456789" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.cancel.prepare"],
  },
  {
    toolId: "lighter.order.cancel",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Execute one exact approved Lighter order cancellation. Direct calls are refused. After approval, the privileged runtime revalidates the unchanged active order, registered key, and nonce; atomically reserves the nonce; signs TxType 15 locally; persists transaction identity before one sendTx; and never retries ambiguity. It reports canceled only from exact provider inactive-order evidence and includes executed, remaining, and average-fill amounts.",
    mutating: true,
    actionKind: "external_post",
    params: [LIFECYCLE_INTENT_ID_PARAM],
    exampleParams: { intentId: "lighter-lifecycle-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.cancel"],
  },
  {
    toolId: "lighter.order.modify.prepare",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Prepare a user approval for modifying one exact active Lighter limit order. Reads live market precision and authenticated order state, preserves the exact provider order_id string, treats totalBaseAmount as the replacement total size, refuses amounts below already-filled size, and binds old and requested values into a durable approval. It never loads a private key, reserves a nonce, signs, or submits.",
    mutating: false,
    actionKind: "approval_prepare",
    params: [ENVIRONMENT_PARAM, LIFECYCLE_ACCOUNT_PARAM, LIFECYCLE_MARKET_PARAM, PROVIDER_ORDER_ID_PARAM, MODIFY_TOTAL_BASE_AMOUNT_PARAM, MODIFY_PRICE_PARAM],
    exampleParams: { environment: "rhc", marketId: 0, orderId: "123456789", totalBaseAmount: "0.01", price: "2500" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.modify.prepare"],
  },
  {
    toolId: "lighter.order.modify",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Execute one exact approved Lighter limit-order modification. Direct calls are refused. The privileged runtime revalidates the unchanged order, active market precision, registered key, and nonce; atomically reserves the nonce; signs TxType 17 locally; stages identity before one sendTx; and never retries ambiguity. It reports completion only from exact provider evidence carrying the requested total size and price, including terminal fill outcomes.",
    mutating: true,
    actionKind: "external_post",
    params: [LIFECYCLE_INTENT_ID_PARAM],
    exampleParams: { intentId: "lighter-lifecycle-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.modify"],
  },
  {
    toolId: "lighter.order.cancelAll.prepare",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Prepare one explicit approval to immediately cancel every active order in a saved Lighter account across all markets. It reads the complete authenticated active-order set, preserves every exact string order identity and immutable order fact, refuses empty or unprovably large sets, and binds immediate account-wide TxType 16 semantics. It never loads a private key, reserves a nonce, signs, or submits.",
    mutating: false,
    actionKind: "approval_prepare",
    params: [ENVIRONMENT_PARAM, LIFECYCLE_ACCOUNT_PARAM],
    exampleParams: { environment: "rhc" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.cancelAll.prepare"],
  },
  {
    toolId: "lighter.order.cancelAll",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Execute one exact approved immediate account-wide Lighter cancellation. Direct calls are refused. The privileged runtime requires the entire active-order set to remain unchanged, revalidates key and nonce, reserves the nonce atomically, signs TxType 16 with time_in_force 0 and time 0, stages identity before one submission, and never retries ambiguity. Completion requires zero active orders plus exact terminal evidence for every approved order, with fills reported separately.",
    mutating: true,
    actionKind: "external_post",
    params: [LIFECYCLE_INTENT_ID_PARAM],
    exampleParams: { intentId: "lighter-lifecycle-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.cancelAll"],
  },
  {
    toolId: "lighter.position.close.prepare",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Prepare one explicit approval to close the entire current position in one active Lighter perpetual market. It reads the exact live account position, market precision, and up to 100 order-book levels; requires a user-specified slippage ceiling; refuses insufficient visible depth; and binds a full-size reduce-only market IOC order with a worst acceptable price. It never loads a private key, reserves a nonce, signs, or submits.",
    mutating: false,
    actionKind: "approval_prepare",
    params: [ENVIRONMENT_PARAM, LIFECYCLE_ACCOUNT_PARAM, LIFECYCLE_MARKET_PARAM, MAX_SLIPPAGE_BPS_PARAM],
    exampleParams: { environment: "rhc", marketId: 0, maxSlippageBps: 100 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.position.close.prepare"],
  },
  {
    toolId: "lighter.position.close",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Execute one exact approved full-position close using a reduce-only Lighter market IOC order. Direct calls are refused. The privileged runtime revalidates the unchanged position, market precision, full visible depth at the approved worst price, registered key, and nonce; signs TxType 14 locally; stages identity before one submission; and never retries ambiguity. It reports exact fill and resulting position, including partial closes without automatic resubmission.",
    mutating: true,
    actionKind: "external_post",
    params: [LIFECYCLE_INTENT_ID_PARAM],
    exampleParams: { intentId: "lighter-lifecycle-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.position.close"],
  },
  {
    toolId: "lighter.withdraw.claim.prepare",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Prepare a separate settlement-wallet approval for one exact claimable Core USDC or RHC USDG withdrawal. Use when reconciliation reports that exact withdrawal as claimable. It requires the selected wallet to equal the fixed owner, exact pending amount, reviewed environment-specific gateway implementation/code and enabled asset-3 token mapping, successful zero-value call simulation, fresh fees, and enough ETH for the disclosed hard fee ceiling. Returns a durable claim id, amount, settlement network, fee ceiling, expiry, and separate host approval card. It never signs or broadcasts.",
    mutating: false,
    actionKind: "approval_prepare",
    params: [WITHDRAW_INTENT_ID_PARAM],
    exampleParams: { intentId: "lighter-withdrawal-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.withdraw.claim.prepare"],
  },
  {
    toolId: "lighter.withdraw.claim",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Execute one exact separately approved Lighter manual settlement claim for Core USDC or RHC USDG. Use when the trusted host approval from lighter.withdraw.claim.prepare resumes. It refuses direct, cross-session, stale, changed-amount, changed-contract, insufficient-ETH, or over-ceiling execution. The local wallet signs only the fixed-owner asset-3 claim with value zero; Vex persists hash, sender, and nonce before one broadcast, accepts only exact fee-only replacements, and never retries ambiguity. Returns the claim id, transaction hash, confirming or ambiguous state, receipt status when known, and reconciliation guidance. Real funds move only to the fixed owner after approval.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [WITHDRAW_CLAIM_ID_PARAM],
    exampleParams: { claimId: "lighter-withdrawal-claim-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.withdraw.claim"],
  },
  {
    toolId: "lighter.withdraw.prepare",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Prepare one exact approval-gated secure withdrawal from the selected wallet's uniquely owned Lighter account: Core USDC to the same wallet on Ethereum mainnet, or RHC USDG to the same wallet on Robinhood Chain mainnet. Use when the user asks to withdraw or cash out Lighter collateral. The environment is mandatory and cannot be inferred from the address. It uses only the matching saved local credential and refuses destination, route, chain, nonce, ownership, margin, gateway, or unresolved-state ambiguity. Returns a durable intent id, exact amount and destination, settlement network, withdrawal delay, expiry, and trusted approval card. It never signs or submits.",
    mutating: false,
    actionKind: "approval_prepare",
    params: [ENVIRONMENT_PARAM, WITHDRAW_AMOUNT_PARAM],
    exampleParams: { environment: "rhc", amountIn: "2" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.withdraw.prepare"],
  },
  {
    toolId: "lighter.withdraw",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Execute one exact prepared Core-USDC or RHC-USDG secure withdrawal. Use when the trusted approval from lighter.withdraw.prepare resumes; direct calls, crossed environments, and mismatched approvals are refused. Vex reruns environment-specific live preflight, matches the encrypted local credential to its registered public key, reserves the shared nonce, signs only TxType 13 asset 3 route 0 in the reviewed domain, persists structural identity before one provider submission, and never blindly retries ambiguity. Returns the durable intent id, signer and submitted hashes, provider acceptance details or an ambiguous state, and reconciliation guidance. Real funds move only after approval; API acceptance is not final delivery.",
    mutating: true,
    actionKind: "external_post",
    params: [WITHDRAW_INTENT_ID_PARAM],
    exampleParams: { intentId: "lighter-withdrawal-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.withdraw"],
  },
  {
    toolId: "lighter.key.register.prepare",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Internal continuation for managed Lighter onboarding after the selected wallet's funded Core or Robinhood Chain account is resolved. Use when onboarding status shows that secure local trading access is the remaining leg. Prepare a separate security-sensitive approval for a locally generated trading credential in the selected environment. Resolve the wallet-owned account automatically, read every public slot, reserve an unused index from 4 through 254, generate the key only through the privileged packaged signer helper, encrypt it locally, and bind the exact authority and chain domains into the trusted approval card. Never ask a normal user for an account index, API-key index, nonce, fingerprint, private key, or dashboard API key; describe this as finishing secure trading setup. Returns the durable intent, trusted disclosure, expiry, approval status, and host approval-card guidance. No wallet signature, L2ChangePubKey transaction, sendTx, deposit, order, transfer, or withdrawal runs during preparation.",
    mutating: false,
    actionKind: "approval_prepare",
    params: [ENVIRONMENT_PARAM],
    exampleParams: { environment: "core" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.key.register.prepare"],
  },
  {
    toolId: "lighter.key.register",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Approval-resume target for one exact prepared Lighter key registration. Direct calls without the matching host approval are refused. Electron main revalidates exact wallet ownership, slot vacancy, nonce, vault-derived public key, and workflow state; signs Lighter's human-readable EIP-191 ownership message locally; persists TxType 8 structural identity before sendTx; and never returns or stores signatures or the signed payload. It activates the encrypted trading credential only after exact live public-key match, official CheckClient success, and nonce +1 synchronization. Ambiguous outcomes are reconciliation-only and are never blindly resubmitted.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [KEY_REGISTRATION_INTENT_ID_PARAM],
    exampleParams: { intentId: "lighter-onboard-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.key.register"],
  },
  {
    toolId: "lighter.deposit.prepare",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Prepare an exact approval-gated Lighter perps deposit from the selected Vex wallet: Ethereum USDC for Core or Robinhood Chain USDG for RHC. Use only after managed onboarding proves the direct settlement balance covers the exact shortfall. The host approval card is the consent surface. Preparation persists live balances, allowance, native ETH fee readiness, environment/chain/contracts, reviewed proxy identities, exact beneficiary, calldata, and zero transaction value. It owns no signer and moves no funds. Returns the durable intent id, exact reviewed deposit details, approval status, expiry, and host approval-card guidance. Only the matching approved resume may resolve the local wallet key and execute it.",
    mutating: false,
    actionKind: "approval_prepare",
    params: [ENVIRONMENT_PARAM, DEPOSIT_AMOUNT_PARAM],
    exampleParams: { environment: "rhc", amountIn: "11" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.deposit.prepare"],
  },
  {
    toolId: "lighter.deposit",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Approval-gated Lighter deposit resume target for one exact prepared intent. Call only through the matching host approval card; direct or cross-session calls are refused. After a fresh exact preflight, the privileged local wallet path may approve the environment-specific gateway and deposit Ethereum USDC for Core or Robinhood Chain USDG for RHC, so real funds move on-chain and network fees are spent. Transaction hashes are durably recorded before broadcast, ambiguous sends are reconciliation-only, and any replacement is fee-only with identical calldata, destination, value, and nonce. Returns the durable execution state and exact settlement evidence; credit is final only after the matching on-chain receipt, Deposit event, Lighter type-1 status-3 transaction, and wallet-owned account balance are all verified.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [DEPOSIT_INTENT_ID_PARAM],
    exampleParams: { intentId: "lighter-onboard-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.deposit"],
  },
  {
    toolId: "lighter.order.create.prepare",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Prepare an approval-gated Lighter order create from a fresh persisted lighter.order.preview. Use this directly when the user says to prepare that Lighter order for approval after previewing it; no user-facing vault id or preview id is required for the normal latest-preview flow. Creates a local durable execution intent and asks the engine to enqueue the approval card for lighter.order.create. Returns the intent id, preview identity, approval status, expiry, and user guidance pointing at the approval card. This is a preparation step only: no signer, API private key read, signature, sendTx, order placement, cancellation, deposit, withdrawal, or transfer path.",
    mutating: false,
    actionKind: "approval_prepare",
    params: [ENVIRONMENT_PARAM, PREVIEW_ID_PARAM],
    exampleParams: {
      environment: "rhc",
    },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.create.prepare"],
  },
  {
    toolId: "lighter.order.create",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Approval-gated Lighter order create resume target for a prepared execution intent. Call this only through the approval card that lighter.order.create.prepare enqueues; no direct call should be made without a prepared intent and approval-resume context. An approved call signs the exact prepared order with the local trading key and submits it to Lighter, so real funds move on the exchange. Returns the recorded approval decision plus the execution state: sequencer_pending, provider-confirmed order state, or an ambiguous outcome that must be reconciled before any retry.",
    mutating: true,
    actionKind: "external_post",
    params: [INTENT_ID_PARAM],
    exampleParams: { intentId: "lighter-exec-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.create"],
  },
];
