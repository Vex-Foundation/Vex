/** Five read-only fee samples per configured execution endpoint. Never prints RPC URLs or provider error bodies. */
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { resolveRpcEndpoints } from "@tools/evm-chains/rpc-endpoints.js";

const hexQuantity = z.string().regex(/^0x[0-9a-fA-F]+$/);
const blockResponse = z.object({ result: z.object({
  number: hexQuantity, timestamp: hexQuantity, baseFeePerGas: hexQuantity,
}) });

async function measure(): Promise<void> {
  for (let sample = 0; sample < 5; sample++) {
    for (const chainId of [4663, 8453]) {
      const endpoint = resolveRpcEndpoints(chainId).find((entry) => entry.broadcastSafe);
      if (endpoint === undefined) throw new Error(`No execution RPC is configured for chain ${chainId}`);
      const start = performance.now();
      try {
        const response = await fetch(endpoint.url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
          signal: AbortSignal.timeout(15_000),
        });
        const parsed = blockResponse.safeParse(await response.json());
        if (!response.ok || !parsed.success) throw new Error("Unreadable fee sample");
        const block = parsed.data.result;
        console.log(JSON.stringify({ sample, chainId, at: new Date().toISOString(), tier: endpoint.tier,
          elapsedMs: Math.round(performance.now() - start), block: block.number,
          baseFeePerGasWei: BigInt(block.baseFeePerGas).toString(), blockTimestamp: block.timestamp }));
      } catch {
        console.log(JSON.stringify({ sample, chainId, at: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - start), error: "rpc_unreadable" }));
      }
    }
    if (sample < 4) await setTimeout(45_000);
  }
}

measure().catch(() => { console.error("Read-only fee measurement failed"); process.exitCode = 1; });
