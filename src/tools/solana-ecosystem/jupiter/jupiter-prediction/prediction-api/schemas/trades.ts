/**
 * Jupiter Prediction `trades` response schemas (codex-002).
 */

import { z } from "zod";

// ── Trades ─────────────────────────────────────────────────────────

const tradeSchema = z
  .object({
    // LIVE-GATE FIX 1 (2026-07-24): confirmed live against `GET /trades` —
    // `id` is a provider-prefixed string identity (e.g. "order-2782520"), not
    // a number. Identity-only (never fed to money/signing logic downstream),
    // so kept as a plain string rather than coerced.
    id: z.string(),
    ownerPubkey: z.string(),
    marketId: z.string(),
    message: z.string(),
    timestamp: z.number(),
    action: z.string(),
    side: z.string(),
    eventTitle: z.string(),
    marketTitle: z.string(),
    amountUsd: z.string(),
    priceUsd: z.string(),
    // AUDIT 2026-07-25: display-only, and a missing image is `null` in this
    // API rather than an absent key (92 of 97 live `imageUrl` values are
    // `null`; `marketSchema.imageUrl` already models that). `/trades` is a
    // GLOBAL feed, so one image-less row would have failed the entire read —
    // the same one-bad-row-kills-the-response blast radius as the
    // `closeTime`/`result` outage.
    eventImageUrl: z.string().nullable(),
    eventId: z.string(),
  })
  .passthrough();

export const jupiterPredictionTradesResponseSchema = z
  .object({ data: z.array(tradeSchema) })
  .passthrough();
