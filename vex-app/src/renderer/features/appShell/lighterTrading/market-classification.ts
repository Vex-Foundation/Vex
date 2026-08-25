import type {
  LighterTradingEnvironment,
  LighterTradingMarket,
  LighterTradingMarketType,
} from "@shared/schemas/lighter-trading.js";
import { marketSymbols } from "./format.js";

export type LighterMarketSection = "stocks" | "perp" | "spot";
export type LighterMarketAssetClass = "stock" | "unclassified";

type MarketIdentity = Pick<
  LighterTradingMarket,
  "baseAssetId" | "marketId" | "marketType" | "quoteAssetId" | "symbol"
>;

export interface LighterMarketClassification {
  readonly assetClass: LighterMarketAssetClass;
  readonly executionType: LighterTradingMarketType;
  readonly section: LighterMarketSection;
  readonly ticker: string;
}

/**
 * Exact Lighter listing identities whose provider metadata is `RWA + STOCK`.
 *
 * Reviewed on 2026-08-25 by joining Lighter's official Core and Robinhood
 * Chain `orderBooks?filter=all` responses to `assetDetails`, then to the token
 * catalog used by lighter.exchange. Spot rows are joined by `base_asset_id`;
 * ticker parsing is never used as classification evidence.
 *
 * Unknown or changed identities deliberately fall back to their provider
 * execution type. This keeps a new or drifted listing out of Stocks until its
 * complete identity has been reviewed.
 */
