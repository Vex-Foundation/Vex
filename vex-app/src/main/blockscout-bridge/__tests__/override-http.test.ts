import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
const config = vi.hoisted(() => ({ blockscoutBaseUrls: {} as Record<string, string> }));
vi.mock("@config/store.js", () => ({ loadConfig: () => config }));
import { fetchBlockscoutAddressTokenBalances } from "../http.js";
import { readBlockscoutErc20IdentityCandidates } from "@tools/blockscout/client.js";
import { registerBlockscoutTransport } from "@tools/blockscout/transport.js";
afterEach(() => { config.blockscoutBaseUrls = {}; });
const ROBINHOOD_CHAIN_ID = 4663;
it("reads complete inventory through the user loopback proxy prefix with real HTTP bytes", async () => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No listener");
  config.blockscoutBaseUrls["4663"] = `http://127.0.0.1:${address.port}/rhc`;
  const release = registerBlockscoutTransport({ name: "electron_net",
    fetchAddressTokenBalances: (chainId, wallet, options) => fetchBlockscoutAddressTokenBalances(fetch, chainId, wallet, options) });
  try {
    const result = await readBlockscoutErc20IdentityCandidates(ROBINHOOD_CHAIN_ID, "0x0000000000000000000000000000000000000001");
    expect(result.inventoryComplete).toBe(true);
    expect(paths).toEqual(["/rhc/api/v2/addresses/0x0000000000000000000000000000000000000001/token-balances"]);
  } finally {
    release();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
