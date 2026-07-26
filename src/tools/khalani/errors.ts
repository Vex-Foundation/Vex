import { VexError, ErrorCodes } from "../../errors.js";
import type { KhalaniErrorBody } from "./types.js";

function withMeta(error: VexError, retryable: boolean, externalName?: string): VexError {
  error.retryable = retryable;
  if (externalName) error.externalName = externalName;
  return error;
}

export function mapKhalaniError(status: number, body: KhalaniErrorBody | null): VexError {
  if (status === 404 && body === null) {
    return withMeta(
      new VexError(ErrorCodes.KHALANI_ORDER_NOT_FOUND, "Khalani resource not found."),
      false,
    );
  }
  if (status === 429) {
    return withMeta(
      new VexError(
        ErrorCodes.KHALANI_RATE_LIMITED,
        body?.message ?? "Khalani rate limit exceeded.",
        "Retry with backoff."
      ),
      true,
    );
  }

  const message = body?.message ?? `Khalani API error (HTTP ${status})`;
  const name = body?.name;

  switch (name) {
    case "ValidationException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_VALIDATION_ERROR, message, "Fix the request parameters and retry."),
        false, name,
      );
    case "CannotFillException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_CANNOT_FILL, message, "Try another route, token, chain, or amount."),
        false, name,
      );
    case "QuoteNotFoundException":
      return withMeta(
        new VexError(
          message.toLowerCase().includes("expired") ? ErrorCodes.KHALANI_QUOTE_EXPIRED : ErrorCodes.KHALANI_QUOTE_NOT_FOUND,
          message,
          "Re-request a quote before building the deposit plan."
        ),
        true, name,
      );
    case "NotSupportedTokenException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_UNSUPPORTED_TOKEN, message, "Search supported tokens first."),
        false, name,
      );
    case "NotSupportedChainException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_UNSUPPORTED_CHAIN, message, "Check the supported chain list first."),
        false, name,
      );
    case "BroadcastException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_BROADCAST_FAILED, message, "Check balances, nonce, or destination chain transaction freshness."),
        false, name,
      );
    case "DuplicateRecordException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_API_ERROR, message, "Treat this as already registered and fetch the order state."),
        false, name,
      );
    case "BadRequestException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_VALIDATION_ERROR, message, "Check chain/transaction format, quote freshness, or request state."),
        false, name,
      );
    case "UnexpectedFromAddressException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_ADDRESS_MISMATCH, message, "Ensure the wallet address format matches the selected chain family."),
        false, name,
      );
    case "NotSupportedContractException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_API_ERROR, message, "Choose another route or contact support."),
        false, name,
      );
    case "BuildDepositParsingException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_API_ERROR, message, "Re-quote and retry."),
        false, name,
      );
    case "NotSupportedAssetReverseContractException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_UNSUPPORTED_CHAIN, message, "Choose another route or contact support."),
        false, name,
      );
    case "IntentNotFoundException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_QUOTE_NOT_FOUND, message, "Re-quote and re-initiate the flow."),
        false, name,
      );
    case "NotSupportedDepositMethodException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_UNSUPPORTED_DEPOSIT_METHOD, message, "Pass a different depositMethod, or omit the parameter to use the route default."),
        false, name,
      );
    case "InternalErrorException":
      return withMeta(
        new VexError(ErrorCodes.KHALANI_API_ERROR, message, "Retry with backoff. The upstream service reported an internal error."),
        true, name,
      );
    default:
      if (status >= 500) {
        return withMeta(
          new VexError(ErrorCodes.KHALANI_API_ERROR, message, "Retry with backoff. Khalani returned a server-side error."),
          true, name ?? undefined,
        );
      }
      return withMeta(
        new VexError(ErrorCodes.KHALANI_API_ERROR, message),
        false, name ?? undefined,
      );
  }
}
