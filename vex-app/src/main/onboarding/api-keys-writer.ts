/**
 * API keys writer (M9 Step 3).
 *
 * Writes API/provider secrets into the encrypted local secret vault.
 * `.env` is intentionally not used for any API key.
 *
 * Logging: only the canonical key NAMES being written get logged.
 * NEVER the value, the length, or any prefix/suffix preview. The
 * envelope returned to the renderer carries `fieldsWritten` in
 * canonical order so UI can render "Set: JUPITER_API_KEY, ..."
 * without secrets crossing the boundary.
 */

import { ok, type Result } from "@shared/ipc/result.js";
import { err } from "@shared/ipc/result.js";
import {
  MANAGED_API_KEYS_CANONICAL_ORDER,
  type ApiKeysSetInput,
  type ApiKeysSetResult,
} from "@shared/schemas/api-keys.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import {
  defaultLighterTradingVaultCredentialId,
  type LighterTradingCredentialVaultReference,
} from "@tools/lighter/trading-credentials.js";
import { log } from "../logger/index.js";
import { writeUnlockedSecrets } from "../secrets/session.js";
import {
  deleteUnlockedLighterTradingApiPrivateKey,
  getUnlockedLighterTradingCredentialRegistrationState,
  writeUnlockedLighterTradingApiPrivateKey,
} from "../secrets/lighter-trading-credential.js";

export interface ApiKeysWriterOptions {
  /** Override `ENV_FILE` for tests; production callers omit. */
  readonly envFile?: string;
  /** Live chain probe override for tests. Production callers omit. */
  readonly probeRobinhoodChainRpc?: (endpoint: string) => Promise<void>;
}

type ManagedApiKey = (typeof MANAGED_API_KEYS_CANONICAL_ORDER)[number];

const API_KEYS_WRITER_CORRELATION_ID = "api-keys-writer";
type TradingFieldName =
  | "LIGHTER_CORE_TRADING_API_PRIVATE_KEY"
  | "LIGHTER_RHC_TRADING_API_PRIVATE_KEY";

function invalidTradingInput(message: string): Result<never> {
  return err({
    code: "provider.invalid_api_key",
    domain: "onboarding",
    message,
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId: API_KEYS_WRITER_CORRELATION_ID,
  });
}

const ROBINHOOD_PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const ROBINHOOD_CHAIN_ID = 4_663;
const RPC_TIMEOUT_MS = 8_000;
const MAX_BLOCK_AGE_SECONDS = 5 * 60;
const MAX_RPC_RESPONSE_BYTES = 64 * 1_024;

function invalidRpcInput(message: string): Result<never> {
  return err({
    code: "provider.invalid_api_key",
    domain: "onboarding",
    message,
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId: API_KEYS_WRITER_CORRELATION_ID,
  });
}

interface JsonRpcEnvelope {
  readonly result?: unknown;
  readonly error?: unknown;
}

async function rpcCall(
  endpoint: string,
  method: string,
  params: readonly unknown[],
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("rpc_http_error");
  const rawBody = await response.text();
  if (rawBody.length > MAX_RPC_RESPONSE_BYTES) {
    throw new Error("rpc_response_too_large");
  }
  const body = JSON.parse(rawBody) as JsonRpcEnvelope;
  if (body.error !== undefined || body.result === undefined) {
    throw new Error("rpc_response_error");
  }
  return body.result;
}

function parseHexInteger(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error("rpc_invalid_quantity");
  }
  return BigInt(value);
}

export async function probeRobinhoodChainRpc(endpoint: string): Promise<void> {
  const [chainId, latestBlock, feeHistory] = await Promise.all([
    rpcCall(endpoint, "eth_chainId", []),
    rpcCall(endpoint, "eth_getBlockByNumber", ["latest", false]),
    rpcCall(endpoint, "eth_feeHistory", ["0x2", "latest", [50]]),
  ]);
  if (parseHexInteger(chainId) !== BigInt(ROBINHOOD_CHAIN_ID)) {
    throw new Error("rpc_wrong_chain");
  }
  if (latestBlock === null || typeof latestBlock !== "object") {
    throw new Error("rpc_missing_block");
  }
  parseHexInteger((latestBlock as { readonly number?: unknown }).number);
  const timestamp = parseHexInteger(
    (latestBlock as { readonly timestamp?: unknown }).timestamp,
  );
  const nowSeconds = BigInt(Math.floor(Date.now() / 1_000));
  if (
    timestamp > nowSeconds + 60n
    || nowSeconds - timestamp > BigInt(MAX_BLOCK_AGE_SECONDS)
  ) {
    throw new Error("rpc_stale_block");
  }
  if (feeHistory === null || typeof feeHistory !== "object") {
    throw new Error("rpc_fee_history_unavailable");
  }
  parseHexInteger(
    (feeHistory as { readonly oldestBlock?: unknown }).oldestBlock,
  );
  const baseFees =
    (feeHistory as { readonly baseFeePerGas?: unknown }).baseFeePerGas;
  if (!Array.isArray(baseFees) || baseFees.length < 2) {
    throw new Error("rpc_fee_history_unavailable");
  }
  for (const fee of baseFees) parseHexInteger(fee);
}

function isBundledPublicRobinhoodRpc(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname.toLowerCase()
      === new URL(ROBINHOOD_PUBLIC_RPC).hostname.toLowerCase();
  } catch {
    return false;
  }
}

function tradingReference(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
}): LighterTradingCredentialVaultReference {
  return {
    kind: "encrypted_vault_reference",
    environment: input.environment,
    accountIndex: input.accountIndex,
    apiKeyIndex: input.apiKeyIndex,
    vaultCredentialId: defaultLighterTradingVaultCredentialId(input),
  };
}

