/** Per-wallet serialization for signing-sensitive Hyperliquid mutations. */

const tailsByWallet = new Map<string, Promise<void>>();

export async function withHyperliquidWalletMutationLock<T>(
  walletAddress: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = walletAddress.toLowerCase();
  const previous = tailsByWallet.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => { release = resolve; });
  tailsByWallet.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tailsByWallet.get(key) === tail) tailsByWallet.delete(key);
  }
}
