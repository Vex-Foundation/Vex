/**
 * The Virtuals bonding-curve TRADES TAPE (`vp-api.virtuals.io/vp-api/trades`).
 *
 * This is the feed app.virtuals.io itself renders under a still-bonding agent:
 * the live capture of the agent page issued
 * `GET /vp-api/trades?tokenAddress=0xE0835d...&limit=30&chainID=0&tradeSideOption=0`.
 * It is a SEPARATE HOST from the Strapi API, with its own envelope
 * (`{ code, data: { Trades } }`), its own chain numbering, and its own
 * emptiness rules, so it gets its own owner module rather than another method
 * on `../client.ts` (rule 03: one authoritative owner per responsibility).
 *
 * WHAT IT COVERS, ALL MEASURED (see `../Virtuals.md` for the capture names):
 *
 * | chain     | vp-api chainID | bonding agent            | graduated agent |
 * |-----------|----------------|--------------------------|-----------------|
 * | BASE      | 0              | rows (proven twice)      | EMPTY           |
 * | SOLANA    | 1              | rows (proven)            | EMPTY           |
 * | ROBINHOOD | (none)         | EMPTY at chainID 2       | EMPTY           |
 * | ETH       | (none)         | not offered              | not offered     |
 *
 * The chain numbering is not guesswork: Virtuals' own `vp-trade-sdk` declares
 * `enum KLINE_CHAIN_ID { BASE = 0, SOLANA = 1 }` and lists no other member, and
 * every live probe agrees with it. Robinhood and Ethereum have NO id in that
 * enum, and a Robinhood bonding agent (SIRIUS, `0x72E936...`) returned an empty
 * tape at chainID 2 while its API row carried an 80-point price series - so the
 * tape genuinely does not exist there rather than being one parameter away.
 * `readVpApiTrades` refuses those two chains BY NAME instead of returning an
 * empty array that would read as "this agent has never traded".
 *
 * ADDRESS FORM. The key is the BONDING token: `preToken` while the agent is on
 * the curve (where `tokenAddress` is null), and after graduation the same
 * address in both columns. Every graduated token probed - by either column,
 * every chainID, with and without the parameter - returned an empty tape, so
 * this endpoint is a CURVE feed and a graduated agent's trades come from the
 * AMM indexers instead.
 *
 * The sibling `/vp-api/klines` endpoint is NOT wrapped here. It answered
 * `{"Klines":[]}` to all twelve probed combinations (two granularities, five
 * windows, seconds and milliseconds, three tokens including one that returned a
 * live tape in the same session), and the production front end never calls it.
 * Building on it would be building on a dead endpoint.
 */

import { fetchWithTimeout, readJson } from "../../../utils/http.js";
import logger from "../../../utils/logger.js";
import { isRecord } from "../../../utils/validation-helpers.js";
import { mapVirtualsError, mapVirtualsTransportError } from "../errors.js";
import { VirtualsThrottle, parseRetryAfterMs } from "../throttle.js";
import type { VirtualsChain } from "../types.js";

const VP_API_BASE = "https://vp-api.virtuals.io";
const USER_AGENT = "Vex-Agent/1.0 (+https://vexlabs.ai)";

/**
 * `vp-trade-sdk`'s `KLINE_CHAIN_ID`, which the live probes reproduce exactly.
 * A chain absent from this map has no tape, and that is a product fact, not a
 * missing constant.
 */
const VP_API_CHAIN_ID: Partial<Record<VirtualsChain, number>> = {
  BASE: 0,
  SOLANA: 1,
};

/** `tradeSideOption`: 0 both, 1 buys only, 2 sells only (each proven live). */
export const VP_API_TRADE_SIDES = ["both", "buys", "sells"] as const;
export type VpApiTradeSide = (typeof VP_API_TRADE_SIDES)[number];
const TRADE_SIDE_OPTION: Record<VpApiTradeSide, number> = { both: 0, buys: 1, sells: 2 };

/**
 * OUR ceiling for the TRADES TOOL. `limit=200` was served (74 KB) and a tape
 * reader wants a readable page, not the whole history.
 */
export const VP_API_MAX_LIMIT = 200;

/**
 * The PROVIDER's ceiling, quoted from its own rejection (2026-09-05):
 *
 *   limit=1001 -> HTTP 400 {"code":-400,"message":"param limit maxLimit 1000"}
 *
 * The candle builder asks for exactly this, because the tape has NO CURSOR:
 * `offset`, `page`, `skip`, `before`, `beforeTimestamp`, `endTime` and
 * `toTimestamp` were each sent live and each SILENTLY IGNORED, every one
 * returning the byte-identical newest window. One call at the ceiling is the
 * only depth this endpoint offers, and an agent past it has history that no
 * parameter can reach.
 */
export const VP_API_PROVIDER_MAX_LIMIT = 1000;

