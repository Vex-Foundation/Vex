import { getAddress } from "viem";

import { ErrorCodes, VexError } from "../../errors.js";
import type { LighterEnvironment } from "./constants.js";
import {
  LIGHTER_SIGNER_CHAIN_IDS,
  LIGHTER_SIGNER_UINT48_MAX,
} from "./signer-adapter.js";
import type { LighterTradingSecretMaterial } from "./trading-secret.js";
import {
  LIGHTER_CHANGE_PUB_KEY_SIGNATURE_TEMPLATE,
  LIGHTER_TX_TYPE_L2_CHANGE_PUB_KEY,
} from "./wallet-funding/constants.js";

const UINT64_MAX = (1n << 64n) - 1n;
const INT64_MAX = (1n << 63n) - 1n;

export interface LighterChangePubKeySigningInput {
  readonly kind: "lighter_change_pub_key_signing_input";
  readonly environment: LighterEnvironment;
  readonly chainId: number;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly publicKey: string;
  readonly expectedL1Address: string;
  readonly l1Signature: string;
  readonly messageToSign: string;
  readonly secret: LighterTradingSecretMaterial;
}

export interface LighterChangePubKeySignerResult {
  readonly kind: "lighter_change_pub_key_signer_result";
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly publicKey: string;
  readonly expectedL1Address: string;
  readonly messageToSign: string;
  readonly txType: typeof LIGHTER_TX_TYPE_L2_CHANGE_PUB_KEY;
  readonly txInfo: string;
  readonly txHash: string;
}

/**
 * Privileged registration-only signer surface. Kept separate from the order
 * adapter so key-registration signing cannot become available to agent-facing
 * order dependencies by accident.
 */
export interface LighterChangePubKeySignerAdapter {
  readonly source: "official_lighter_signer";
  readonly signChangePubKey: (
    input: LighterChangePubKeySigningInput,
  ) => Promise<LighterChangePubKeySignerResult>;
}

export function buildLighterChangePubKeySignatureBody(input: {
  readonly publicKey: string;
  readonly nonce: string;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
}): string {
  const publicKey = normalizePublicKey(input.publicKey);
  const nonce = requireDecimalInteger("nonce", input.nonce, LIGHTER_SIGNER_UINT48_MAX, true);
  const accountIndex = requireSafePositiveInteger("accountIndex", input.accountIndex);
  const apiKeyIndex = requireApiKeyIndex(input.apiKeyIndex);
  const values = [
    publicKey,
    fixedWidthUint64Hex(BigInt(nonce)),
    fixedWidthUint64Hex(BigInt(accountIndex)),
    fixedWidthUint64Hex(BigInt(apiKeyIndex)),
  ];
  let message = LIGHTER_CHANGE_PUB_KEY_SIGNATURE_TEMPLATE as string;
  for (const value of values) message = message.replace("%s", value);
  if (message.includes("%s")) {
    throw invalidRequest("Lighter change-public-key signature template is incomplete.");
  }
  return message;
}

export function buildLighterChangePubKeySigningInput(input: {
  readonly environment?: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly publicKey: string;
  readonly expectedL1Address: string;
  readonly l1Signature: string;
  readonly secret: LighterTradingSecretMaterial;
}): LighterChangePubKeySigningInput {
  const environment = input.environment ?? "core";
  const accountIndex = requireSafePositiveInteger("accountIndex", input.accountIndex);
  const apiKeyIndex = requireApiKeyIndex(input.apiKeyIndex);
  const nonce = requireDecimalInteger("nonce", input.nonce, LIGHTER_SIGNER_UINT48_MAX, true);
  const expiredAt = requireDecimalInteger("expiredAt", input.expiredAt, INT64_MAX, false);
  const publicKey = normalizePublicKey(input.publicKey);
  const expectedL1Address = getAddress(input.expectedL1Address);
  const l1Signature = normalizeL1Signature(input.l1Signature);
  const signingInput = {
    kind: "lighter_change_pub_key_signing_input",
    environment,
    chainId: LIGHTER_SIGNER_CHAIN_IDS[environment],
    accountIndex,
    apiKeyIndex,
    nonce,
    expiredAt,
    publicKey,
    expectedL1Address,
    messageToSign: buildLighterChangePubKeySignatureBody({
      publicKey,
      nonce,
      accountIndex,
      apiKeyIndex,
    }),
    secret: input.secret,
  } as Omit<LighterChangePubKeySigningInput, "l1Signature">;
  return Object.defineProperty(signingInput, "l1Signature", {
    value: l1Signature,
    enumerable: false,
  }) as LighterChangePubKeySigningInput;
}

