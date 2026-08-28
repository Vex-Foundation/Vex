import { spawn } from "node:child_process";
import path from "node:path";

import { ErrorCodes, VexError } from "../../errors.js";
import type { LighterEnvironment } from "./constants.js";
import type {
  LighterChangePubKeySignerAdapter,
  LighterChangePubKeySignerResult,
  LighterChangePubKeySigningInput,
} from "./change-pub-key.js";
import type {
  LighterAccountAuthSignerResult,
  LighterAccountAuthSigningInput,
  LighterCreateOrderSignerResult,
  LighterCreateOrderSigningInput,
  LighterSignerAdapter,
} from "./signer-adapter.js";
import {
  LIGHTER_TX_TYPE_CREATE_GROUPED_ORDERS,
} from "./oco-order.js";
import type {
  LighterCreateGroupedOrdersSigningInput,
  LighterGroupedOrderSignerAdapter,
} from "./signer-grouped-orders.js";
import { LIGHTER_SIGNER_CHAIN_IDS } from "./signer-adapter.js";
import type {
  LighterCoreWithdrawalSignerAdapter,
  LighterWithdrawalSignerAdapter,
  LighterWithdrawalSignerResult,
  LighterWithdrawalSigningInput,
} from "./signer-withdrawal.js";
import {
  materialFromSecret,
  type LighterTradingSecretMaterial,
} from "./trading-secret.js";
import { LIGHTER_TX_TYPE_L2_CHANGE_PUB_KEY } from "./wallet-funding/constants.js";
import {
  LIGHTER_TX_TYPE_CANCEL_ALL_ORDERS,
  LIGHTER_TX_TYPE_CANCEL_ORDER,
  LIGHTER_TX_TYPE_MODIFY_ORDER,
  type LighterCancelAllOrdersSigningInput,
  type LighterCancelOrderSigningInput,
  type LighterModifyOrderSigningInput,
  type LighterOrderLifecycleSignerAdapter,
  type LighterOrderLifecycleSignerResult,
} from "./signer-order-lifecycle.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_STDOUT_BYTES = 256 * 1024;

export interface LighterSignerBinaryRunRequest {
  readonly binaryPath: string;
  readonly payload: LighterSignerBinaryPayload;
  readonly timeoutMs: number;
}

export type LighterSignerBinaryRunner = (
  request: LighterSignerBinaryRunRequest,
) => Promise<unknown>;

export interface LighterSignerBinaryAdapterOptions {
  readonly binaryPath?: string;
  readonly timeoutMs?: number;
  readonly runner?: LighterSignerBinaryRunner;
}

export interface LighterSignerBinaryPathOptions {
  readonly resourcesPath?: string;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly defaultApp?: boolean;
}

interface LighterSignerBinaryBasePayload {
  readonly privateKey: string;
  readonly chainId: number;
  readonly accountIndex: string;
  readonly apiKeyIndex: number;
}

interface LighterSignerBinaryGenerateApiKeyPayload {
  readonly operation: "generateApiKey";
}

interface LighterSignerBinaryDerivePublicKeyPayload {
  readonly operation: "derivePublicKey";
  readonly privateKey: string;
}

interface LighterSignerBinaryAuthPayload extends LighterSignerBinaryBasePayload {
  readonly operation: "createAccountAuth";
  readonly deadlineUnixSeconds: string;
}

interface LighterSignerBinaryCreateOrderPayload extends LighterSignerBinaryBasePayload {
  readonly operation: "signCreateOrder";
  readonly nonce: string;
  readonly order: {
    readonly marketIndex: number;
    readonly clientOrderIndex: string;
    readonly baseAmount: string;
    readonly price: string;
    readonly isAsk: 0 | 1;
    readonly orderType: number;
    readonly timeInForce: number;
    readonly reduceOnly: 0 | 1;
    readonly triggerPrice: string;
    readonly orderExpiry: string;
  };
}

interface LighterSignerBinaryGroupedOrdersPayload extends LighterSignerBinaryBasePayload {
  readonly operation: "signCreateGroupedOrders";
  readonly nonce: string;
  readonly groupedOrders: {
    readonly groupingType: 2;
    readonly orders: readonly [
      LighterSignerBinaryCreateOrderPayload["order"],
      LighterSignerBinaryCreateOrderPayload["order"],
    ];
  };
}

