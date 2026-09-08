import { spawn, type SpawnOptions } from "node:child_process";
import path from "node:path";

import { ErrorCodes, VexError } from "../../errors.js";
import logger from "@utils/logger.js";
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

import { assertLighterIntegratorFees, type LighterIntegratorFees } from "./fee-policy.js";
import { LIGHTER_TX_TYPE_APPROVE_INTEGRATOR, type LighterApproveIntegratorSignerAdapter,
  type LighterApproveIntegratorSigningInput, type LighterApproveIntegratorSignerResult } from "./signer-integrator.js";

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
  /**
   * Whether `VEX_LIGHTER_SIGNER_BINARY_PATH` may redirect the helper for this
   * adapter. See `LighterSignerBinaryPathOptions.allowBinaryPathOverride`; the
   * default is `false`, so an adapter built without an explicit decision runs
   * the packaged helper and nothing else.
   */
  readonly allowBinaryPathOverride?: boolean;
}

export interface LighterSignerBinaryPathOptions {
  readonly resourcesPath?: string;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly defaultApp?: boolean;
  /**
   * Whether the `VEX_LIGHTER_SIGNER_BINARY_PATH` environment variable may
   * redirect the helper.
   *
   * The helper receives a Lighter API PRIVATE KEY on stdin, so an environment
   * variable that repoints it is a key-exfiltration channel in a packaged,
   * signed app - the one place where the shipped, verified, signed binary is
   * the only acceptable answer. In development the same variable is a
   * legitimate convenience (a locally built helper, a debug build).
   *
   * This adapter runs in core and has no Electron, so it cannot read
   * `app.isPackaged` itself: the DECISION is passed in by the privileged main
   * process, and the default is `false`. Fail closed on purpose - a caller that
   * never thought about it gets the packaged helper, not the environment's.
   */
  readonly allowBinaryPathOverride?: boolean;
}

