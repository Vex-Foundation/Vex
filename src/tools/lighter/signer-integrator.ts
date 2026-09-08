import { getAddress } from "viem";
import { ErrorCodes, VexError } from "../../errors.js";
import type { LighterEnvironment } from "./constants.js";
import { LIGHTER_SIGNER_CHAIN_IDS } from "./signer-adapter.js";
import type { LighterTradingSecretMaterial } from "./trading-secret.js";

export const LIGHTER_TX_TYPE_APPROVE_INTEGRATOR = 45;
const MAX_UINT48 = 2 ** 48 - 1;

export interface LighterApproveIntegratorTerms {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly nonce: string;
  readonly expiredAt: string;
  readonly integratorAccountIndex: number;
  readonly maxPerpsMakerFee: number;
  readonly maxPerpsTakerFee: number;
  readonly maxSpotMakerFee: number;
  readonly maxSpotTakerFee: number;
  /** Provider permission expiry, in milliseconds; zero revokes permission. */
  readonly approvalExpiry: number;
}

export interface LighterApproveIntegratorSigningInput extends LighterApproveIntegratorTerms {
  readonly kind: "lighter_approve_integrator_signing_input";
  readonly chainId: number;
  readonly expectedL1Address: string;
  readonly l1Signature: string;
  readonly messageToSign: string;
  readonly secret: LighterTradingSecretMaterial;
}

export interface LighterApproveIntegratorSignerResult extends LighterApproveIntegratorTerms {
  readonly kind: "lighter_approve_integrator_signer_result";
  readonly expectedL1Address: string;
  readonly messageToSign: string;
  readonly txType: typeof LIGHTER_TX_TYPE_APPROVE_INTEGRATOR;
  readonly txInfo: string;
  readonly txHash: string;
}

export interface LighterApproveIntegratorSignerAdapter {
  readonly source: "official_lighter_signer";
  readonly signApproveIntegrator: (input: LighterApproveIntegratorSigningInput) => Promise<LighterApproveIntegratorSignerResult>;
}

/** Matches lighter-go v1.0.7 GetL1SignatureBody, including the deployment chain. */
export function buildLighterApproveIntegratorSignatureBody(input: LighterApproveIntegratorTerms): string {
  assertTerms(input);
  const hex = (value: number | string) => `0x${BigInt(value).toString(16).padStart(16, "0")}`;
  return ["Approve Integrator", "", `nonce: ${hex(input.nonce)}`, `account index: ${hex(input.accountIndex)}`,
    `api key index: ${hex(input.apiKeyIndex)}`, `integrator account index: ${hex(input.integratorAccountIndex)}`,
    `max perps taker fee: ${hex(input.maxPerpsTakerFee)}`, `max perps maker fee: ${hex(input.maxPerpsMakerFee)}`,
    `max spot taker fee: ${hex(input.maxSpotTakerFee)}`, `max spot maker fee: ${hex(input.maxSpotMakerFee)}`,
    `approval expiry: ${hex(input.approvalExpiry)}`, `chainId: ${hex(LIGHTER_SIGNER_CHAIN_IDS[input.environment])}`,
    "Only sign this message for a trusted client!"].join("\n");
}

export function buildLighterApproveIntegratorSigningInput(input: LighterApproveIntegratorTerms & {
  readonly expectedL1Address: string;
  readonly l1Signature: string;
  readonly secret: LighterTradingSecretMaterial;
}): LighterApproveIntegratorSigningInput {
  const messageToSign = buildLighterApproveIntegratorSignatureBody(input);
  const revoking = input.approvalExpiry === 0;
  const l1Signature = input.l1Signature.toLowerCase();
  if ((!revoking || l1Signature !== "") && !/^0x[0-9a-f]{128}(00|01|1b|1c)$/.test(l1Signature)) {
    throw invalid("Lighter fee authorization requires a valid local wallet signature.");
  }
  const { l1Signature: _signature, ...rest } = input;
  const result = { ...rest, kind: "lighter_approve_integrator_signing_input" as const,
    chainId: LIGHTER_SIGNER_CHAIN_IDS[input.environment], expectedL1Address: getAddress(input.expectedL1Address), messageToSign };
  return Object.defineProperty(result, "l1Signature", { value: l1Signature, enumerable: false }) as LighterApproveIntegratorSigningInput;
}

