import type { Result } from "../../../ipc/result.js";
import type {
  AcknowledgeFiredInput,
  AcknowledgeFiredResult,
  CancelPriceAlertInput,
  CancelPriceAlertResult,
  EditWatchlistInput,
  EditWatchlistResult,
  PriceAlertFiredEventDto,
  SetPriceAlertInput,
  SetPriceAlertResult,
  WatchlistSnapshotDto,
} from "../../../schemas/alerts.js";

/**
 * Watchlist and price alerts (F01) - the Watchlist page's surface.
 *
 * Every call reaches the one engine service the chat tools also use. A
 * refusal (`unsupported_chain`, `already_past`, `too_many_alerts`, ...) is a
 * value in the result, `{ ok: false, reason, message }`, which the page shows
 * by name; an IPC error means the database could not be reached. Prices are
 * exact decimal text: the renderer shows them and never computes with them.
 */
export interface AlertsBridge {
  readonly getWatchlist: () => Promise<Result<WatchlistSnapshotDto>>;
  readonly editWatchlist: (input: EditWatchlistInput) => Promise<Result<EditWatchlistResult>>;
  readonly setPriceAlert: (input: SetPriceAlertInput) => Promise<Result<SetPriceAlertResult>>;
  readonly cancelPriceAlert: (input: CancelPriceAlertInput) => Promise<Result<CancelPriceAlertResult>>;
  readonly acknowledgeFired: (input: AcknowledgeFiredInput) => Promise<Result<AcknowledgeFiredResult>>;
  /** One fired alert, pushed after the engine's claim committed. Returns the unsubscribe. */
  readonly onPriceAlertFired: (cb: (event: PriceAlertFiredEventDto) => void) => () => void;
  /** Main asks to show the Watchlist page (the user clicked the OS notification). */
  readonly onOpenWatchlist: (cb: () => void) => () => void;
}
