/**
 * `BridgeStatus` mode selection - the by-name rejection of a contradictory call.
 *
 * The alias has TWO modes and one parameter bag: `orderId` fetches one order,
 * everything else filters a list. Supplying both is a contradiction, and the
 * alias used to resolve it silently - it forwarded `orderId` and DROPPED every
 * list filter the agent had also supplied. The agent then read a single order
 * back and had no way to learn that its `limit`/`fromChain`/`txHashSearch` were
 * never applied (audit F10). Naming the discarded parameters is the whole point:
 * "invalid combination" would leave the agent guessing which half to remove.
 *
 * Lives in the Khalani namespace, not in the alias file, because WHICH
 * parameters belong to which mode is a fact about the Khalani order API.
 */

/** Every `BridgeStatus` parameter that only has meaning in LIST mode. */
// The retired spellings `address` and `wallet` are deliberately NOT listed: the
// alias rewrite in `tools/internal/action-aliases.ts` runs before this check and
// before the schema parse, so by the time conflict detection reads the call
// there is exactly one spelling of each key (owner decision D15).
export const BRIDGE_STATUS_LIST_ONLY_PARAMS: readonly string[] = [
  "walletAddress",
  "walletFamily",
  "limit",
  "cursor",
  "fromChain",
  "toChain",
  "orderIds",
  "txHashSearch",
];

/**
 * The rejection message when `orderId` is combined with list filters, or `null`
 * when the call is unambiguous.
 */
export function rejectBridgeStatusModeConflict(
  args: Record<string, unknown>,
): string | null {
  if (args.orderId === undefined || args.orderId === null) return null;
  const supplied = BRIDGE_STATUS_LIST_ONLY_PARAMS.filter(
    (key) => args[key] !== undefined && args[key] !== null,
  );
  if (supplied.length === 0) return null;
  return (
    "BridgeStatus takes EITHER orderId (one order) OR the list filters, never both - "
    + `${supplied.join(", ")} ${supplied.length === 1 ? "was" : "were"} supplied alongside orderId `
    + "and would have been silently discarded. Drop orderId to filter a list, or drop "
    + `${supplied.join(", ")} to read that one order.`
  );
}