function readTradingCredentialAction(
  input: ApiKeysSetInput,
  environment: LighterEnvironment,
): Result<{
  readonly action:
    | null
    | {
        readonly field: TradingFieldName;
        readonly reference: LighterTradingCredentialVaultReference;
        readonly privateKey: string | null;
      };
}> {
  const accountKey = environment === "core"
    ? "lighterCoreTradingAccountIndex"
    : "lighterRhcTradingAccountIndex";
  const apiKeyKey = environment === "core"
    ? "lighterCoreTradingApiKeyIndex"
    : "lighterRhcTradingApiKeyIndex";
  const privateKeyKey = environment === "core"
    ? "lighterCoreTradingApiPrivateKey"
    : "lighterRhcTradingApiPrivateKey";
  const removeKey = environment === "core"
    ? "lighterCoreTradingRemove"
    : "lighterRhcTradingRemove";
  const field = environment === "core"
    ? "LIGHTER_CORE_TRADING_API_PRIVATE_KEY"
    : "LIGHTER_RHC_TRADING_API_PRIVATE_KEY";
  const accountIndex = input[accountKey];
  const apiKeyIndex = input[apiKeyKey];
  const privateKey = input[privateKeyKey];
  const remove = input[removeKey] === true;
  const hasPrivateKey = privateKey !== undefined && privateKey.trim().length > 0;

  if (!remove && !hasPrivateKey) return ok({ action: null });
  if (remove && hasPrivateKey) {
    return invalidTradingInput(
      `Choose either remove or replace for the Lighter ${environment.toUpperCase()} trading credential, not both.`,
    );
  }
  if (
    accountIndex === undefined
    || apiKeyIndex === undefined
  ) {
    return invalidTradingInput(
      `Lighter ${environment.toUpperCase()} trading credential changes require account index and API-key index.`,
    );
  }

  return {
    ok: true,
    data: {
      action: {
        field,
        reference: tradingReference({ environment, accountIndex, apiKeyIndex }),
        privateKey: remove ? null : privateKey!.trim(),
      },
    },
  };
}

export async function writeApiKeys(
  input: ApiKeysSetInput,
  options: ApiKeysWriterOptions = {},
): Promise<Result<ApiKeysSetResult>> {
  const robinhoodRpc = input.robinhoodChainRpcUrl?.trim();
  if (robinhoodRpc !== undefined) {
    if (isBundledPublicRobinhoodRpc(robinhoodRpc)) {
      return invalidRpcInput(
        "The bundled Robinhood Chain public RPC is rate-limited and cannot be saved as the production endpoint. Use a managed mainnet endpoint.",
      );
    }
    try {
      await (options.probeRobinhoodChainRpc ?? probeRobinhoodChainRpc)(
        robinhoodRpc,
      );
    } catch {
      return invalidRpcInput(
        "Vex could not verify that endpoint as a fresh Robinhood Chain mainnet RPC with fee-history support. Check the managed endpoint and try again.",
      );
    }
  }
  // Build the write plan in canonical order so fieldsWritten is
  // deterministic regardless of object iteration order.
  const writes: Array<{ key: ManagedApiKey; value: string }> = [];
  if (input.jupiterApiKey !== undefined) {
    writes.push({ key: "JUPITER_API_KEY", value: input.jupiterApiKey });
  }
  if (input.tavilyApiKey !== undefined) {
    writes.push({ key: "TAVILY_API_KEY", value: input.tavilyApiKey });
  }
  if (input.rettiwtApiKey !== undefined) {
    writes.push({ key: "RETTIWT_API_KEY", value: input.rettiwtApiKey });
  }
  if (input.relayApiKey !== undefined) {
    writes.push({ key: "RELAY_API_KEY", value: input.relayApiKey });
  }
  if (robinhoodRpc !== undefined) {
    writes.push({ key: "ROBINHOOD_CHAIN_RPC_URL", value: robinhoodRpc });
  }
  const coreTrading = readTradingCredentialAction(input, "core");
  if (!coreTrading.ok) return coreTrading;
  const rhcTrading = readTradingCredentialAction(input, "rhc");
  if (!rhcTrading.ok) return rhcTrading;
  const tradingActions = [
    coreTrading.data.action,
    rhcTrading.data.action,
  ].filter((action): action is NonNullable<typeof action> => action !== null);

  for (const action of tradingActions) {
    const registrationState =
      getUnlockedLighterTradingCredentialRegistrationState(action.reference);
    if (registrationState !== null) {
      return invalidTradingInput(
        `Vex manages the registered Lighter ${action.reference.environment.toUpperCase()} credential for account ${action.reference.accountIndex}, API-key index ${action.reference.apiKeyIndex}. Manual replacement or removal is disabled because it would orphan the registered key.`,
      );
    }
  }

  if (writes.length === 0 && tradingActions.length === 0) {
    // Nothing to write — empty submission is a legal Continue.
    return ok({ fieldsWritten: [] });
  }

  const fieldsWritten: ApiKeysSetResult["fieldsWritten"][number][] = [];
  const updates: Partial<Record<ManagedApiKey, string>> = {};
  for (const w of writes) {
    updates[w.key] = w.value;
    fieldsWritten.push(w.key);
  }

  if (writes.length > 0) {
    const writeResult = writeUnlockedSecrets(updates);
    if (!writeResult.ok) return writeResult;
  }

  for (const action of tradingActions) {
    if (action.privateKey === null) {
      deleteUnlockedLighterTradingApiPrivateKey(action.reference);
    } else {
      writeUnlockedLighterTradingApiPrivateKey(
        action.reference,
        action.privateKey,
      );
    }
    fieldsWritten.push(action.field);
  }

  log.info(
    `[api-keys-writer] persisted vault keys=${fieldsWritten.join(",")}`
  );
  return ok({ fieldsWritten });
}
