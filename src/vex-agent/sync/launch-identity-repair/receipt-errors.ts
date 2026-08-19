/**
 * Classifying the one provider error the sweep meets constantly.
 *
 * Shared by the sweep and by its production wiring, so both agree about the
 * noisiest path: "no receipt yet" is the ordinary healthy answer and must never
 * be logged as an incident.
 */

/**
 * viem's `TransactionReceiptNotFoundError`, identified by its stable `name`.
 *
 * NEVER by its message: that string embeds the RPC URL, so a message match would
 * be both fragile and a reason to handle provider text where none is needed.
 * Classified HERE rather than inside the production dep so an INJECTED dep that
 * throws the same error behaves identically — otherwise the tests and production
 * would disagree about the sweep's noisiest path.
 */
export function isReceiptNotFound(err: unknown): boolean {
  return err instanceof Error && err.name === "TransactionReceiptNotFoundError";
}