interface LighterSignerBinaryCancelOrderPayload extends LighterSignerBinaryBasePayload {
  readonly operation: "signCancelOrder";
  readonly nonce: string;
  readonly expiredAt: string;
  readonly cancelOrder: {
    readonly marketIndex: number;
    readonly orderIndex: string;
  };
}

interface LighterSignerBinaryModifyOrderPayload extends LighterSignerBinaryBasePayload {
  readonly operation: "signModifyOrder";
  readonly nonce: string;
  readonly expiredAt: string;
  readonly modifyOrder: {
    readonly marketIndex: number;
    readonly orderIndex: string;
    readonly baseAmount: string;
    readonly price: string;
    readonly triggerPrice: string;
  };
}

interface LighterSignerBinaryCancelAllOrdersPayload extends LighterSignerBinaryBasePayload {
  readonly operation: "signCancelAllOrders";
  readonly nonce: string;
  readonly expiredAt: string;
  readonly cancelAllOrders: {
    readonly timeInForce: 0;
    readonly time: "0";
  };
}

interface LighterSignerBinaryWithdrawPayload extends LighterSignerBinaryBasePayload {
  readonly operation: "signWithdraw";
  readonly nonce: string;
  readonly expiredAt: string;
  readonly withdrawal: {
    readonly assetIndex: 3;
    readonly routeType: 0;
    readonly amount: string;
  };
}

interface LighterSignerBinaryChangePubKeyPayload extends LighterSignerBinaryBasePayload {
  readonly operation: "signChangePubKey";
  readonly nonce: string;
  readonly expiredAt: string;
  readonly publicKey: string;
  readonly l1Signature: string;
  readonly expectedL1Address: string;
}

interface LighterSignerBinaryCheckClientPayload extends LighterSignerBinaryBasePayload {
  readonly operation: "checkClient";
}

type LighterSignerBinaryPayload =
  | LighterSignerBinaryGenerateApiKeyPayload
  | LighterSignerBinaryDerivePublicKeyPayload
  | LighterSignerBinaryAuthPayload
  | LighterSignerBinaryCreateOrderPayload
  | LighterSignerBinaryGroupedOrdersPayload
  | LighterSignerBinaryCancelOrderPayload
  | LighterSignerBinaryModifyOrderPayload
  | LighterSignerBinaryCancelAllOrdersPayload
  | LighterSignerBinaryWithdrawPayload
  | LighterSignerBinaryChangePubKeyPayload
  | LighterSignerBinaryCheckClientPayload;

export interface LighterGeneratedApiKeyPair {
  readonly secret: LighterTradingSecretMaterial;
  /** Canonical lowercase 40-byte public key without a 0x prefix. */
  readonly publicKey: string;
}

export interface LighterApiKeyGenerator {
  readonly source: "official_lighter_signer";
  readonly generate: () => Promise<LighterGeneratedApiKeyPair>;
  readonly derivePublicKey: (secret: LighterTradingSecretMaterial) => Promise<string>;
}

export interface LighterRegisteredKeyCheckInput {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly secret: LighterTradingSecretMaterial;
}

export interface LighterRegisteredKeyCheckResult {
  /** Canonical lowercase 40-byte public key without a 0x prefix. */
  readonly publicKey: string;
}

export interface LighterRegisteredKeyChecker {
  readonly source: "official_lighter_signer";
  readonly check: (
    input: LighterRegisteredKeyCheckInput,
  ) => Promise<LighterRegisteredKeyCheckResult>;
}

/**
 * Privileged key-generation surface. It is intentionally separate from the
 * order signer adapter so renderer/agent-facing dependencies never receive a
 * generation method accidentally.
 */