interface LighterSignerBinaryBasePayload {
  readonly privateKey: string;
  readonly integratorFees?: LighterIntegratorFees | null;
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

interface LighterSignerBinaryApproveIntegratorPayload extends LighterSignerBinaryBasePayload {
  readonly operation: "signApproveIntegrator";
  readonly nonce: string;
  readonly expiredAt: string;
  readonly expectedL1Address: string;
  readonly l1Signature: string;
  readonly approveIntegrator: {
    readonly integratorAccountIndex: number;
    readonly maxPerpsMakerFee: number;
    readonly maxPerpsTakerFee: number;
    readonly maxSpotMakerFee: number;
    readonly maxSpotTakerFee: number;
    readonly approvalExpiry: number;
  };
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
  | LighterSignerBinaryApproveIntegratorPayload
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
 * The helper path one adapter will use: an explicit path when the caller gave
 * one, otherwise the packaged location, with the environment override allowed
 * only when the caller said so.
 */
function defaultBinaryPath(options: LighterSignerBinaryAdapterOptions): string {
  return options.binaryPath ?? resolveDefaultLighterSignerBinaryPath({
    allowBinaryPathOverride: options.allowBinaryPathOverride ?? false,
  });
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
  const binaryPath = defaultBinaryPath(options);
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
  const binaryPath = defaultBinaryPath(options);
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
      assertSignedIntegratorAttributes(output.txInfo, input.order.integratorFees);
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
  const binaryPath = defaultBinaryPath(options);
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
      assertSignedIntegratorAttributes(output.txInfo, input.group.integratorFees);
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
  const binaryPath = defaultBinaryPath(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const run = async (
    input: LighterCancelOrderSigningInput | LighterModifyOrderSigningInput | LighterCancelAllOrdersSigningInput,
    payload: LighterSignerBinaryPayload,
    operation: LighterOrderLifecycleSignerResult["operation"],
    expectedTxType: 15 | 16 | 17,
  ): Promise<LighterOrderLifecycleSignerResult> => {
    const raw = await runner({ binaryPath, payload, timeoutMs });
    const output = parseOrderLifecycleSignerOutput(raw, expectedTxType);
    assertSignedIntegratorAttributes(output.txInfo, "integratorFees" in input ? input.integratorFees : null);
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

export function createLighterSignerBinaryApproveIntegratorAdapter(
  options: LighterSignerBinaryAdapterOptions = {},
): LighterApproveIntegratorSignerAdapter {
  const runner = options.runner ?? runLighterSignerBinary;
  return {
    source: "official_lighter_signer",
    signApproveIntegrator: async (input) => {
      const raw = await runner({ binaryPath: defaultBinaryPath(options),
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, payload: buildApproveIntegratorPayload(input) });
      const output = parseSignerOutput(raw);
      if (output.txType !== LIGHTER_TX_TYPE_APPROVE_INTEGRATOR || !isRecord(raw) || typeof raw.messageToSign !== "string") throw signerProcessFailed(raw);
      const { secret: _secret, l1Signature: _signature, chainId: _chainId, kind: _kind, ...terms } = input;
      const result = { ...terms, kind: "lighter_approve_integrator_signer_result" as const,
        messageToSign: raw.messageToSign, txType: LIGHTER_TX_TYPE_APPROVE_INTEGRATOR, txHash: output.txHash };
      return Object.defineProperty(result, "txInfo", { value: output.txInfo, enumerable: false }) as LighterApproveIntegratorSignerResult;
    },
  };
}

function buildApproveIntegratorPayload(input: LighterApproveIntegratorSigningInput): LighterSignerBinaryApproveIntegratorPayload {
  return { operation: "signApproveIntegrator", privateKey: input.secret.privateKey, chainId: input.chainId,
    accountIndex: String(input.accountIndex), apiKeyIndex: input.apiKeyIndex, nonce: input.nonce, expiredAt: input.expiredAt,
    expectedL1Address: input.expectedL1Address, l1Signature: input.l1Signature,
    approveIntegrator: { integratorAccountIndex: input.integratorAccountIndex, maxPerpsMakerFee: input.maxPerpsMakerFee,
      maxPerpsTakerFee: input.maxPerpsTakerFee, maxSpotMakerFee: input.maxSpotMakerFee,
      maxSpotTakerFee: input.maxSpotTakerFee, approvalExpiry: input.approvalExpiry } };
}

export function createLighterChangePubKeySignerBinary(
  options: LighterSignerBinaryAdapterOptions = {},
): LighterChangePubKeySignerAdapter {
  const runner = options.runner ?? runLighterSignerBinary;
  const binaryPath = defaultBinaryPath(options);
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
  const binaryPath = defaultBinaryPath(options);
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
  const binaryPath = defaultBinaryPath(options);
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
    ...(input.integratorFees ? { integratorFees: input.integratorFees } : {}),
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

/**
 * Logged once per process, not per signing call: the deviation is a property of
 * this run, and a wallet-grade log line repeated on every order is noise that
 * hides the next one.
 */
let signerOverrideLogged = false;

export function resolveDefaultLighterSignerBinaryPath(
  options: LighterSignerBinaryPathOptions = {},
): string {
  const envPath = process.env.VEX_LIGHTER_SIGNER_BINARY_PATH?.trim();
  if (envPath) {
    if (options.allowBinaryPathOverride === true) {
      if (!signerOverrideLogged) {
        signerOverrideLogged = true;
        logger.warn(
          "Lighter signer helper path overridden by VEX_LIGHTER_SIGNER_BINARY_PATH; "
            + "this is permitted only in an unpackaged build and the helper receives "
            + "trading private keys on stdin.",
          { binaryPath: envPath },
        );
      }
      return envPath;
    }
    if (!signerOverrideLogged) {
      signerOverrideLogged = true;
      logger.warn(
        "VEX_LIGHTER_SIGNER_BINARY_PATH is set but IGNORED: a packaged Vex runs the "
          + "signed helper that ships inside the application bundle.",
      );
    }
  }

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

/**
 * How the signer child ended, as far as this process can prove it.
 *
 * `"exited"` means the child's `close` event was observed: the process is gone,
 * its pipes are closed, and no further signing work can be in flight. That is
 * the ONLY state in which a nonce reservation may be released, because it is
 * the only one in which "nothing was signed and submitted behind our back" is a
 * fact rather than a hope.
 *
 * `"unknown"` means the adapter gave up waiting: it sent SIGKILL and the child
 * still had not closed within the drain grace. The signing outcome is
 * indeterminate and every caller must treat it conservatively - no re-sign, no
 * resubmit, no reservation release, reconcile instead.
 */
export type LighterSignerChildState = "exited" | "unknown";

/** A rejection from `runLighterSignerBinary`, carrying the child's end state. */
export interface LighterSignerChildStateCarrier {
  readonly lighterSignerChildState: LighterSignerChildState;
}

/**
 * The child state a signer rejection carries, or `undefined` for an error that
 * did not come from the signer child at all.
 *
 * A RESOLVED promise always means `"exited"`: the runner never resolves before
 * the `close` event, which is the contract this accessor complements.
 */
export function lighterSignerChildState(error: unknown): LighterSignerChildState | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const carried = (error as Partial<LighterSignerChildStateCarrier>).lighterSignerChildState;
  return carried === "exited" || carried === "unknown" ? carried : undefined;
}

function withChildState<E extends object>(error: E, state: LighterSignerChildState): E {
  Object.defineProperty(error, "lighterSignerChildState", {
    value: state,
    enumerable: true,
    writable: false,
  });
  return error;
}

/**
 * THE ONE SIGNER SETTLEMENT CONTRACT, owned here because this adapter is what
 * produces the evidence (plan section 12.4).
 *
 * A `resolved` run is exit evidence BY CONSTRUCTION: `runLighterSignerBinary`
 * settles a success only after the child's `close` event, so there is no
 * resolved value that could describe a child still running. A `rejected` run
 * carries `lighterSignerChildState`, and only `"exited"` is proof.
 *
 * Callers must not re-derive this from the shape of a signer result. A result
 * is a signed transaction, not a lifecycle record; a predicate that reads a
 * field off it can only be fooled or fabricated.
 */
export type LighterSignerRunOutcome =
  | { readonly kind: "resolved" }
  | { readonly kind: "rejected"; readonly error: unknown };

/**
 * Whether the signer child provably ended, and therefore whether a nonce
 * reservation held across the signing call may be released.
 *
 * Missing evidence is `false` (unknown), including errors from a custom runner
 * and errors thrown by a caller between the runner and this adapter.
 */
export function lighterSignerRunExited(outcome: LighterSignerRunOutcome): boolean {
  return outcome.kind === "resolved"
    || lighterSignerChildState(outcome.error) === "exited";
}

/**
 * Copy the settlement evidence from one error onto the sanitized error a
 * privileged wrapper returns upstream.
 *
 * A wrapper that must not leak helper stderr, a private key or a wallet
 * signature still owes its caller the child's end state: dropping the carrier
 * turns proven quiescence into "unknown" and strands a nonce reservation. When
 * the source carries nothing, the target is returned unchanged and stays
 * unknown.
 */
export function carryLighterSignerChildState<E extends object>(source: unknown, target: E): E {
  const state = lighterSignerChildState(source);
  return state === undefined ? target : withChildState(target, state);
}

/**
 * How long the adapter waits for a killed child to actually close before it
 * declares the outcome unknown. Long enough for a normal SIGKILL teardown on a
 * loaded machine, short enough that a wedged helper cannot hold a signing path
 * open indefinitely.
 */
const KILL_DRAIN_GRACE_MS = 5_000;

/**
 * The read side of a child pipe as this runner drives it (stdout, and stderr
 * without decoding).
 *
 * `off` and not `removeAllListeners`: this runner removes the listeners IT
 * registered and nothing else. `removeAllListeners` also strips Node's own
 * stdio bookkeeping from the pipe, which is not ours to take.
 */
export interface LighterSignerChildReadable {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "data", listener: (chunk: string) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  destroy(): unknown;
}

/** The write side of the child's stdin as this runner drives it: one payload line, then end. */
export interface LighterSignerChildWritable {
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  end(chunk: string): unknown;
  destroy(): unknown;
}

/**
 * The subset of a `ChildProcess` this runner touches, declared STRUCTURALLY.
 * Node's real `spawn` satisfies it unchanged, and a test can hand the runner a
 * scripted child without inhabiting the twenty overloads of `typeof spawn`
 * (no double cast can express that honestly, so the seam names what it uses).
 */
export interface LighterSignerChildProcess {
  readonly pid?: number | undefined;
  readonly stdout: LighterSignerChildReadable | null;
  readonly stderr: Pick<LighterSignerChildReadable, "on" | "off" | "destroy"> | null;
  readonly stdin: LighterSignerChildWritable | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
  unref(): void;
}

/** The one `spawn` shape this runner calls: a binary path, no arguments, piped stdio. */
export type LighterSignerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => LighterSignerChildProcess;

/** The pieces of `node:child_process` this runner needs, so a test can drive it. */
export interface LighterSignerSpawnDependencies {
  readonly spawn: LighterSignerSpawn;
  readonly killDrainGraceMs: number;
}

const REAL_SPAWN_DEPENDENCIES: LighterSignerSpawnDependencies = {
  spawn,
  killDrainGraceMs: KILL_DRAIN_GRACE_MS,
};

/**
 * The environment the helper is given.
 *
 * NOT `process.env`. The privileged Vex process holds vault material, provider
 * credentials and RPC endpoints in its environment, and the signer helper needs
 * none of it: its entire input arrives as one JSON document on stdin. Every
 * variable withheld here is one that cannot leak into a crash dump, a child of
 * the helper, or a helper that is not the one we think it is.
 *
 * Windows keeps `SystemRoot` and `windir` because the loader and the platform
 * crypto libraries resolve system DLLs through them; a Windows process started
 * with a truly empty environment can fail before `main`. Nothing else is
 * inherited on any platform, PATH included: the helper is launched by absolute
 * path and never resolves a program name.
 */
function signerChildEnvironment(platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (platform !== "win32") return {};
  const inherited: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "windir"]) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return inherited;
}

/** A pipe that is already gone cannot be destroyed; abandoning must not throw. */
function destroyQuietly(pipe: { destroy(): unknown } | null): void {
  if (pipe === null) return;
  try {
    pipe.destroy();
  } catch {
    // The handle is already closed; nothing is left to release.
  }
}

/**
 * Run the signer helper over one payload and settle ONLY after the child is
 * gone.
 *
 * The lifecycle contract, which the Lighter execution owners depend on
 * (plan section 12.4):
 *
 *   - the promise settles after the child's `close` event, never before, so a
 *     resolved or rejected call means no signing work is still running;
 *   - on timeout, on stdout overflow, and on a stdin failure, the child is
 *     SIGKILLed and then DRAINED: the promise still waits for `close`, up to
 *     `killDrainGraceMs`;
 *   - if that grace expires, the promise settles with
 *     `lighterSignerChildState: "unknown"` on the error and the child is
 *     abandoned: pipes destroyed, child unref'd, and one no-op `error` listener
 *     left on each so a late pipe error cannot crash the privileged process;
 *   - every rejection carries `lighterSignerChildState`, and every resolution
 *     implies `"exited"`;
 *   - every listener this runner registered, and every timer it started, is
 *     removed on the settling path on every branch, so a long-lived process
 *     does not accumulate them per signature; listeners it did not register
 *     (Node's own stdio bookkeeping, another owner's) are never touched.
 *
 * The first failure WINS: a child that is killed for overflow and then exits
 * non-zero reports the overflow, not the exit code, because the overflow is
 * what happened first and what the operator has to fix.
 */
export async function runLighterSignerBinary(
  request: LighterSignerBinaryRunRequest,
  dependencies: LighterSignerSpawnDependencies = REAL_SPAWN_DEPENDENCIES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stdoutBytes = 0;
    let failure: VexError | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const child = dependencies.spawn(request.binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: signerChildEnvironment(process.platform),
    });

    /**
     * Exactly the listeners this runner registered, each paired with the call
     * that undoes it. Nothing else is touched: `removeAllListeners` on a pipe
     * takes Node's own stdio bookkeeping with it, and on the child it would
     * remove listeners other owners registered on the same object.
     */
    const ownedListeners: Array<() => void> = [];

    const releaseListeners = (): void => {
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      for (const release of ownedListeners.splice(0)) release();
    };

    /** A late pipe or child `error` with no listener is an unhandled event. */
    const ignoreLateError = (): void => {};

    /**
     * The child survived SIGKILL and this process is giving up on it.
     *
     * Ownership ends here, so it ends completely: the pipes are destroyed and
     * the child is unreferenced, because a wedged helper holding three open
     * pipe handles keeps the runtime alive just as effectively as the process
     * itself. One no-op `error` listener stays on the child and on each pipe -
     * the handles outlive this runner, and an unhandled `error` event on any of
     * them would take the privileged process down long after the call that
     * spawned it returned.
     *
     * The reported state stays `"unknown"`: abandoning a child is not evidence
     * that it stopped signing.
     */
    const abandonChild = (): void => {
      child.on("error", ignoreLateError);
      child.stdout?.on("error", ignoreLateError);
      child.stderr?.on("error", ignoreLateError);
      child.stdin?.on("error", ignoreLateError);
      destroyQuietly(child.stdout);
      destroyQuietly(child.stderr);
      destroyQuietly(child.stdin);
      child.unref();
    };

    const settle = (state: LighterSignerChildState, exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      releaseListeners();

      if (state === "unknown") {
        abandonChild();
        reject(withChildState(
          failure ?? signerUnavailable("Lighter signer helper did not exit."),
          "unknown",
        ));
        return;
      }
      if (failure !== null) {
        reject(withChildState(failure, "exited"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = parseHelperJson(stdout);
      } catch (err) {
        reject(err instanceof VexError ? withChildState(err, "exited") : err);
        return;
      }
      if (exitCode !== 0) {
        reject(withChildState(signerProcessFailed(parsed), "exited"));
        return;
      }
      resolve(parsed);
    };

    /**
     * Record the first failure, stop the child, and keep waiting for `close`.
     *
     * Killing is not the same as proving quiescence (rule 05): the reservation
     * owner needs the `close` event, so the promise stays open until it arrives
     * or the grace expires.
     */
    const abort = (error: VexError): void => {
      if (settled || failure !== null) return;
      failure = error;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // A child that is already gone cannot be killed; `close` decides.
      }
      graceTimer = setTimeout(() => settle("unknown", null), dependencies.killDrainGraceMs);
      graceTimer.unref?.();
    };

    const timer = setTimeout(() => {
      abort(signerUnavailable("Lighter signer helper timed out."));
    }, request.timeoutMs);

    const onStdoutData = (chunk: string): void => {
      if (failure !== null) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        abort(signerUnavailable("Lighter signer helper returned too much output."));
        return;
      }
      stdout += chunk;
    };
    // Deliberately drained without retaining text; helper errors stay structural.
    const onStderrData = (): void => {};
    const onChildError = (): void => {
      if (child.pid === undefined) {
        // The process was never created (a missing or unexecutable helper), so
        // there is nothing to drain and nothing that could have signed.
        failure ??= signerUnavailable("Lighter signer helper is not available.");
        settle("exited", null);
        return;
      }
      abort(signerUnavailable("Lighter signer helper is not available."));
    };
    const onChildClose = (code: number | null): void => {
      settle("exited", code);
    };
    const onStdinError = (): void => {
      abort(signerUnavailable("Lighter signer helper input stream failed."));
    };

    const stdoutPipe = child.stdout;
    if (stdoutPipe !== null) {
      stdoutPipe.setEncoding("utf8");
      stdoutPipe.on("data", onStdoutData);
      ownedListeners.push(() => { stdoutPipe.off("data", onStdoutData); });
    }
    const stderrPipe = child.stderr;
    if (stderrPipe !== null) {
      stderrPipe.on("data", onStderrData);
      ownedListeners.push(() => { stderrPipe.off("data", onStderrData); });
    }
    child.on("error", onChildError);
    ownedListeners.push(() => { child.off("error", onChildError); });
    child.on("close", onChildClose);
    ownedListeners.push(() => { child.off("close", onChildClose); });
    const stdinPipe = child.stdin;
    if (stdinPipe !== null) {
      stdinPipe.on("error", onStdinError);
      ownedListeners.push(() => { stdinPipe.off("error", onStdinError); });
      stdinPipe.end(`${JSON.stringify(request.payload)}\n`);
    }
  });
}
function buildSignerPayload(input: LighterCreateOrderSigningInput): LighterSignerBinaryPayload {
  return {
    operation: "signCreateOrder",
    ...(input.order.integratorFees ? { integratorFees: input.order.integratorFees } : {}),
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
    ...(input.group.integratorFees ? { integratorFees: input.group.integratorFees } : {}),
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

function assertSignedIntegratorAttributes(txInfo: string, expected: LighterIntegratorFees | null | undefined): void {
  let parsed: unknown;
  try { parsed = JSON.parse(txInfo); } catch {
    if (expected != null) throw signerProcessFailed(null);
    return;
  }
  const attrs = isRecord(parsed) ? parsed.L2TxAttributes : undefined;
  if (expected == null) {
    if (isRecord(attrs) && ["1", "2", "3"].some((key) => Object.hasOwn(attrs, key))) throw signerProcessFailed(null);
    return;
  }
  assertLighterIntegratorFees(expected);
  if (!isRecord(attrs) || Object.keys(attrs).sort().join() !== "1,2,3"
    || attrs["1"] !== expected.integratorAccountIndex || attrs["2"] !== expected.integratorTakerFee || attrs["3"] !== expected.integratorMakerFee) {
    throw signerProcessFailed(null);
  }
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