const VERIFIED_LIGHTER_STOCKS: ReadonlyMap<string, string> = new Map([
  // Lighter Core.
  ["core:108:0:0:perp:HOOD", "HOOD"],
  ["core:109:0:0:perp:COIN", "COIN"],
  ["core:110:0:0:perp:NVDA", "NVDA"],
  ["core:111:0:0:perp:PLTR", "PLTR"],
  ["core:112:0:0:perp:TSLA", "TSLA"],
  ["core:113:0:0:perp:AAPL", "AAPL"],
  ["core:114:0:0:perp:AMZN", "AMZN"],
  ["core:115:0:0:perp:MSFT", "MSFT"],
  ["core:116:0:0:perp:GOOGL", "GOOGL"],
  ["core:117:0:0:perp:META", "META"],
  ["core:121:0:0:perp:CRCL", "CRCL"],
  ["core:122:0:0:perp:MSTR", "MSTR"],
  ["core:123:0:0:perp:BMNR", "BMNR"],
  ["core:137:0:0:perp:INTC", "INTC"],
  ["core:138:0:0:perp:AMD", "AMD"],
  ["core:139:0:0:perp:SNDK", "SNDK"],
  ["core:140:0:0:perp:SAMSUNG", "SAMSUNG"],
  ["core:141:0:0:perp:HYUNDAI", "HYUNDAI"],
  ["core:143:0:0:perp:SKHYNIX", "SKHYNIX"],
  ["core:148:0:0:perp:HANMI", "HANMI"],
  ["core:151:0:0:perp:ASML", "ASML"],
  ["core:156:0:0:perp:STRC", "STRC"],
  ["core:160:0:0:perp:HYUNDAIUSD", "HYUNDAIUSD"],
  ["core:161:0:0:perp:SKHYNIXUSD", "SKHYNIXUSD"],
  ["core:162:0:0:perp:SAMSUNGUSD", "SAMSUNGUSD"],
  ["core:164:0:0:perp:MU", "MU"],
  ["core:165:0:0:perp:ORCL", "ORCL"],
  ["core:167:0:0:perp:CRWV", "CRWV"],
  ["core:168:0:0:perp:TSM", "TSM"],
  ["core:169:0:0:perp:SOXX", "SOXX"],
  ["core:174:0:0:perp:MRVL", "MRVL"],
  ["core:175:0:0:perp:CBRS", "CBRS"],
  ["core:176:0:0:perp:GME", "GME"],
  ["core:177:0:0:perp:BABA", "BABA"],
  ["core:178:0:0:perp:LITE", "LITE"],
  ["core:179:0:0:perp:TTWO", "TTWO"],
  ["core:185:0:0:perp:BOT", "BOT"],
  ["core:186:0:0:perp:RKLB", "RKLB"],
  ["core:187:0:0:perp:DELL", "DELL"],
  ["core:188:0:0:perp:IBM", "IBM"],
  ["core:189:0:0:perp:NBIS", "NBIS"],
  ["core:190:0:0:perp:QNT", "QNT"],
  ["core:191:0:0:perp:NOW", "NOW"],
  ["core:192:0:0:perp:OPENAI", "OPENAI"],
  ["core:193:0:0:perp:ANTHROPIC", "ANTHROPIC"],
  ["core:194:0:0:perp:SPCX", "SPCX"],
  ["core:196:0:0:perp:BE", "BE"],
  ["core:199:0:0:perp:MINIMAX", "MINIMAX"],
  ["core:201:0:0:perp:TENCENT", "TENCENT"],
  ["core:202:0:0:perp:SMIC", "SMIC"],
  ["core:203:0:0:perp:XIAOMI", "XIAOMI"],
  ["core:205:0:0:perp:ZHIPU", "ZHIPU"],
  ["core:211:0:0:perp:BB", "BB"],
  ["core:214:0:0:perp:WEN", "WEN"],
  ["core:216:0:0:perp:SKHY", "SKHY"],
  ["core:217:0:0:perp:CXMT", "CXMT"],
  ["core:218:0:0:perp:GEV", "GEV"],
  ["core:220:0:0:perp:UNITREE", "UNITREE"],
  ["core:223:0:0:perp:WDC", "WDC"],
  ["core:224:0:0:perp:AXTI", "AXTI"],
  ["core:225:0:0:perp:KIOXIA", "KIOXIA"],
  ["core:228:0:0:perp:MRNA", "MRNA"],

  // Lighter on Robinhood Chain.
  ["rhc:10:0:0:perp:AAPL", "AAPL"],
  ["rhc:11:0:0:perp:AMZN", "AMZN"],
  ["rhc:12:0:0:perp:GOOGL", "GOOGL"],
  ["rhc:13:0:0:perp:META", "META"],
  ["rhc:14:0:0:perp:MSFT", "MSFT"],
  ["rhc:15:0:0:perp:NVDA", "NVDA"],
  ["rhc:16:0:0:perp:TSLA", "TSLA"],
  ["rhc:17:0:0:perp:ORCL", "ORCL"],
  ["rhc:18:0:0:perp:SPCX", "SPCX"],
  ["rhc:19:0:0:perp:BABA", "BABA"],
  ["rhc:20:0:0:perp:BE", "BE"],
  ["rhc:23:0:0:perp:COIN", "COIN"],
  ["rhc:24:0:0:perp:CRCL", "CRCL"],
  ["rhc:29:0:0:perp:AMD", "AMD"],
  ["rhc:30:0:0:perp:INTC", "INTC"],
  ["rhc:31:0:0:perp:MU", "MU"],
  ["rhc:32:0:0:perp:SNDK", "SNDK"],
  ["rhc:33:0:0:perp:CRWV", "CRWV"],
  ["rhc:34:0:0:perp:PLTR", "PLTR"],
  ["rhc:37:0:0:perp:SKHY", "SKHY"],
  ["rhc:38:0:0:perp:ANTHROPIC", "ANTHROPIC"],
  ["rhc:2049:4:3:spot:AAPL/USDG", "AAPL"],
  ["rhc:2050:5:3:spot:AMZN/USDG", "AMZN"],
  ["rhc:2051:6:3:spot:GOOGL/USDG", "GOOGL"],
  ["rhc:2052:7:3:spot:META/USDG", "META"],
  ["rhc:2053:8:3:spot:MSFT/USDG", "MSFT"],
  ["rhc:2054:9:3:spot:NVDA/USDG", "NVDA"],
  ["rhc:2055:10:3:spot:TSLA/USDG", "TSLA"],
  ["rhc:2056:11:3:spot:ORCL/USDG", "ORCL"],
  ["rhc:2057:12:3:spot:SPCX/USDG", "SPCX"],
  ["rhc:2058:13:3:spot:BABA/USDG", "BABA"],
  ["rhc:2059:14:3:spot:BE/USDG", "BE"],
  ["rhc:2062:17:3:spot:COIN/USDG", "COIN"],
  ["rhc:2063:18:3:spot:CRCL/USDG", "CRCL"],
  ["rhc:2068:23:3:spot:AMD/USDG", "AMD"],
  ["rhc:2069:24:3:spot:INTC/USDG", "INTC"],
  ["rhc:2070:25:3:spot:MU/USDG", "MU"],
  ["rhc:2071:26:3:spot:SNDK/USDG", "SNDK"],
  ["rhc:2072:27:3:spot:CRWV/USDG", "CRWV"],
  ["rhc:2073:28:3:spot:PLTR/USDG", "PLTR"],
]);

export function classifyLighterMarket(
  environment: LighterTradingEnvironment,
  market: MarketIdentity,
): LighterMarketClassification {
  const verifiedTicker = VERIFIED_LIGHTER_STOCKS.get(identityKey(environment, market));
  if (verifiedTicker !== undefined) {
    return {
      assetClass: "stock",
      executionType: market.marketType,
      section: "stocks",
      ticker: verifiedTicker,
    };
  }

  return {
    assetClass: "unclassified",
    executionType: market.marketType,
    section: market.marketType,
    ticker: marketSymbols(market.symbol, market.marketType).base,
  };
}

export function marketSectionFor(
  environment: LighterTradingEnvironment,
  market: MarketIdentity,
): LighterMarketSection {
  return classifyLighterMarket(environment, market).section;
}

export function marketProductLabel(
  classification: LighterMarketClassification,
): string {
  if (classification.assetClass === "stock") {
    return classification.executionType === "spot"
      ? "Stock token · Spot"
      : "Stock · Perpetual";
  }
  return classification.executionType === "perp" ? "Perpetual" : "Spot";
}

function identityKey(
  environment: LighterTradingEnvironment,
  market: MarketIdentity,
): string {
  return [
    environment,
    market.marketId,
    market.baseAssetId,
    market.quoteAssetId,
    market.marketType,
    market.symbol,
  ].join(":");
}