export function createLighterApiKeyGeneratorBinary(
  options: LighterSignerBinaryAdapterOptions = {},
): LighterApiKeyGenerator {
  const runner = options.runner ?? runLighterSignerBinary;
  const binaryPath = options.binaryPath ?? resolveDefaultLighterSignerBinaryPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const derivePublicKey = async (secret: LighterTradingSecretMaterial): Promise<string> => {
    const raw = await runner({
      binaryPath,
      payload: { operation: "derivePublicKey", privateKey: secret.privateKey },
      timeoutMs,
    });
    return parsePublicKeyOutput(raw);
  };

  return {
    source: "official_lighter_signer",
    derivePublicKey,
    generate: async () => {
      const raw = await runner({
        binaryPath,
        payload: { operation: "generateApiKey" },
        timeoutMs,
      });
      const generated = parseGeneratedApiKeyOutput(raw);
      const derivedPublicKey = await derivePublicKey(generated.secret);
      if (derivedPublicKey !== generated.publicKey) {
        throw signerProcessFailed({ ok: false, errorCode: "keypair_mismatch" });
      }
      return generated;
    },
  };
}

export function createLighterSignerBinaryAdapter(
  options: LighterSignerBinaryAdapterOptions = {},
): LighterSignerAdapter {
  const runner = options.runner ?? runLighterSignerBinary;
  const binaryPath = options.binaryPath ?? resolveDefaultLighterSignerBinaryPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    source: "official_lighter_signer",
    createAccountAuth: async (input) => {
      const raw = await runner({
        binaryPath,
        payload: buildAccountAuthPayload(input),
        timeoutMs,
      });
      const output = parseAccountAuthOutput(raw);
      return {
        kind: "lighter_account_auth_signer_result",
        environment: input.environment,
        accountIndex: input.accountIndex,
        apiKeyIndex: input.apiKeyIndex,
        deadlineUnixSeconds: input.deadlineUnixSeconds,
        authToken: output.authToken,
        publicKey: output.publicKey,
      };
    },
    signCreateOrder: async (input) => {
      const raw = await runner({
        binaryPath,
        payload: buildSignerPayload(input),
        timeoutMs,
      });
      const output = parseSignerOutput(raw);
      return {
        kind: "lighter_create_order_signer_result",
        environment: input.environment,
        accountIndex: input.accountIndex,
        apiKeyIndex: input.apiKeyIndex,
        nonce: input.nonce,
        clientOrderIndex: input.order.clientOrderIndex,
        matchHash: input.order.matchHash,
        txType: output.txType,
        txInfo: output.txInfo,
        txHash: output.txHash,
      };
    },
  };
}

export function createLighterGroupedOrderSignerBinaryAdapter(
  options: LighterSignerBinaryAdapterOptions = {},
): LighterGroupedOrderSignerAdapter {
  const runner = options.runner ?? runLighterSignerBinary;
  const binaryPath = options.binaryPath ?? resolveDefaultLighterSignerBinaryPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    source: "official_lighter_signer",
    signCreateGroupedOrders: async (input) => {
      const raw = await runner({
        binaryPath,
        payload: buildGroupedOrdersPayload(input),
        timeoutMs,
      });
      const output = parseSignerOutput(raw);
      if (output.txType !== LIGHTER_TX_TYPE_CREATE_GROUPED_ORDERS) {
        throw signerProcessFailed(raw);
      }
      return {
        kind: "lighter_create_grouped_orders_signer_result",
        environment: input.environment,
        accountIndex: input.accountIndex,
        apiKeyIndex: input.apiKeyIndex,
        nonce: input.nonce,
        clientOrderIndexes: [
          input.group.orders[0].clientOrderIndex,
          input.group.orders[1].clientOrderIndex,
        ],
        matchHash: input.group.matchHash,
        txType: LIGHTER_TX_TYPE_CREATE_GROUPED_ORDERS,
        txInfo: output.txInfo,
        txHash: output.txHash,
      };
    },
  };
}

