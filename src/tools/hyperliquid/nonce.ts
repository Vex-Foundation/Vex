/**
 * Per-address monotonic milliseconds allocator. The Exchange nonce window
 * accepts timestamps; bursts in one clock millisecond must still be unique.
 */
export class HyperliquidNonceAllocator {
  private readonly lastByAddress = new Map<string, number>();

  next(address: string, now = Date.now()): number {
    const key = address.toLowerCase();
    const last = this.lastByAddress.get(key);
    const next = last === undefined ? now : Math.max(now, last + 1);
    this.lastByAddress.set(key, next);
    return next;
  }
}

/** One process-owned allocator shared by every Hyperliquid signer in this runtime. */
export const hyperliquidRuntimeNonceAllocator = new HyperliquidNonceAllocator();
