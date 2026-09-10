/** Real loopback failover with no public endpoint or broadcast method. */
import { createServer, type Server } from "node:http";
import { createPublicClient, defineChain, type PublicClient, type Transport, type Chain } from "viem";
import { buildEvmTransport } from "@tools/evm-chains/rpc-transport.js";
import { resolveRpcEndpoints } from "@tools/evm-chains/rpc-endpoints.js";

export async function rpcExhaustionFixture(chainId: number): Promise<{
  client: PublicClient<Transport, Chain>;
  seen: readonly (readonly string[])[];
  close(): Promise<void>;
}> {
  const seen: string[][] = [];
  const nodes: { server: Server; url: string }[] = [];
  for (let index = 0; index < 3; index++) {
    const methods: string[] = [];
    seen.push(methods);
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += String(chunk); });
      request.on("end", () => {
        const rpc = JSON.parse(body) as { id: number; method: string };
        methods.push(rpc.method);
        response.writeHead(rpc.method === "eth_chainId" ? 200 : 429, { "content-type": "application/json" });
        response.end(JSON.stringify(rpc.method === "eth_chainId"
          ? { jsonrpc: "2.0", id: rpc.id, result: `0x${chainId.toString(16)}` }
          : { jsonrpc: "2.0", id: rpc.id, error: { code: 429, message: "rate limit" } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback listener unavailable");
    nodes.push({ server, url: `http://127.0.0.1:${address.port}` });
  }
  const urls = nodes.map(n => n.url);
  const client = createPublicClient({ chain: defineChain({ id: chainId, name: "RPC refusal fixture",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: urls } } }),
    transport: buildEvmTransport(chainId, { providerUrls: urls,
      disqualifiedUrls: new Set(resolveRpcEndpoints(chainId).map(e => e.url)) }) });
  return { client, seen, close: async () => {
    await Promise.all(nodes.map(({ server }) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  } };
}
