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

export const LIGHTER_WRITE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "lighter.order.create.prepare",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Prepare an approval-gated Lighter order create from a fresh persisted lighter.order.preview. Use this directly when the user says to prepare that Lighter order for approval after previewing it; no user-facing vault id or preview id is required for the normal latest-preview flow. Creates a local durable execution intent and asks the engine to enqueue the approval card for lighter.order.create. This is a preparation step only: no signer, API private key read, signature, sendTx, order placement, cancellation, deposit, withdrawal, or transfer path.",
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
      "Approval-gated Lighter order create resume target for a prepared execution intent. In restricted mode this tool is enqueued for approval by lighter.order.create.prepare. The current implementation records the approval decision and stays behind the explicit Lighter live-trading release gate until final provider-outcome repair and live proof are complete. No direct call should be made without a prepared intent and approval-resume context.",
    mutating: true,
    actionKind: "external_post",
    params: [INTENT_ID_PARAM],
    exampleParams: { intentId: "lighter-exec-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.create"],
  },
];