export function createLighterOrderLifecycleSignerBinary(
  options: LighterSignerBinaryAdapterOptions = {},
): LighterOrderLifecycleSignerAdapter {
  const runner = options.runner ?? runLighterSignerBinary;
  const binaryPath = options.binaryPath ?? resolveDefaultLighterSignerBinaryPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const run = async (
    input: LighterCancelOrderSigningInput | LighterModifyOrderSigningInput | LighterCancelAllOrdersSigningInput,
    payload: LighterSignerBinaryPayload,
    operation: LighterOrderLifecycleSignerResult["operation"],
    expectedTxType: 15 | 16 | 17,
  ): Promise<LighterOrderLifecycleSignerResult> => {
    const raw = await runner({ binaryPath, payload, timeoutMs });
    const output = parseOrderLifecycleSignerOutput(raw, expectedTxType);
    return {
      kind: "lighter_order_lifecycle_signer_result",
      operation,
      environment: input.environment,
      accountIndex: input.accountIndex,
      apiKeyIndex: input.apiKeyIndex,
      nonce: input.nonce,
      expiredAt: input.expiredAt,
      txType: expectedTxType,
      txInfo: output.txInfo,
      txHash: output.txHash,
    };
  };

  return {
    source: "official_lighter_signer",
    signCancelOrder: (input) => run(
      input,
      buildCancelOrderPayload(input),
      "cancel_order",
      LIGHTER_TX_TYPE_CANCEL_ORDER,
    ),
    signModifyOrder: (input) => run(
      input,
      buildModifyOrderPayload(input),
      "modify_order",
      LIGHTER_TX_TYPE_MODIFY_ORDER,
    ),
    signCancelAllOrders: (input) => run(
      input,
      buildCancelAllOrdersPayload(input),
      "cancel_all_orders",
      LIGHTER_TX_TYPE_CANCEL_ALL_ORDERS,
    ),
  };
}

export function createLighterChangePubKeySignerBinary(
  options: LighterSignerBinaryAdapterOptions = {},
): LighterChangePubKeySignerAdapter {
  const runner = options.runner ?? runLighterSignerBinary;
  const binaryPath = options.binaryPath ?? resolveDefaultLighterSignerBinaryPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    source: "official_lighter_signer",
    signChangePubKey: async (input) => {
      const raw = await runner({
        binaryPath,
        payload: buildChangePubKeyPayload(input),
        timeoutMs,
      });
      const output = parseChangePubKeyOutput(raw);
      const result = {
        kind: "lighter_change_pub_key_signer_result",
        environment: input.environment,
        accountIndex: input.accountIndex,
        apiKeyIndex: input.apiKeyIndex,
        nonce: input.nonce,
        expiredAt: input.expiredAt,
        publicKey: input.publicKey,
        expectedL1Address: input.expectedL1Address,
        messageToSign: output.messageToSign,
        txType: output.txType,
        txHash: output.txHash,
      } as Omit<LighterChangePubKeySignerResult, "txInfo">;
      return Object.defineProperty(result, "txInfo", {
        value: output.txInfo,
        enumerable: false,
      }) as LighterChangePubKeySignerResult;
    },
  };
}

export function createLighterCoreWithdrawalSignerBinary(
  options: LighterSignerBinaryAdapterOptions = {},
): LighterCoreWithdrawalSignerAdapter {
  return createLighterWithdrawalSignerBinary(options) as unknown as LighterCoreWithdrawalSignerAdapter;
}

export function createLighterWithdrawalSignerBinary(
  options: LighterSignerBinaryAdapterOptions = {},
): LighterWithdrawalSignerAdapter {
  const runner = options.runner ?? runLighterSignerBinary;
  const binaryPath = options.binaryPath ?? resolveDefaultLighterSignerBinaryPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    source: "official_lighter_signer",
    signWithdraw: async (input) => {
      const raw = await runner({
        binaryPath,
        payload: buildWithdrawPayload(input),
        timeoutMs,
      });
      const output = parseWithdrawalSignerOutput(raw);
      const result = {
        kind: input.environment === "core"
          ? "lighter_core_withdrawal_signer_result"
          : "lighter_rhc_withdrawal_signer_result",
        environment: input.environment,
        accountIndex: input.accountIndex,
        apiKeyIndex: input.apiKeyIndex,
        nonce: input.nonce,
        expiredAt: input.expiredAt,
        assetIndex: input.assetIndex,
        routeType: input.routeType,
        amountUnits: input.amountUnits,
        matchHash: input.matchHash,
        txType: 13,
        txHash: output.txHash,
      } as Omit<LighterWithdrawalSignerResult, "txInfo">;
      return Object.defineProperty(result, "txInfo", {
        value: output.txInfo,
        enumerable: false,
      }) as LighterWithdrawalSignerResult;
    },
  };
}

