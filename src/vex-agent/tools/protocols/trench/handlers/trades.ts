/**
 * `trench.trades` handler - per-token trade tape over the undocumented
 * `/api/trades` endpoint (READ-ONLY). `page` is REQUIRED by the provider.
 *
 * The endpoint is undocumented, so the output labels itself provisional and the
 * reader stays tolerant (display-grade fields nullable). Trade rows carry no
 * `token` field - the token is the query parameter - so it is echoed back for
 * the caller's context.
 */

import { getTrenchExpressClient } from "@tools/trench-express/client.js";
import type { TrenchTrade } from "@tools/trench-express/types.js";
import { ok, fail } from "../../handler-helpers.js";
import { readNumber } from "../../runtime/list-params.js";
import type { NumericParamSpecs } from "../../runtime/list-params.js";
import { trenchFailureDetail } from "./failure.js";

const TRADES_NUMERIC_PARAMS: NumericParamSpecs = {
  page: { domain: "nonNegative", integer: true, min: 0 },
  limit: { domain: "nonNegative", integer: true, min: 1, max: 30 },
};

interface TradeRow {
  side: "buy" | "sell" | "unknown";
  in: number;
  out: number;
  volumeUsd: number;
  price: number;
  tx: string;
  time: number;
  maker: string | null;
}

function projectTrade(t: TrenchTrade): TradeRow {
  return {
    side: t.type === 1 ? "buy" : t.type === -1 ? "sell" : "unknown",
    in: t.in,
    out: t.out,
    volumeUsd: t.vol,
    price: t.price,
    tx: t.tx,
    time: t.time,
    maker: t.maker,
  };
}

export async function trenchTradesHandler(p: Record<string, unknown>) {
  const token = typeof p.token === "string" ? p.token.trim() : "";
  if (!token) return fail("Missing required: token (the token contract address).");

  if (p.page === undefined || p.page === null || p.page === "") {
    return fail("Missing required: page (0-based; the provider errors without it).");
  }
  const pageRead = readNumber(p, "page", TRADES_NUMERIC_PARAMS);
  if (!pageRead.ok) return fail(pageRead.reason);
  const limitRead = readNumber(p, "limit", TRADES_NUMERIC_PARAMS);
  if (!limitRead.ok) return fail(limitRead.reason);

  try {
    const client = getTrenchExpressClient();
    const rows = await client.getTrades({
      token,
      page: pageRead.value ?? 0,
      limit: limitRead.value ?? undefined,
    });
    return ok({
      token,
      page: pageRead.value ?? 0,
      count: rows.length,
      source: "undocumented launchpad endpoint - treat as provisional",
      trades: rows.map(projectTrade),
    });
  } catch (err) {
    return fail(`Trench trades unavailable (${trenchFailureDetail("trench__token_trades_list", err)})`);
  }
}
