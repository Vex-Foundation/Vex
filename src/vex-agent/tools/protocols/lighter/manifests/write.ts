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

const CORE_WITHDRAW_AMOUNT_PARAM: ProtocolParamDef = {
  key: "amountIn",
  type: "string",
  required: true,
  description:
    'Exact Lighter Core USDC amount to withdraw in human decimals, for example "2". Core secure withdrawal only; Vex proves the live minimum, available collateral, margin safety, owner destination, withdrawal delay, and Ethereum gateway identity before approval.',
};

const CORE_WITHDRAW_INTENT_ID_PARAM: ProtocolParamDef = {
  key: "intentId",
  type: "string",
  required: true,
  description: "Session-scoped Core withdrawal intent produced by lighter.withdraw.prepare.",
};

export const LIGHTER_WRITE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "lighter.withdraw.prepare",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Prepare one exact approval-gated secure USDC withdrawal from the selected wallet's uniquely owned Lighter Core account to that same wallet on Ethereum mainnet. Uses only the saved local managed credential scope; never asks for or accepts a private key, API-key index, nonce, destination override, fast route, or alternate chain. Live preflight proves ownership, credential registration, available collateral and margin safety, no unresolved secure withdrawal, current withdrawal delay and minimum, Ethereum chain freshness, reviewed gateway implementation/code, USDC mapping, and zero modern pending balance. Preparation persists a public immutable intent and creates the trusted approval card; it never signs or calls sendTx.",
    mutating: false,
    actionKind: "approval_prepare",
    params: [CORE_WITHDRAW_AMOUNT_PARAM],
    exampleParams: { amountIn: "2" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.withdraw.prepare"],
  },
  {
    toolId: "lighter.withdraw",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Approval-resume target for one exact prepared Lighter Core secure USDC withdrawal. Direct calls and mismatched approvals are refused. After approval, Vex reruns the full live preflight, matches the encrypted local credential to the registered public key, reserves the shared account/API-key nonce atomically, signs only Core TxType 13 asset 3 route 0 with a short expiry in the packaged official signer, persists signed and submission-staged identity before sendTx, and never blindly retries an ambiguous outcome. API acceptance is pending, not final delivery; reconciliation must prove L2 execution and exact Ethereum USDC settlement.",
    mutating: true,
    actionKind: "external_post",
    params: [CORE_WITHDRAW_INTENT_ID_PARAM],
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