/** Official SDK CheckClient seam, kept separate from order signing surfaces. */
export function createLighterRegisteredKeyCheckerBinary(
  options: LighterSignerBinaryAdapterOptions = {},
): LighterRegisteredKeyChecker {
  const runner = options.runner ?? runLighterSignerBinary;
  const binaryPath = options.binaryPath ?? resolveDefaultLighterSignerBinaryPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    source: "official_lighter_signer",
    check: async (input) => {
      const raw = await runner({
        binaryPath,
        payload: {
          operation: "checkClient",
          privateKey: input.secret.privateKey,
          chainId: LIGHTER_SIGNER_CHAIN_IDS[input.environment],
          accountIndex: String(input.accountIndex),
          apiKeyIndex: input.apiKeyIndex,
        },
        timeoutMs,
      });
      return { publicKey: parsePublicKeyOutput(raw) };
    },
  };
}

function buildAccountAuthPayload(
  input: LighterAccountAuthSigningInput,
): LighterSignerBinaryAuthPayload {
  return {
    operation: "createAccountAuth",
    privateKey: input.secret.privateKey,
    chainId: input.chainId,
    accountIndex: String(input.accountIndex),
    apiKeyIndex: input.apiKeyIndex,
    deadlineUnixSeconds: String(input.deadlineUnixSeconds),
  };
}

function buildChangePubKeyPayload(
  input: LighterChangePubKeySigningInput,
): LighterSignerBinaryChangePubKeyPayload {
  return {
    operation: "signChangePubKey",
    privateKey: input.secret.privateKey,
    chainId: input.chainId,
    accountIndex: String(input.accountIndex),
    apiKeyIndex: input.apiKeyIndex,
    nonce: input.nonce,
    expiredAt: input.expiredAt,
    publicKey: input.publicKey,
    l1Signature: input.l1Signature,
    expectedL1Address: input.expectedL1Address,
  };
}

function buildWithdrawPayload(
  input: LighterWithdrawalSigningInput,
): LighterSignerBinaryWithdrawPayload {
  return {
    operation: "signWithdraw",
    privateKey: input.secret.privateKey,
    chainId: input.chainId,
    accountIndex: String(input.accountIndex),
    apiKeyIndex: input.apiKeyIndex,
    nonce: input.nonce,
    expiredAt: input.expiredAt,
    withdrawal: {
      assetIndex: input.assetIndex,
      routeType: input.routeType,
      amount: input.amountUnits,
    },
  };
}

function lifecyclePayloadBase(
  input: LighterCancelOrderSigningInput | LighterModifyOrderSigningInput | LighterCancelAllOrdersSigningInput,
): LighterSignerBinaryBasePayload & { readonly nonce: string; readonly expiredAt: string } {
  return {
    privateKey: input.secret.privateKey,
    chainId: input.chainId,
    accountIndex: String(input.accountIndex),
    apiKeyIndex: input.apiKeyIndex,
    nonce: input.nonce,
    expiredAt: input.expiredAt,
  };
}

function buildCancelOrderPayload(input: LighterCancelOrderSigningInput): LighterSignerBinaryCancelOrderPayload {
  return {
    operation: "signCancelOrder",
    ...lifecyclePayloadBase(input),
    cancelOrder: { marketIndex: input.marketIndex, orderIndex: input.providerOrderId },
  };
}

function buildModifyOrderPayload(input: LighterModifyOrderSigningInput): LighterSignerBinaryModifyOrderPayload {
  return {
    operation: "signModifyOrder",
    ...lifecyclePayloadBase(input),
    modifyOrder: {
      marketIndex: input.marketIndex,
      orderIndex: input.providerOrderId,
      baseAmount: input.baseAmountInteger,
      price: input.priceInteger,
      triggerPrice: input.triggerPriceInteger,
    },
  };
}

function buildCancelAllOrdersPayload(
  input: LighterCancelAllOrdersSigningInput,
): LighterSignerBinaryCancelAllOrdersPayload {
  return {
    operation: "signCancelAllOrders",
    ...lifecyclePayloadBase(input),
    cancelAllOrders: { timeInForce: input.timeInForce, time: input.cancelAtMs },
  };
}