export async function signLighterChangePubKeyWithAdapter(
  input: LighterChangePubKeySigningInput,
  adapter: LighterChangePubKeySignerAdapter,
): Promise<LighterChangePubKeySignerResult> {
  if (adapter.source !== "official_lighter_signer") {
    throw invalidSigner("Lighter key registration requires the official packaged signer helper.");
  }
  const result = await adapter.signChangePubKey(input);
  if (
    result.kind !== "lighter_change_pub_key_signer_result"
    || result.environment !== input.environment
    || result.accountIndex !== input.accountIndex
    || result.apiKeyIndex !== input.apiKeyIndex
    || result.nonce !== input.nonce
    || result.expiredAt !== input.expiredAt
    || result.publicKey !== input.publicKey
    || result.expectedL1Address !== input.expectedL1Address
    || result.messageToSign !== input.messageToSign
    || result.txType !== LIGHTER_TX_TYPE_L2_CHANGE_PUB_KEY
  ) {
    throw invalidSigner("Lighter key-registration signer result does not match the approved scope.");
  }
  assertTxInfoMatchesInput(result.txInfo, input);
  if (!/^[0-9a-f]{80}$/.test(result.txHash)) {
    throw invalidSigner("Lighter key-registration signer returned an invalid transaction hash.");
  }
  const safeResult = { ...result };
  return Object.defineProperty(safeResult, "txInfo", {
    value: result.txInfo,
    enumerable: false,
  });
}

function assertTxInfoMatchesInput(
  txInfo: string,
  input: LighterChangePubKeySigningInput,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(txInfo) as unknown;
  } catch {
    throw invalidSigner("Lighter key-registration signer returned malformed transaction info.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidSigner("Lighter key-registration signer returned malformed transaction info.");
  }
  const tx = parsed as Record<string, unknown>;
  const expectedPublicKeyBase64 = Buffer.from(input.publicKey, "hex").toString("base64");
  if (
    Object.keys(tx).sort().join(",")
      !== [
        "AccountIndex",
        "ApiKeyIndex",
        "ExpiredAt",
        "L1Sig",
        "L2TxAttributes",
        "Nonce",
        "PubKey",
        "Sig",
      ].sort().join(",")
    || tx.AccountIndex !== input.accountIndex
    || tx.ApiKeyIndex !== input.apiKeyIndex
    || tx.PubKey !== expectedPublicKeyBase64
    || tx.L1Sig !== input.l1Signature
    || tx.ExpiredAt !== Number(input.expiredAt)
    || tx.Nonce !== Number(input.nonce)
    || tx.L2TxAttributes !== null
    || typeof tx.Sig !== "string"
    || !/^[A-Za-z0-9+/]{107}=$/.test(tx.Sig)
  ) {
    throw invalidSigner("Lighter key-registration transaction info does not match the approved scope.");
  }
}

function fixedWidthUint64Hex(value: bigint): string {
  if (value < 0n || value > UINT64_MAX) {
    throw invalidRequest("Lighter signature field is outside the official uint64 range.");
  }
  return `0x${value.toString(16).padStart(16, "0")}`;
}

function normalizePublicKey(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{80}$/.test(normalized)) {
    throw invalidRequest("publicKey must be the canonical 40-byte Lighter public key.");
  }
  return normalized;
}

function normalizeL1Signature(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{130}$/.test(normalized)) {
    throw invalidRequest("l1Signature must be a canonical 65-byte EIP-191 signature.");
  }
  const recovery = normalized.slice(-2);
  if (!new Set(["00", "01", "1b", "1c"]).has(recovery)) {
    throw invalidRequest("l1Signature has an unsupported recovery value.");
  }
  return normalized;
}

function requireSafePositiveInteger(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidRequest(`${field} must be a positive safe integer.`);
  }
  return value;
}

function requireApiKeyIndex(value: number): number {
  if (!Number.isInteger(value) || value < 4 || value > 254) {
    throw invalidRequest("apiKeyIndex must be an available user slot from 4 through 254.");
  }
  return value;
}

function requireDecimalInteger(
  field: string,
  value: string,
  max: bigint,
  allowZero: boolean,
): string {
  const normalized = value.trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) {
    throw invalidRequest(`${field} must be a canonical decimal integer.`);
  }
  const parsed = BigInt(normalized);
  if (parsed > max || (!allowZero && parsed === 0n)) {
    throw invalidRequest(`${field} is outside the official Lighter signer range.`);
  }
  return parsed.toString();
}

function invalidRequest(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Prepare a fresh Lighter key-registration approval before signing again.",
  );
}

function invalidSigner(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Do not submit the key registration; reconcile the approved intent and packaged signer helper.",
  );
}
