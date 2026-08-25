/**
 * Offline market marks for the Lighter workspace.
 *
 * A logo is authorized only by the complete provider identity tuple. The
 * symbol alone is intentionally insufficient: if Lighter reuses a ticker on
 * another market id, changes a listing, or adds a new market, that row keeps
 * the honest ticker badge until this allowlist is reviewed. All icons are
 * bundled React SVGs, so rendering never contacts a third-party image host.
 *
 * Market identities were checked against the official Core and Robinhood
 * Chain `orderBooks?filter=all` responses on 2026-08-25.
 */

import {
  Alibaba,
  Amazon,
  Amd,
  Apple,
  Avalanche,
  Bitcoin,
  BitcoinCash,
  Bnb,
  Broadcom,
  Cardano,
  Chainlink,
  Circle,
  Coinbase,
  Dell,
  Dogecoin,
  Ethereum,
  Google,
  Hedera,
  Ibm,
  Intel,
  Litecoin,
  Meta,
  Microsoft,
  Micron,
  Monero,
  Near,
  Nvidia,
  Optimism,
  Oracle,
  Palantir,
  Polkadot,
  Polygon,
  Qualcomm,
  Robinhood,
  Sandisk,
  Solana,
  Stellar,
  Sui,
  TakeTwo,
  Tesla,
  Tron,
  Xrp,
  Zcash,
} from "@thesvg/react";
import { createElement, type ComponentType } from "react";
import type {
  LighterTradingEnvironment,
  LighterTradingMarket,
} from "@shared/schemas/lighter-trading.js";

type BrandIcon = ComponentType<{
  readonly width?: number | string;
  readonly height?: number | string;
  readonly className?: string;
  readonly "aria-hidden"?: boolean;
  readonly focusable?: boolean;
}>;

export type LighterMarketMark =
  | { readonly kind: "brand"; readonly icon: BrandIcon; readonly name: string }
  | { readonly kind: "local"; readonly name: string; readonly src: string };

type MarketIdentity = Pick<
  LighterTradingMarket,
  "baseAssetId" | "marketId" | "marketType" | "symbol"
>;

// These wrappers select theme-safe variants or correct upstream view boxes
// without mutating the shared icon package.
const AppleMarketMark: BrandIcon = (props) => createElement(Apple, {
  ...props,
  variant: "mono",
});
const AmazonMarketMark: BrandIcon = (props) => createElement(Amazon, {
  ...props,
  viewBox: "0 0 640 190",
});
const PalantirMarketMark: BrandIcon = (props) => createElement(Palantir, {
  ...props,
  variant: "mono",
});

function brand(name: string, icon: BrandIcon): LighterMarketMark {
  return { kind: "brand", name, icon };
}

// Official Lighter market artwork, verified 2026-08-25:
// https://assets.lighter.xyz/fe/token/ansem.png
// The 1024px source was losslessly resized to the bundled 128px UI asset;
// bundled SHA-256: e8603b4549483ab123be465e8f27706d6bfac8161bc8df1c4484ccd472c2a0b6.
const ANSEM_MARK = {
  kind: "local",
  name: "ansem",
  src: new URL("./market-assets/ansem.png", import.meta.url).href,
} satisfies LighterMarketMark;

function identityKey(
  environment: LighterTradingEnvironment,
  market: MarketIdentity,
): string {
  return `${environment}:${market.marketId}:${market.baseAssetId}:${market.marketType}:${market.symbol}`;
}