export function resolveDefaultLighterSignerBinaryPath(
  options: LighterSignerBinaryPathOptions = {},
): string {
  const envPath = process.env.VEX_LIGHTER_SIGNER_BINARY_PATH?.trim();
  if (envPath) return envPath;

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const binaryName = platform === "win32"
    ? `vex-lighter-signer-${platform}-${arch}.exe`
    : `vex-lighter-signer-${platform}-${arch}`;
  const defaultApp =
    options.defaultApp ??
    Boolean((process as NodeJS.Process & { readonly defaultApp?: boolean }).defaultApp);
  const processResourcesPath =
    (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
  const resourcesPath = defaultApp
    ? undefined
    : (options.resourcesPath ?? processResourcesPath);
  const cwd = options.cwd ?? process.cwd();
  const localResourceRoot = path.basename(cwd) === "vex-app"
    ? cwd
    : path.join(cwd, "vex-app");
  const baseDir = resourcesPath
    ? path.join(resourcesPath, "lighter-signer")
    : path.join(localResourceRoot, "resources", "lighter-signer");
  return path.join(baseDir, binaryName);
}

export async function runLighterSignerBinary(
  request: LighterSignerBinaryRunRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stdoutBytes = 0;
    const child = spawn(request.binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(signerUnavailable("Lighter signer helper timed out.")));
    }, request.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(signerUnavailable("Lighter signer helper returned too much output.")));
        return;
      }
      stdout += chunk;
    });

    child.stderr.on("data", () => {
      // Deliberately drain without retaining text; helper errors must stay structural.
    });

    child.on("error", () => {
      finish(() => reject(signerUnavailable("Lighter signer helper is not available.")));
    });

    child.on("close", (code) => {
      finish(() => {
        let parsed: unknown;
        try {
          parsed = parseHelperJson(stdout);
        } catch (err) {
          reject(err);
          return;
        }
        if (code !== 0) {
          reject(signerProcessFailed(parsed));
          return;
        }
        resolve(parsed);
      });
    });

    child.stdin.on("error", () => {
      finish(() => reject(signerUnavailable("Lighter signer helper input stream failed.")));
    });
    child.stdin.end(`${JSON.stringify(request.payload)}\n`);
  });
}

function buildSignerPayload(input: LighterCreateOrderSigningInput): LighterSignerBinaryPayload {
  return {
    operation: "signCreateOrder",
    privateKey: input.secret.privateKey,
    chainId: input.chainId,
    accountIndex: String(input.accountIndex),
    apiKeyIndex: input.apiKeyIndex,
    nonce: input.nonce,
    order: {
      marketIndex: input.order.marketIndex,
      clientOrderIndex: input.order.clientOrderIndex,
      baseAmount: input.order.baseAmountInteger,
      price: input.order.priceInteger,
      isAsk: input.order.isAsk ? 1 : 0,
      orderType: input.order.orderTypeCode,
      timeInForce: input.order.timeInForceCode,
      reduceOnly: input.order.reduceOnly ? 1 : 0,
      triggerPrice: input.order.triggerPriceInteger,
      orderExpiry: String(input.order.orderExpiryMs),
    },
  };
}

function buildGroupedOrdersPayload(
  input: LighterCreateGroupedOrdersSigningInput,
): LighterSignerBinaryGroupedOrdersPayload {
  const orderPayload = (
    order: LighterCreateGroupedOrdersSigningInput["group"]["orders"][number],
  ): LighterSignerBinaryCreateOrderPayload["order"] => ({
    marketIndex: order.marketIndex,
    clientOrderIndex: order.clientOrderIndex,
    baseAmount: order.baseAmountInteger,
    price: order.priceInteger,
    isAsk: order.isAsk ? 1 : 0,
    orderType: order.orderTypeCode,
    timeInForce: order.timeInForceCode,
    reduceOnly: order.reduceOnly ? 1 : 0,
    triggerPrice: order.triggerPriceInteger,
    orderExpiry: String(order.orderExpiryMs),
  });
  return {
    operation: "signCreateGroupedOrders",
    privateKey: input.secret.privateKey,
    chainId: input.chainId,
    accountIndex: String(input.accountIndex),
    apiKeyIndex: input.apiKeyIndex,
    nonce: input.nonce,
    groupedOrders: {
      groupingType: 2,
      orders: [orderPayload(input.group.orders[0]), orderPayload(input.group.orders[1])],
    },
  };
}

