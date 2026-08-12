import type { ProtocolParamDef, ProtocolToolManifest } from "../../types.js";
import { LIGHTER_ENVIRONMENTS } from "@tools/lighter/constants.js";
import { LIGHTER_MARKET_DATA_DISCOVERY } from "../../embeddings/lighter/market-data.js";

const ENVIRONMENT_PARAM: ProtocolParamDef = {
  key: "environment",
  type: "string",
  required: true,
  enum: LIGHTER_ENVIRONMENTS,
  description:
    "REQUIRED. Lighter environment for the persisted preview: core for Lighter Core, rhc for Robinhood Chain. Any other value is rejected.",
};

const PREVIEW_ID_PARAM: ProtocolParamDef = {
  key: "previewId",
  type: "string",
  required: true,
  description:
    "Session-scoped Lighter order preview id returned by lighter.order.preview. It must still be fresh and must belong to this session and environment.",
};

const VAULT_CREDENTIAL_ID_PARAM: ProtocolParamDef = {
  key: "vaultCredentialId",
  type: "string",
  required: true,
  description:
    "Opaque encrypted local vault reference for the Lighter trading API private key. Do not pass raw key bytes, read-only tokens, signatures, or provider payloads.",
};

const INTENT_ID_PARAM: ProtocolParamDef = {
  key: "intentId",
  type: "string",
  required: true,
  description:
    "Session-scoped Lighter order execution intent id produced by lighter.order.create.prepare. The approved create path refuses ids from other sessions.",
};

export const LIGHTER_WRITE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "lighter.order.create.prepare",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Prepare an approval-gated Lighter order create from a fresh persisted lighter.order.preview and an opaque encrypted-vault trading credential reference. Creates a local durable execution intent and asks the engine to enqueue the approval card for lighter.order.create. This is a preparation step only: no signer, API private key read, signature, sendTx, order placement, cancellation, deposit, withdrawal, or transfer path.",
    mutating: false,
    actionKind: "approval_prepare",
    params: [ENVIRONMENT_PARAM, PREVIEW_ID_PARAM, VAULT_CREDENTIAL_ID_PARAM],
    exampleParams: {
      environment: "rhc",
      previewId: "lighter-preview-example",
      vaultCredentialId: "lighter/rhc/account-42/api-key-7",
    },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.create.prepare"],
  },
  {
    toolId: "lighter.order.create",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Approval-gated Lighter order create resume target for a prepared execution intent. In restricted mode this tool is enqueued for approval by lighter.order.create.prepare. The current implementation records the approval decision and refuses before signer or provider submission until the privileged signer adapter is built. No direct call should be made without a prepared intent and approval-resume context.",
    mutating: true,
    actionKind: "external_post",
    params: [INTENT_ID_PARAM],
    exampleParams: { intentId: "lighter-exec-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.create"],
  },
];
