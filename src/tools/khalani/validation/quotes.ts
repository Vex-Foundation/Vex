/**
 * Khalani quote validators (codex-002 Phase 2).
 *
 * `quoteBlockSchema(prefix)` is the inner `quote` block shared between the
 * `/quotes` routes and the NDJSON stream route — the `prefix` keeps the
 * field-path messages exactly matching the original. Moved verbatim from
 * `validation.ts`.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";
import type { QuoteResponse, QuoteStreamRoute } from "../types.js";
import {
  asNumber,
  asOptionalString,
  asString,
  asStringArray,
  isRecordValue,
  parseOrThrow,
} from "./_shared.js";

// ---------------------------------------------------------------------------
// Quote route shape (shared between /quotes routes and the NDJSON stream)
// ---------------------------------------------------------------------------

/**
 * Optional string array: `undefined` when the key is absent or not an array,
 * else the string elements (element-wise filter). Distinct from
 * `asStringArray` (which collapses an absent field to `[]`) so an omitted
 * `supportedDepositMethods` stays `undefined` rather than a misleading empty
 * "no methods supported" array.
 */
const optionalStringArray: z.ZodType<string[] | undefined> = z
  .unknown()
  .optional()
  .transform((v) =>
    Array.isArray(v) ? v.filter((entry): entry is string => typeof entry === "string") : undefined,
  );

/**
 * Inner `quote` block. `prefix` is "route.quote" or "stream.quote" so the
 * field-path messages exactly match the original.
 */
function quoteBlockSchema(prefix: string) {
  return z.object(
    {
      amountIn: asString(`${prefix}.amountIn`),
      amountOut: asString(`${prefix}.amountOut`),
      expectedDurationSeconds: asNumber(`${prefix}.expectedDurationSeconds`),
      validBefore: asNumber(`${prefix}.validBefore`),
      quoteExpiresAt: z
        .unknown()
        .optional()
        .transform((v) => (typeof v === "number" ? v : undefined)),
      estimatedGas: asOptionalString,
      tags: asStringArray,
      // Live drift (undocumented): route-supported deposit methods. Lenient —
      // undefined when omitted, string elements otherwise (not the closed
      // DepositMethod union: it is untrusted provider data).
      supportedDepositMethods: optionalStringArray,
    },
    { message: "Invalid Khalani response: route must include quote" },
  );
}

export function validateQuoteResponse(raw: unknown): QuoteResponse {
  if (!isRecordValue(raw) || !Array.isArray(raw.routes)) {
    throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Invalid Khalani response: expected quote routes");
  }

  const quoteId = parseOrThrow(asString("quote.quoteId"), raw.quoteId);

  return {
    quoteId,
    routes: raw.routes.map((entry) => {
      if (!isRecordValue(entry) || !isRecordValue(entry.quote)) {
        throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Invalid Khalani response: route must include quote");
      }
      const route = parseOrThrow(
        z.object({
          routeId: asString("route.routeId"),
          type: asString("route.type"),
          icon: asOptionalString,
          exactOutMethod: asOptionalString,
          depositMethods: asStringArray,
          quote: quoteBlockSchema("route.quote"),
        }),
        entry,
      );
      return {
        routeId: route.routeId,
        type: route.type,
        icon: route.icon,
        exactOutMethod: route.exactOutMethod,
        depositMethods: route.depositMethods as QuoteResponse["routes"][number]["depositMethods"],
        quote: route.quote,
      };
    }),
  };
}

export function validateQuoteStreamRoute(raw: unknown): QuoteStreamRoute {
  if (!isRecordValue(raw) || !isRecordValue(raw.quote)) {
    throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Invalid Khalani stream response: expected route object");
  }

  const parsed = parseOrThrow(
    z.object({
      quoteId: asString("stream.quoteId"),
      routeId: asString("stream.routeId"),
      type: asString("stream.type"),
      icon: asOptionalString,
      exactOutMethod: asOptionalString,
      depositMethods: asStringArray,
      quote: quoteBlockSchema("stream.quote"),
    }),
    raw,
  );

  return {
    quoteId: parsed.quoteId,
    routeId: parsed.routeId,
    type: parsed.type,
    icon: parsed.icon,
    exactOutMethod: parsed.exactOutMethod,
    depositMethods: parsed.depositMethods as QuoteStreamRoute["depositMethods"],
    quote: parsed.quote,
  };
}
