import { VexError } from "../../errors.js";
import {
  BlockscoutErrorCodes,
  blockscoutError,
  isBlockscoutError,
} from "./errors.js";
import {
  buildRobinhoodTokenBalancesUrl,
  isExactRobinhoodTokenBalancesUrl,
  ROBINHOOD_CHAIN_ID,
  validateBlockscoutAddress,
} from "./operation.js";
import {
  getBlockscoutTransport,
  type BlockscoutTransport,
  type BlockscoutTransportResponse,
} from "./transport.js";
import {
  BLOCKSCOUT_MAX_TOKEN_ROWS,
  type BlockscoutErc20IdentityCandidate,
  type BlockscoutInvalidReasonCount,
  type BlockscoutTypeCount,
  validateBlockscoutTokenBalances,
} from "./validation.js";

export const BLOCKSCOUT_TOKEN_BALANCES_MAX_BYTES = 512 * 1024;
export const BLOCKSCOUT_TOKEN_BALANCES_TIMEOUT_MS = 15_000;

export type BlockscoutInventoryIncompleteReason =
  | "unavailable"
  | "over_cap"
  | "invalid_response";

interface BlockscoutInventoryCommon {
  readonly source: "blockscout";
  readonly chainId: typeof ROBINHOOD_CHAIN_ID;
  readonly inventoryScope: "erc20";
  readonly maxResponseBytes: typeof BLOCKSCOUT_TOKEN_BALANCES_MAX_BYTES;
  readonly maxProviderRows: typeof BLOCKSCOUT_MAX_TOKEN_ROWS;
  readonly transport: BlockscoutTransport["name"] | null;
  readonly candidates: readonly BlockscoutErc20IdentityCandidate[];
  readonly providerRowCount: number | null;
  readonly responseBytes: number | null;
  readonly typeCensus: readonly BlockscoutTypeCount[];
  readonly omittedNonErc20Count: number | null;
  readonly invalidRowCount: number | null;
  readonly invalidReasonCounts: readonly BlockscoutInvalidReasonCount[];
  readonly unprocessedContractAddresses: readonly string[];
}

export type BlockscoutInventoryResult =
  | (BlockscoutInventoryCommon & {
      readonly status: "complete";
      readonly inventoryComplete: true;
    })
  | (BlockscoutInventoryCommon & {
      readonly status: "incomplete";
      readonly inventoryComplete: false;
      readonly incompleteReason: BlockscoutInventoryIncompleteReason;
      readonly errorCode: string;
    });

export interface BlockscoutInventoryOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function noRowsIncomplete(
  reason: BlockscoutInventoryIncompleteReason,
  errorCode: string,
  transport: BlockscoutTransport["name"] | null,
  responseBytes: number | null = null,
): BlockscoutInventoryResult {
  return {
    status: "incomplete",
    inventoryComplete: false,
    incompleteReason: reason,
    errorCode,
    source: "blockscout",
    chainId: ROBINHOOD_CHAIN_ID,
    inventoryScope: "erc20",
    maxResponseBytes: BLOCKSCOUT_TOKEN_BALANCES_MAX_BYTES,
    maxProviderRows: BLOCKSCOUT_MAX_TOKEN_ROWS,
    transport,
    candidates: [],
    providerRowCount: null,
    responseBytes,
    typeCensus: [],
    omittedNonErc20Count: null,
    invalidRowCount: null,
    invalidReasonCounts: [],
    unprocessedContractAddresses: [],
  };
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw blockscoutError(
      BlockscoutErrorCodes.TRANSPORT_FAILED,
      "The Blockscout request deadline is outside the supported range",
      "Use a whole-millisecond deadline between 1 and 60000.",
    );
  }
}

function assertResponseContract(response: BlockscoutTransportResponse): void {
  if (response.body.byteLength > BLOCKSCOUT_TOKEN_BALANCES_MAX_BYTES) {
    throw blockscoutError(
      BlockscoutErrorCodes.RESPONSE_OVER_CAP,
      "The Blockscout response exceeded the inventory byte limit",
      "No partial response was accepted. Keep the previous inventory and mark it incomplete.",
    );
  }

  if (response.status === 403 || response.status === 429 || response.status >= 500) {
    throw blockscoutError(
      BlockscoutErrorCodes.PROVIDER_UNAVAILABLE,
      `Blockscout inventory is unavailable with HTTP status ${response.status}`,
      "Keep the previous inventory and retry later. This response is not evidence of an empty wallet.",
      { retryable: true, httpStatus: response.status },
    );
  }

  if (response.status !== 200) {
    throw blockscoutError(
      BlockscoutErrorCodes.PROVIDER_REFUSED,
      `Blockscout refused the inventory request with HTTP status ${response.status}`,
      "Check the request contract. An unchanged retry is not evidence of an empty wallet.",
      { retryable: false, httpStatus: response.status },
    );
  }

  const mediaType = response.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw blockscoutError(
      BlockscoutErrorCodes.CONTENT_TYPE_INVALID,
      "Blockscout returned a non-JSON inventory response",
      "Treat the provider as unavailable or changed. Do not interpret the body as an empty inventory.",
      { retryable: true, httpStatus: response.status },
    );
  }
}

