import { CH } from "../../shared/ipc/channels.js";
import {
  acknowledgeFiredInputSchema,
  cancelPriceAlertInputSchema,
  editWatchlistInputSchema,
  getWatchlistInputSchema,
  setPriceAlertInputSchema,
} from "../../shared/schemas/alerts.js";
import type {
  AcknowledgeFiredInput,
  CancelPriceAlertInput,
  EditWatchlistInput,
  SetPriceAlertInput,
} from "../../shared/schemas/alerts.js";
import type { AlertsBridge } from "../../shared/types/bridge/agent/alerts.js";
import { invokeWithSchema } from "../_dispatch.js";

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
} satisfies AlertsBridge;