/** One curve trade, amounts kept as the decimal strings the provider sent. */
export interface VirtualsCurveTrade {
  txHash: string;
  txSender: string;
  tokenAddress: string;
  isBuy: boolean;
  /** Agent-token amount, decimal string in whole tokens (NOT wei). */
  agentTokenAmount: string;
  /** VIRTUAL amount, decimal string in whole tokens (NOT wei). */
  virtualTokenAmount: string;
  /** VIRTUAL per agent token, decimal string. */
  price: string;
  /** Unix SECONDS. */
  timestampSeconds: number;
}

/** Why a chain has no tape, stated by name rather than answered with `[]`. */
export interface VpApiUnsupported {
  supported: false;
  reason: string;
}

export interface VpApiTrades {
  supported: true;
  trades: VirtualsCurveTrade[];
  /** The chainID actually sent, echoed so a reply can cite it. */
  chainId: number;
}

export type VpApiTradesResult = VpApiTrades | VpApiUnsupported;

/** Shared per-process budget for this host, separate from the Strapi API's. */
const throttle = new VirtualsThrottle();

function readTrade(raw: unknown): VirtualsCurveTrade | null {
  if (!isRecord(raw)) return null;
  const txHash = raw.txHash;
  const tokenAddress = raw.tokenAddress;
  const timestamp = raw.timestamp;
  if (typeof txHash !== "string" || txHash.length === 0) return null;
  if (typeof tokenAddress !== "string" || tokenAddress.length === 0) return null;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  const decimal = (v: unknown): string =>
    typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? v : "0";
  return {
    txHash,
    txSender: typeof raw.txSender === "string" ? raw.txSender : "",
    tokenAddress,
    isBuy: raw.isBuy === true,
    agentTokenAmount: decimal(raw.agentTokenAmt),
    virtualTokenAmount: decimal(raw.virtualTokenAmt),
    price: decimal(raw.price),
    timestampSeconds: timestamp,
  };
}

export interface ReadVpApiTradesParams {
  chain: VirtualsChain;
  /** `preToken` while bonding; the same address in both columns once graduated. */
  tokenAddress: string;
  limit: number;
  side?: VpApiTradeSide;
}

/**
 * Read the curve tape for one agent.
 *
 * @returns `{ supported: false, reason }` for a chain the endpoint does not
 * serve - never an empty list, which would be indistinguishable from an agent
 * that has genuinely never traded.
 */
export async function readVpApiTrades(
  params: ReadVpApiTradesParams,
): Promise<VpApiTradesResult> {
  const chainId = VP_API_CHAIN_ID[params.chain];
  if (chainId === undefined) {
    return {
      supported: false,
      reason:
        `The Virtuals trades feed (vp-api) has no chain id for ${params.chain}. Virtuals' own `
        + "vp-trade-sdk declares only BASE = 0 and SOLANA = 1, and a live Robinhood bonding agent "
        + "returned an empty tape at chainID 2 while its API row carried a price series - so the "
        + "tape does not exist for this chain rather than being one parameter away. Use "
        + "virtuals__agent_candles_list for a graduated agent's history, or the agent row's "
        + "priceSeries24h while it is still on the curve.",
    };
  }

  const url = new URL("/vp-api/trades", VP_API_BASE);
  url.searchParams.set("tokenAddress", params.tokenAddress);
  // Bounded by what the PROVIDER accepts, not by the trades tool's own product
  // bound: the candle builder legitimately asks for the full ceiling, and each
  // caller validates its own limit by name before reaching here.
  url.searchParams.set(
    "limit",
    String(Math.min(Math.max(1, params.limit), VP_API_PROVIDER_MAX_LIMIT)),
  );
  url.searchParams.set("chainID", String(chainId));
  url.searchParams.set("tradeSideOption", String(TRADE_SIDE_OPTION[params.side ?? "both"]));
  const href = url.toString();

  try {
    return await throttle.run(href, throttle.defaultTtlMs, async () => {
      const response = await fetchWithTimeout(href, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!response.ok) {
        if (response.status === 429) {
          throttle.penalize(parseRetryAfterMs(response.headers?.get?.("retry-after")));
        }
        const raw = await readJson(response);
        logger.warn("virtuals.vp_api.http_error", { status: response.status, path: "/vp-api/trades" });
        throw mapVirtualsError(response.status, raw);
      }
      const raw = await readJson(response);
      const data = isRecord(raw) && isRecord(raw.data) ? raw.data : null;
      const rows = data !== null && Array.isArray(data.Trades) ? data.Trades : [];
      const trades = rows
        .map(readTrade)
        .filter((t): t is VirtualsCurveTrade => t !== null);
      return { supported: true, trades, chainId } satisfies VpApiTrades;
    });
  } catch (err) {
    mapVirtualsTransportError(err);
  }
}