function parseJsonBody(body: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw blockscoutError(
      BlockscoutErrorCodes.RESPONSE_INVALID,
      "Blockscout returned inventory bytes that are not valid UTF-8",
      "Keep the previous inventory and mark this source incomplete.",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw blockscoutError(
      BlockscoutErrorCodes.RESPONSE_INVALID,
      "Blockscout returned an inventory body that is not valid JSON",
      "Keep the previous inventory and mark this source incomplete.",
    );
  }
}

function mapTypedFailure(
  error: VexError,
  transport: BlockscoutTransport["name"] | null,
): BlockscoutInventoryResult {
  switch (error.code) {
    case BlockscoutErrorCodes.RESPONSE_OVER_CAP:
      return noRowsIncomplete("over_cap", error.code, transport);
    case BlockscoutErrorCodes.TRANSPORT_UNAVAILABLE:
    case BlockscoutErrorCodes.TRANSPORT_TIMEOUT:
    case BlockscoutErrorCodes.TRANSPORT_FAILED:
    case BlockscoutErrorCodes.REDIRECT_REFUSED:
    case BlockscoutErrorCodes.PROVIDER_UNAVAILABLE:
      return noRowsIncomplete("unavailable", error.code, transport);
    case BlockscoutErrorCodes.PROVIDER_REFUSED:
    case BlockscoutErrorCodes.CONTENT_TYPE_INVALID:
    case BlockscoutErrorCodes.RESPONSE_INVALID:
      return noRowsIncomplete("invalid_response", error.code, transport);
    default:
      throw error;
  }
}

/**
 * Enumerate Robinhood ERC-20 identity candidates from Blockscout.
 *
 * This read never makes Blockscout authoritative for balances, decimals,
 * symbols, prices, or signing. WP6b must re-read each candidate from RPC.
 */
export async function readRobinhoodErc20IdentityCandidates(
  address: string,
  options: BlockscoutInventoryOptions = {},
): Promise<BlockscoutInventoryResult> {
  validateBlockscoutAddress(address);
  const timeoutMs = options.timeoutMs ?? BLOCKSCOUT_TOKEN_BALANCES_TIMEOUT_MS;
  validateTimeout(timeoutMs);

  let transport: BlockscoutTransport | null = null;
  try {
    transport = getBlockscoutTransport();
    const requestedUrl = buildRobinhoodTokenBalancesUrl(address);
    const response = await transport.fetchAddressTokenBalances(address, {
      timeoutMs,
      signal: options.signal,
      maxBytes: BLOCKSCOUT_TOKEN_BALANCES_MAX_BYTES,
    });

    if (!isExactRobinhoodTokenBalancesUrl(response.finalUrl, requestedUrl)) {
      throw blockscoutError(
        BlockscoutErrorCodes.REDIRECT_REFUSED,
        "The Blockscout response came from an unexpected URL",
        "No response bytes were accepted. Inspect the provider or network redirect policy.",
      );
    }

    assertResponseContract(response);
    const validation = validateBlockscoutTokenBalances(
      parseJsonBody(response.body),
      BLOCKSCOUT_MAX_TOKEN_ROWS,
    );

    if (validation.status === "invalid_document") {
      return noRowsIncomplete(
        "invalid_response",
        BlockscoutErrorCodes.RESPONSE_INVALID,
        transport.name,
        response.body.byteLength,
      );
    }
    if (validation.status === "over_cap") {
      return {
        ...noRowsIncomplete(
          "over_cap",
          BlockscoutErrorCodes.RESPONSE_OVER_CAP,
          transport.name,
          response.body.byteLength,
        ),
        providerRowCount: validation.providerRowCount,
      };
    }

    const facts: BlockscoutInventoryCommon = {
      source: "blockscout",
      chainId: ROBINHOOD_CHAIN_ID,
      inventoryScope: "erc20",
      maxResponseBytes: BLOCKSCOUT_TOKEN_BALANCES_MAX_BYTES,
      maxProviderRows: BLOCKSCOUT_MAX_TOKEN_ROWS,
      transport: transport.name,
      candidates: validation.rows,
      providerRowCount: validation.providerRowCount,
      responseBytes: response.body.byteLength,
      typeCensus: validation.typeCensus,
      omittedNonErc20Count: validation.omittedNonErc20Count,
      invalidRowCount: validation.invalidRowCount,
      invalidReasonCounts: validation.invalidReasonCounts,
      unprocessedContractAddresses: validation.unprocessedContractAddresses,
    };
    if (validation.status === "partial") {
      return {
        ...facts,
        status: "incomplete",
        inventoryComplete: false,
        incompleteReason: "invalid_response",
        errorCode: BlockscoutErrorCodes.RESPONSE_INVALID,
      };
    }
    return { ...facts, status: "complete", inventoryComplete: true };
  } catch (error) {
    if (
      isBlockscoutError(error) &&
      error.code === BlockscoutErrorCodes.TRANSPORT_CANCELLED
    ) {
      throw error;
    }
    if (isBlockscoutError(error)) {
      return mapTypedFailure(error, transport?.name ?? null);
    }
    throw error;
  }
}
