import { VexError } from "../../errors.js";

/** Stable failures owned by the Robinhood Blockscout inventory seam. */
export const BlockscoutErrorCodes = {
  ADDRESS_INVALID: "BLOCKSCOUT_ADDRESS_INVALID",
  TRANSPORT_UNAVAILABLE: "BLOCKSCOUT_TRANSPORT_UNAVAILABLE",
  TRANSPORT_ALREADY_REGISTERED: "BLOCKSCOUT_TRANSPORT_ALREADY_REGISTERED",
  TRANSPORT_CANCELLED: "BLOCKSCOUT_TRANSPORT_CANCELLED",
  TRANSPORT_TIMEOUT: "BLOCKSCOUT_TRANSPORT_TIMEOUT",
  TRANSPORT_FAILED: "BLOCKSCOUT_TRANSPORT_FAILED",
  REDIRECT_REFUSED: "BLOCKSCOUT_REDIRECT_REFUSED",
  RESPONSE_OVER_CAP: "BLOCKSCOUT_RESPONSE_OVER_CAP",
  PROVIDER_UNAVAILABLE: "BLOCKSCOUT_PROVIDER_UNAVAILABLE",
  PROVIDER_REFUSED: "BLOCKSCOUT_PROVIDER_REFUSED",
  CONTENT_TYPE_INVALID: "BLOCKSCOUT_CONTENT_TYPE_INVALID",
  RESPONSE_INVALID: "BLOCKSCOUT_RESPONSE_INVALID",
} as const;

export type BlockscoutErrorCode =
  (typeof BlockscoutErrorCodes)[keyof typeof BlockscoutErrorCodes];

const BLOCKSCOUT_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.values(BlockscoutErrorCodes),
);

interface BlockscoutErrorOptions {
  readonly retryable?: boolean;
  readonly httpStatus?: number;
}

/** Build a public-safe error without including an address, URL, or response body. */
export function blockscoutError(
  code: BlockscoutErrorCode,
  message: string,
  hint?: string,
  options: BlockscoutErrorOptions = {},
): VexError {
  const error = new VexError(code, message, hint);
  if (options.retryable !== undefined) error.retryable = options.retryable;
  if (options.httpStatus !== undefined) error.httpStatus = options.httpStatus;
  return error;
}

export function isBlockscoutError(error: unknown): error is VexError {
  return error instanceof VexError && BLOCKSCOUT_ERROR_CODES.has(error.code);
}