const MARKET_MARKS: ReadonlyMap<string, LighterMarketMark> = new Map([
  // Lighter Core — crypto markets.
  ["core:0:0:perp:ETH", brand("ethereum", Ethereum)],
  ["core:1:0:perp:BTC", brand("bitcoin", Bitcoin)],
  ["core:2:0:perp:SOL", brand("solana", Solana)],
  ["core:3:0:perp:DOGE", brand("dogecoin", Dogecoin)],
  ["core:7:0:perp:XRP", brand("xrp", Xrp)],
  ["core:8:0:perp:LINK", brand("chainlink", Chainlink)],
  ["core:9:0:perp:AVAX", brand("avalanche", Avalanche)],
  ["core:10:0:perp:NEAR", brand("near", Near)],
  ["core:11:0:perp:DOT", brand("polkadot", Polkadot)],
  ["core:14:0:perp:POL", brand("polygon", Polygon)],
  ["core:16:0:perp:SUI", brand("sui", Sui)],
  ["core:25:0:perp:BNB", brand("bnb", Bnb)],
  ["core:35:0:perp:LTC", brand("litecoin", Litecoin)],
  ["core:39:0:perp:ADA", brand("cardano", Cardano)],
  ["core:43:0:perp:TRX", brand("tron", Tron)],
  ["core:55:0:perp:OP", brand("optimism", Optimism)],
  ["core:58:0:perp:BCH", brand("bitcoin cash", BitcoinCash)],
  ["core:59:0:perp:HBAR", brand("hedera", Hedera)],
  ["core:77:0:perp:XMR", brand("monero", Monero)],
  ["core:90:0:perp:ZEC", brand("zcash", Zcash)],
  ["core:119:0:perp:XLM", brand("stellar", Stellar)],
  ["core:2048:1:spot:ETH/USDC", brand("ethereum", Ethereum)],
  ["core:2050:5:spot:LINK/USDC", brand("chainlink", Chainlink)],

  // Lighter Core — equity-linked markets.
  ["core:108:0:perp:HOOD", brand("robinhood", Robinhood)],
  ["core:109:0:perp:COIN", brand("coinbase", Coinbase)],
  ["core:110:0:perp:NVDA", brand("nvidia", Nvidia)],
  ["core:111:0:perp:PLTR", brand("palantir", PalantirMarketMark)],
  ["core:112:0:perp:TSLA", brand("tesla", Tesla)],
  ["core:113:0:perp:AAPL", brand("apple", AppleMarketMark)],
  ["core:114:0:perp:AMZN", brand("amazon", AmazonMarketMark)],
  ["core:115:0:perp:MSFT", brand("microsoft", Microsoft)],
  ["core:116:0:perp:GOOGL", brand("google", Google)],
  ["core:117:0:perp:META", brand("meta", Meta)],
  ["core:137:0:perp:INTC", brand("intel", Intel)],
  ["core:138:0:perp:AMD", brand("amd", Amd)],
  ["core:139:0:perp:SNDK", brand("sandisk", Sandisk)],
  ["core:164:0:perp:MU", brand("micron", Micron)],
  ["core:165:0:perp:ORCL", brand("oracle", Oracle)],
  ["core:177:0:perp:BABA", brand("alibaba", Alibaba)],
  ["core:179:0:perp:TTWO", brand("take-two", TakeTwo)],
  ["core:187:0:perp:DELL", brand("dell", Dell)],
  ["core:188:0:perp:IBM", brand("ibm", Ibm)],
  ["core:209:0:perp:QCOM", brand("qualcomm", Qualcomm)],
  ["core:210:0:perp:AVGO", brand("broadcom", Broadcom)],
  ["core:219:0:perp:ANSEM", ANSEM_MARK],

  // Robinhood Chain — crypto markets.
  ["rhc:0:0:perp:ETH", brand("ethereum", Ethereum)],
  ["rhc:1:0:perp:BTC", brand("bitcoin", Bitcoin)],
  ["rhc:3:0:perp:SOL", brand("solana", Solana)],
  ["rhc:4:0:perp:ZEC", brand("zcash", Zcash)],
  ["rhc:6:0:perp:XRP", brand("xrp", Xrp)],
  ["rhc:7:0:perp:NEAR", brand("near", Near)],
  ["rhc:9:0:perp:SUI", brand("sui", Sui)],
  ["rhc:2048:1:spot:ETH/USDG", brand("ethereum", Ethereum)],

  // Robinhood Chain — equity-linked perpetual and spot markets.
  ["rhc:10:0:perp:AAPL", brand("apple", AppleMarketMark)],
  ["rhc:11:0:perp:AMZN", brand("amazon", AmazonMarketMark)],
  ["rhc:12:0:perp:GOOGL", brand("google", Google)],
  ["rhc:13:0:perp:META", brand("meta", Meta)],
  ["rhc:14:0:perp:MSFT", brand("microsoft", Microsoft)],
  ["rhc:15:0:perp:NVDA", brand("nvidia", Nvidia)],
  ["rhc:16:0:perp:TSLA", brand("tesla", Tesla)],
  ["rhc:17:0:perp:ORCL", brand("oracle", Oracle)],
  ["rhc:19:0:perp:BABA", brand("alibaba", Alibaba)],
  ["rhc:23:0:perp:COIN", brand("coinbase", Coinbase)],
  ["rhc:24:0:perp:CRCL", brand("circle", Circle)],
  ["rhc:29:0:perp:AMD", brand("amd", Amd)],
  ["rhc:30:0:perp:INTC", brand("intel", Intel)],
  ["rhc:31:0:perp:MU", brand("micron", Micron)],
  ["rhc:32:0:perp:SNDK", brand("sandisk", Sandisk)],
  ["rhc:34:0:perp:PLTR", brand("palantir", PalantirMarketMark)],
  ["rhc:39:0:perp:ANSEM", ANSEM_MARK],
  ["rhc:2049:4:spot:AAPL/USDG", brand("apple", AppleMarketMark)],
  ["rhc:2050:5:spot:AMZN/USDG", brand("amazon", AmazonMarketMark)],
  ["rhc:2051:6:spot:GOOGL/USDG", brand("google", Google)],
  ["rhc:2052:7:spot:META/USDG", brand("meta", Meta)],
  ["rhc:2053:8:spot:MSFT/USDG", brand("microsoft", Microsoft)],
  ["rhc:2054:9:spot:NVDA/USDG", brand("nvidia", Nvidia)],
  ["rhc:2055:10:spot:TSLA/USDG", brand("tesla", Tesla)],
  ["rhc:2056:11:spot:ORCL/USDG", brand("oracle", Oracle)],
  ["rhc:2058:13:spot:BABA/USDG", brand("alibaba", Alibaba)],
  ["rhc:2062:17:spot:COIN/USDG", brand("coinbase", Coinbase)],
  ["rhc:2063:18:spot:CRCL/USDG", brand("circle", Circle)],
  ["rhc:2068:23:spot:AMD/USDG", brand("amd", Amd)],
  ["rhc:2069:24:spot:INTC/USDG", brand("intel", Intel)],
  ["rhc:2070:25:spot:MU/USDG", brand("micron", Micron)],
  ["rhc:2071:26:spot:SNDK/USDG", brand("sandisk", Sandisk)],
  ["rhc:2073:28:spot:PLTR/USDG", brand("palantir", PalantirMarketMark)],
]);

export function resolveLighterMarketMark(
  environment: LighterTradingEnvironment,
  market: MarketIdentity,
): LighterMarketMark | null {
  return MARKET_MARKS.get(identityKey(environment, market)) ?? null;
}
