import { z } from "zod";
import { CH, EV } from "../../shared/ipc/channels.js";
import {
  acknowledgeFiredInputSchema,
  cancelPriceAlertInputSchema,
  editWatchlistInputSchema,
  getWatchlistInputSchema,
  priceAlertFiredEventSchema,
  setPriceAlertInputSchema,
} from "../../shared/schemas/alerts.js";
import type {
  AcknowledgeFiredInput,
  CancelPriceAlertInput,
  EditWatchlistInput,
  SetPriceAlertInput,
} from "../../shared/schemas/alerts.js";
import type { AlertsBridge } from "../../shared/types/bridge/agent/alerts.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

/** `openWatchlist` carries nothing; anything else on the channel is dropped. */
const noPayloadSchema = z.undefined();

/** vex.alerts.* - the Watchlist page's calls (F01); inputs validated here and again in main. */
export const alerts = {
  getWatchlist() {
    return invokeWithSchema(CH.alerts.getWatchlist, {}, getWatchlistInputSchema);
  },
  editWatchlist(input: EditWatchlistInput) {
    return invokeWithSchema(CH.alerts.editWatchlist, input, editWatchlistInputSchema);
  },
  setPriceAlert(input: SetPriceAlertInput) {
    return invokeWithSchema(CH.alerts.setPriceAlert, input, setPriceAlertInputSchema);
  },
  cancelPriceAlert(input: CancelPriceAlertInput) {
    return invokeWithSchema(CH.alerts.cancelPriceAlert, input, cancelPriceAlertInputSchema);
  },
  acknowledgeFired(input: AcknowledgeFiredInput) {
    return invokeWithSchema(CH.alerts.acknowledgeFired, input, acknowledgeFiredInputSchema);
  },
  onPriceAlertFired(cb) {
    return subscribe(EV.alerts.priceAlertFired, priceAlertFiredEventSchema, cb);
  },
  onOpenWatchlist(cb) {
    return subscribe(EV.alerts.openWatchlist, noPayloadSchema, () => cb());
  },
} satisfies AlertsBridge;
