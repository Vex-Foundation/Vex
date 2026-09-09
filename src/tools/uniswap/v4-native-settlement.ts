/** Native v4 settlement requires executed value transfers, including refunds. */
import { z } from "zod";
import type { Address, Hex } from "viem";
import type { UniswapDeployment } from "./deployments.js";
import type { getUniswapPublicClient } from "./evm-client.js";

interface CallFrame {
  readonly type: string; readonly from: string; readonly to?: string;
  readonly value?: string; readonly error?: string; readonly calls?: readonly CallFrame[];
}
const address = z.string().regex(/^0x[\da-fA-F]{40}$/);
const frameSchema: z.ZodType<CallFrame> = z.lazy(() => z.object({
  type: z.string(), from: address, to: address.optional(), value: z.string().regex(/^0x[\da-fA-F]+$/).optional(),
  error: z.string().optional(), calls: z.array(frameSchema).optional(),
}));
export function decodeV4NativeDelta(trace: unknown, wallet: Address, router: Address): bigint | undefined {
  const parsed = frameSchema.safeParse(trace);
  if (!parsed.success) return undefined;
  const root = parsed.data;
  if (root.error || root.type !== "CALL" || root.from.toLowerCase() !== wallet.toLowerCase() || root.to?.toLowerCase() !== router.toLowerCase()) return undefined;
  let delta = 0n;
  const walk = (frame: CallFrame): void => {
    // Reverted frames and all their children commit no transfers. Delegatecall
    // value is inherited context, not another payment.
    if (frame.error) return;
    if (["CALL", "CREATE", "CREATE2", "SELFDESTRUCT"].includes(frame.type)) {
      const value = BigInt(frame.value ?? "0x0");
      if (frame.from.toLowerCase() === wallet.toLowerCase()) delta -= value;
      if (frame.to?.toLowerCase() === wallet.toLowerCase()) delta += value;
    }
    for (const child of frame.calls ?? []) walk(child);
  };
  walk(root);
  return delta;
}
export async function readV4NativeDelta(client: ReturnType<typeof getUniswapPublicClient>, deployment: UniswapDeployment, txHash: Hex, wallet: Address): Promise<bigint | undefined> {
  if (!deployment.v4) return undefined;
  try {
    const trace: unknown = await client.transport.request({ method: "debug_traceTransaction", params: [txHash, { tracer: "callTracer" }] });
    return decodeV4NativeDelta(trace, wallet, deployment.v4.universalRouter);
  } catch {
    // Receipt success is independent of trace availability. No native amount
    // is guessed; the durable pending-amounts state remains repairable.
    return undefined;
  }
}