function parseSignerOutput(raw: unknown): Pick<
  LighterCreateOrderSignerResult,
  "txType" | "txInfo" | "txHash"
> {
  if (!isRecord(raw)) throw signerProcessFailed(raw);
  if (raw.ok !== true) throw signerProcessFailed(raw);
  const { txType, txInfo, txHash } = raw;
  if (typeof txType !== "number" || !Number.isInteger(txType) || txType < 0 || txType > 255) {
    throw signerProcessFailed(raw);
  }
  if (typeof txInfo !== "string" || txInfo.trim().length === 0) {
    throw signerProcessFailed(raw);
  }
  if (typeof txHash !== "string" || txHash.trim().length === 0) {
    throw signerProcessFailed(raw);
  }
  return {
    txType,
    txInfo,
    txHash,
  };
}

function parseChangePubKeyOutput(raw: unknown): Pick<
  LighterChangePubKeySignerResult,
  "messageToSign" | "txType" | "txInfo" | "txHash"
> {
  const signed = parseSignerOutput(raw);
  if (
    signed.txType !== LIGHTER_TX_TYPE_L2_CHANGE_PUB_KEY
    || !isRecord(raw)
    || typeof raw.messageToSign !== "string"
    || raw.messageToSign.length === 0
  ) {
    throw signerProcessFailed(raw);
  }
  return {
    txType: LIGHTER_TX_TYPE_L2_CHANGE_PUB_KEY,
    txInfo: signed.txInfo,
    txHash: signed.txHash,
    messageToSign: raw.messageToSign,
  };
}

function parseWithdrawalSignerOutput(raw: unknown): Pick<
  LighterWithdrawalSignerResult,
  "txInfo" | "txHash"
> {
  const signed = parseSignerOutput(raw);
  if (signed.txType !== 13) throw signerProcessFailed(raw);
  return { txInfo: signed.txInfo, txHash: signed.txHash };
}

function parseOrderLifecycleSignerOutput(
  raw: unknown,
  expectedTxType: 15 | 16 | 17,
): Pick<LighterOrderLifecycleSignerResult, "txInfo" | "txHash"> {
  const signed = parseSignerOutput(raw);
  if (signed.txType !== expectedTxType) throw signerProcessFailed(raw);
  return { txInfo: signed.txInfo, txHash: signed.txHash };
}

function parseAccountAuthOutput(raw: unknown): Pick<
  LighterAccountAuthSignerResult,
  "authToken" | "publicKey"
> {
  if (!isRecord(raw) || raw.ok !== true) throw signerProcessFailed(raw);
  if (typeof raw.authToken !== "string" || raw.authToken.trim().length === 0) {
    throw signerProcessFailed(raw);
  }
  if (typeof raw.publicKey !== "string" || !/^[a-fA-F0-9]{80}$/.test(raw.publicKey)) {
    throw signerProcessFailed(raw);
  }
  return {
    authToken: raw.authToken,
    publicKey: raw.publicKey,
  };
}

function parseGeneratedApiKeyOutput(raw: unknown): LighterGeneratedApiKeyPair {
  if (!isRecord(raw) || raw.ok !== true) throw signerProcessFailed(raw);
  if (typeof raw.privateKey !== "string") throw signerProcessFailed(raw);
  const secret = materialFromSecret(raw.privateKey);
  return {
    secret,
    publicKey: parsePublicKeyOutput(raw),
  };
}

function parsePublicKeyOutput(raw: unknown): string {
  if (!isRecord(raw) || raw.ok !== true) throw signerProcessFailed(raw);
  if (typeof raw.publicKey !== "string" || !/^(?:0x)?[a-fA-F0-9]{80}$/.test(raw.publicKey)) {
    throw signerProcessFailed(raw);
  }
  return raw.publicKey.toLowerCase().replace(/^0x/, "");
}

function parseHelperJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw signerUnavailable("Lighter signer helper returned invalid output.");
  }
}

function signerProcessFailed(raw: unknown): VexError {
  const code = isRecord(raw) && typeof raw.errorCode === "string" ? raw.errorCode : "unknown";
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `Lighter signer helper failed (${code}).`,
    "Retry after the Lighter trading credential, nonce, and signer helper are checked.",
  );
}

function signerUnavailable(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Install or build the packaged Lighter signer helper before live order submission.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