export async function signLighterApproveIntegratorWithAdapter(input: LighterApproveIntegratorSigningInput,
  adapter: LighterApproveIntegratorSignerAdapter): Promise<LighterApproveIntegratorSignerResult> {
  if (adapter.source !== "official_lighter_signer") throw invalidSigner("Lighter fee authorization requires the official packaged signer.");
  if (buildLighterApproveIntegratorSignatureBody(input) !== input.messageToSign || input.chainId !== LIGHTER_SIGNER_CHAIN_IDS[input.environment]) {
    throw invalidSigner("Lighter fee authorization signing input changed after approval.");
  }
  const result = await adapter.signApproveIntegrator(input);
  const scope: readonly (keyof LighterApproveIntegratorTerms)[] = ["environment", "accountIndex", "apiKeyIndex", "nonce", "expiredAt", "integratorAccountIndex",
    "maxPerpsMakerFee", "maxPerpsTakerFee", "maxSpotMakerFee", "maxSpotTakerFee", "approvalExpiry"];
  if (result.kind !== "lighter_approve_integrator_signer_result" || scope.some((key) => result[key] !== input[key])
    || result.expectedL1Address !== input.expectedL1Address || result.messageToSign !== input.messageToSign
    || result.txType !== LIGHTER_TX_TYPE_APPROVE_INTEGRATOR || !/^[0-9a-f]{80}$/.test(result.txHash)) {
    throw invalidSigner("Lighter fee authorization signer result does not match the approved terms.");
  }
  let tx: Record<string, unknown>;
  try { tx = JSON.parse(result.txInfo) as Record<string, unknown>; } catch { throw invalidSigner("Malformed Lighter fee authorization transaction."); }
  const expected = { AccountIndex: input.accountIndex, ApiKeyIndex: input.apiKeyIndex,
    IntegratorAccountIndex: input.integratorAccountIndex, MaxPerpsMakerFee: input.maxPerpsMakerFee, MaxPerpsTakerFee: input.maxPerpsTakerFee,
    MaxSpotMakerFee: input.maxSpotMakerFee, MaxSpotTakerFee: input.maxSpotTakerFee, ApprovalExpiry: input.approvalExpiry,
    ExpiredAt: Number(input.expiredAt), Nonce: Number(input.nonce), L1Sig: input.l1Signature, L2TxAttributes: null };
  if (!tx || typeof tx !== "object" || Object.keys(tx).sort().join() !== [...Object.keys(expected), "Sig"].sort().join()
    || Object.entries(expected).some(([key, value]) => tx[key] !== value)
    || typeof tx.Sig !== "string" || !/^[A-Za-z0-9+/]{107}=$/.test(tx.Sig)) {
    throw invalidSigner("Signed Lighter fee authorization differs from the approved terms.");
  }
  const { txInfo, ...safe } = result;
  return Object.defineProperty(safe, "txInfo", { value: txInfo, enumerable: false }) as LighterApproveIntegratorSignerResult;
}

function assertTerms(input: LighterApproveIntegratorTerms): void {
  if (input.environment !== "core" && input.environment !== "rhc") throw invalid("Unknown Lighter fee environment.");
  for (const index of [input.accountIndex, input.integratorAccountIndex]) {
    if (!Number.isSafeInteger(index) || index < 1 || index >= MAX_UINT48) throw invalid("Invalid Lighter fee account index.");
  }
  if (!Number.isInteger(input.apiKeyIndex) || input.apiKeyIndex < 4 || input.apiKeyIndex > 254) throw invalid("Invalid Lighter trading key slot.");
  for (const [name, value] of [["nonce", input.nonce], ["expiredAt", input.expiredAt]] as const) {
    if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > BigInt(MAX_UINT48) || (name === "expiredAt" && value === "0")) throw invalid(`Invalid Lighter fee ${name}.`);
  }
  const caps = [input.maxPerpsMakerFee, input.maxPerpsTakerFee, input.maxSpotMakerFee, input.maxSpotTakerFee];
  if (caps.some((cap) => !Number.isInteger(cap) || cap < 0 || cap > 1_000_000)
    || !Number.isSafeInteger(input.approvalExpiry) || input.approvalExpiry < 0 || input.approvalExpiry > MAX_UINT48
    || (input.approvalExpiry === 0 && caps.some((cap) => cap !== 0))) throw invalid("Invalid Lighter fee caps or permission expiry.");
}

function invalid(message: string) { return new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST, message); }
function invalidSigner(message: string) { return new VexError(ErrorCodes.LIGHTER_INVALID_REQUEST, message); }
