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
  writeUnlockedLighterTradingApiPrivateKey,
} from "../secrets/lighter-trading-credential.js";

export interface ApiKeysWriterOptions {
  /** Override `ENV_FILE` for tests; production callers omit. */
  readonly envFile?: string;
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
  _options: ApiKeysWriterOptions = {},
): Promise<Result<ApiKeysSetResult>> {
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
  const coreTrading = readTradingCredentialAction(input, "core");
  if (!coreTrading.ok) return coreTrading;
  const rhcTrading = readTradingCredentialAction(input, "rhc");
  if (!rhcTrading.ok) return rhcTrading;
  const tradingActions = [
    coreTrading.data.action,
    rhcTrading.data.action,
  ].filter((action): action is NonNullable<typeof action> => action !== null);

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
