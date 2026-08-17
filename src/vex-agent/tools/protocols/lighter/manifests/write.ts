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
    'USDC amount to deposit in human decimals (USDC has 6 decimals), for example "11". Minimum 1 USDC; a smaller deposit is not credited.',
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

export const LIGHTER_WRITE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "lighter.key.register.prepare",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Prepare a separate security-sensitive approval for registering a locally generated Lighter trading credential on the selected Vex-wallet-owned Core account. Reads every public API-key slot, transactionally reserves an unused index from 4 through 254, generates the key only through the privileged packaged signer helper, encrypts the private key in the local vault before public metadata, reads the exact public next nonce, and binds wallet, account, index, public key, fingerprint, nonce, and granted authority into a trusted approval card. Returns the durable intent id, account and key indexes, nonce, public-key fingerprint, approval disclosure, expiry, and approval-card guidance. No wallet signature, L2ChangePubKey transaction, sendTx, deposit, order, transfer, or withdrawal runs during preparation.",
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
      "Approval-resume target for one exact prepared Lighter key registration. Direct calls without the matching host approval are refused. When the independent privileged key-registration release gate is open, Electron main revalidates exact wallet ownership, slot vacancy, nonce, vault-derived public key, and workflow state; signs Lighter's human-readable EIP-191 ownership message locally; persists TxType 8 structural identity before sendTx; and never returns or stores signatures or the signed payload. It activates the encrypted trading credential only after exact live public-key match, official CheckClient success, and nonce +1 synchronization. Ambiguous outcomes are reconciliation-only and are never blindly resubmitted.",
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
      "Prepare an approval-gated Lighter Core deposit that funds the user's own Lighter account from their Vex wallet's USDC on Ethereum mainnet. Use this when the user wants to fund Lighter, deposit into Lighter, or onboard their wallet to Lighter after checking lighter.account.onboarding.status. The first deposit creates a Lighter account owned by the wallet. Reads and persists live Ethereum chain/block, wallet USDC/ETH balances, allowance, Lighter gateway/USDC metadata, exact approval/deposit gas limits, and EIP-1559 maximum-fee exposure before creating a durable intent. The non-spoofable approval disclosure binds those values plus the exact amount, destination, contract, and deposit-only scope. Returns the durable intent id, exact approval disclosure, approval status and expiry, and guidance for the host approval card. This preparation step owns no signer and moves no funds. Core perps deposits only in this release.",
    mutating: false,
    actionKind: "approval_prepare",
    params: [ENVIRONMENT_PARAM, DEPOSIT_AMOUNT_PARAM],
    exampleParams: { environment: "core", amountIn: "11" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.deposit.prepare"],
  },
  {
    toolId: "lighter.deposit",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Approval-gated Lighter Core deposit resume target for a prepared deposit intent. Call this only through the approval card that lighter.deposit.prepare enqueues; never call it directly without a prepared intent and approval-resume context. When the privileged deposit release gate is open, an approved call signs an ERC-20 approval and the deposit with the Vex wallet key and submits them on Ethereum mainnet, so real funds move toward the user's Lighter account (the first deposit is expected to create the account). A successful Ethereum transaction is reported as l2_pending until exact Lighter credit evidence proves the deposit; account existence alone never proves credit. Returns the recorded approval decision plus the execution outcome: l2_pending, an ambiguous outcome that must be reconciled before any retry, a failed leg, or gate-closed when the release gate is shut.",
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
      "Approval-gated Lighter order create resume target for a prepared execution intent. Call this only through the approval card that lighter.order.create.prepare enqueues; no direct call should be made without a prepared intent and approval-resume context. When the privileged release gate is open, an approved call signs the exact prepared order with the local trading key and submits it to Lighter, so real funds move on the exchange. Returns the recorded approval decision plus the execution state: sequencer_pending, provider-confirmed order state, or an ambiguous outcome that must be reconciled before any retry.",
    mutating: true,
    actionKind: "external_post",
    params: [INTENT_ID_PARAM],
    exampleParams: { intentId: "lighter-exec-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.create"],
  },
];
