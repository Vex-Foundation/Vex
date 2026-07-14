import type { Address, Hex } from "viem";

import type { HyperliquidNetwork } from "./constants.js";

/** Canonical, non-exponential decimal notation validated at the boundary. */
export type DecimalString = string & { readonly __decimalString: unique symbol };

export interface HyperliquidWallet {
  readonly address: Address;
  readonly privateKey: Hex;
}

export interface HyperliquidRequestOptions {
  readonly signal?: AbortSignal;
}

export interface HyperliquidClientOptions {
  readonly network?: HyperliquidNetwork;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface HyperliquidAssetMetadata {
  readonly coin: string;
  readonly asset: number;
  readonly szDecimals: number;
  readonly maxLeverage: number;
}

export interface HyperliquidSpotAssetMetadata {
  readonly name: string;
  readonly asset: number;
  readonly szDecimals: number;
}

export type HyperliquidOrderSide = "long" | "short";
export type HyperliquidTimeInForce = "Gtc" | "Ioc" | "Alo" | "FrontendMarket";

export interface HyperliquidLimitOrder {
  readonly a: number;
  readonly b: boolean;
  readonly p: DecimalString;
  readonly s: DecimalString;
  readonly r: boolean;
  readonly t: { readonly limit: { readonly tif: HyperliquidTimeInForce } };
  readonly c?: `0x${string}`;
}

export interface HyperliquidTriggerOrder {
  readonly a: number;
  readonly b: boolean;
  readonly p: DecimalString;
  /** The venue requires a concrete order size, including `positionTpsl` orders. */
  readonly s: DecimalString;
  readonly r: boolean;
  readonly t: {
    readonly trigger: {
      readonly isMarket: boolean;
      readonly triggerPx: DecimalString;
      readonly tpsl: "tp" | "sl";
    };
  };
  readonly c?: `0x${string}`;
}

export type HyperliquidOrder = HyperliquidLimitOrder | HyperliquidTriggerOrder;

export type HyperliquidOrderStatus =
  | { readonly kind: "accepted_resting"; readonly oid?: number; readonly cloid?: `0x${string}` }
  | {
      readonly kind: "accepted_filled";
      readonly oid: number;
      readonly totalSz: DecimalString;
      readonly avgPx: DecimalString;
      readonly cloid?: `0x${string}`;
    }
  | {
      readonly kind: "partially_filled";
      readonly oid: number;
      readonly totalSz: DecimalString;
      readonly avgPx: DecimalString;
      readonly requestedSz: DecimalString;
      readonly cloid?: `0x${string}`;
    }
  | { readonly kind: "rejected"; readonly message: string; readonly cloid?: `0x${string}` };

export type HyperliquidExchangeResult =
  | { readonly kind: "orders"; readonly statuses: readonly HyperliquidOrderStatus[]; readonly raw: unknown }
  | { readonly kind: "batch_error"; readonly message: string; readonly raw: unknown }
  | {
      readonly kind: "transport_timeout";
      readonly cloids: readonly `0x${string}`[];
      readonly recovery: readonly HyperliquidTimeoutRecovery[];
      readonly cause: unknown;
    };

export type HyperliquidTimeoutRecovery =
  | { readonly kind: "confirmed"; readonly cloid: `0x${string}` }
  | { readonly kind: "not_found"; readonly cloid: `0x${string}` }
  | { readonly kind: "unknown"; readonly cloid: `0x${string}` };

export interface HyperliquidL1Request {
  readonly action: Record<string, unknown>;
  readonly vaultAddress?: Address;
  readonly expiresAfter?: number;
  readonly signal?: AbortSignal;
  readonly cloids?: readonly `0x${string}`[];
}

export interface HyperliquidUserSignedRequest {
  readonly action: Record<string, unknown> & { readonly signatureChainId: `0x${string}` };
  readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
  readonly signal?: AbortSignal;
}

export interface HyperliquidSubscriptionCallbacks {
  readonly onUserFills?: (event: unknown) => void;
  readonly onOrderUpdates?: (event: unknown) => void;
  readonly onUserEvents?: (event: unknown) => void;
  readonly onActiveAssetData?: (event: unknown) => void;
  readonly onError?: (cause: unknown) => void;
}
