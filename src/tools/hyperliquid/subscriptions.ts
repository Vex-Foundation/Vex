import {
  SubscriptionClient,
  WebSocketTransport,
  type ISubscription,
} from "@nktkas/hyperliquid";

import { endpointsForNetwork, type HyperliquidNetwork } from "./constants.js";
import { parseHyperliquidCandle, type HyperliquidCandle } from "./candles.js";
import type { HyperliquidSubscriptionCallbacks } from "./types.js";

export { parseHyperliquidCandle as parseHyperliquidCandleEvent } from "./candles.js";

export interface HyperliquidCandleSubscriptionOptions {
  readonly network?: HyperliquidNetwork;
  readonly coin: string;
  readonly interval: HyperliquidCandle["interval"];
  readonly onCandle: (candle: HyperliquidCandle) => void | Promise<void>;
  readonly onError?: (cause: unknown) => void;
}

export interface HyperliquidSubscriptionOptions {
  readonly network?: HyperliquidNetwork;
  readonly user: `0x${string}`;
  readonly coin?: string;
  readonly callbacks: HyperliquidSubscriptionCallbacks;
}

/**
 * A start/stop-owned subscription bundle. The SDK transport supplies reconnect,
 * keep-alive, and re-subscription; this wrapper owns every resulting handle.
 */
export class HyperliquidSubscriptions {
  private transport: WebSocketTransport | null = null;
  private handles: ISubscription[] = [];
  private started = false;

  constructor(private readonly options: HyperliquidSubscriptionOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    const network = this.options.network ?? "mainnet";
    const transport = new WebSocketTransport({
      isTestnet: network === "testnet",
      url: endpointsForNetwork(network).websocket,
      resubscribe: true,
    });
    const client = new SubscriptionClient({ transport });
    const onError = (cause: unknown): void => this.options.callbacks.onError?.(cause);
    try {
      const handles = await Promise.all([
        client.userFills({ user: this.options.user }, (event) => this.options.callbacks.onUserFills?.(event), { onError }),
        client.orderUpdates({ user: this.options.user }, (event) => this.options.callbacks.onOrderUpdates?.(event), { onError }),
        client.userEvents({ user: this.options.user }, (event) => this.options.callbacks.onUserEvents?.(event), { onError }),
        ...(this.options.coin
          ? [client.activeAssetData({ user: this.options.user, coin: this.options.coin }, (event) => this.options.callbacks.onActiveAssetData?.(event), { onError })]
          : []),
      ]);
      // webData3 is preferred. Older nodes can reject it during the migration;
      // retain webData2 as the explicit compatibility fallback.
      try {
        handles.push(await client.webData3({ user: this.options.user }, () => undefined, { onError }));
      } catch (cause) {
        this.options.callbacks.onError?.(cause);
        handles.push(await client.webData2({ user: this.options.user }, () => undefined, { onError }));
      }
      this.transport = transport;
      this.handles = handles;
      this.started = true;
    } catch (cause) {
      transport.close();
      throw cause;
    }
  }

  async stop(): Promise<void> {
    const handles = this.handles;
    const transport = this.transport;
    this.handles = [];
    this.transport = null;
    this.started = false;
    await Promise.allSettled(handles.map((handle) => handle.unsubscribe()));
    transport?.close();
  }
}

/** One candle channel with an explicit lifecycle owner. Invalid events are dropped locally. */
export class HyperliquidCandleSubscriptions {
  private transport: WebSocketTransport | null = null;
  private handle: ISubscription | null = null;
  private started = false;

  constructor(private readonly options: HyperliquidCandleSubscriptionOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    const network = this.options.network ?? "mainnet";
    const transport = new WebSocketTransport({
      isTestnet: network === "testnet",
      url: endpointsForNetwork(network).websocket,
      resubscribe: true,
    });
    const client = new SubscriptionClient({ transport });
    const onError = (cause: unknown): void => this.options.onError?.(cause);
    try {
      const handle = await client.candle(
        { coin: this.options.coin, interval: this.options.interval },
        (event) => {
          try {
            const parsed = parseHyperliquidCandle(event);
            void Promise.resolve(this.options.onCandle(parsed)).catch(onError);
          } catch (cause) {
            onError(cause);
          }
        },
        { onError },
      );
      this.transport = transport;
      this.handle = handle;
      this.started = true;
    } catch (cause) {
      transport.close();
      throw cause;
    }
  }

  async stop(): Promise<void> {
    const handle = this.handle;
    const transport = this.transport;
    this.handle = null;
    this.transport = null;
    this.started = false;
    if (handle !== null) await handle.unsubscribe();
    transport?.close();
  }
}
