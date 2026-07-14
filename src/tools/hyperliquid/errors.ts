export type HyperliquidErrorCode =
  | "invalid_decimal"
  | "validation"
  | "transport"
  | "api"
  | "timeout"
  | "response";

/** Safe, domain-scoped error. Callers retain the original cause for diagnostics. */
export class HyperliquidClientError extends Error {
  readonly code: HyperliquidErrorCode;

  constructor(code: HyperliquidErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HyperliquidClientError";
    this.code = code;
  }
}

export class HyperliquidValidationError extends HyperliquidClientError {
  constructor(message: string, options?: ErrorOptions) {
    super("validation", message, options);
    this.name = "HyperliquidValidationError";
  }
}
