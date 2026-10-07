import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { once } from "node:events";
import assert from "node:assert/strict";
import { requireValue } from "./require-value.js";

interface RpcRequest {
  readonly jsonrpc: string;
  readonly method: string;
  readonly params: readonly unknown[];
  readonly id: string;
}
interface SdkConnection {
  getVersion(): Promise<{ "solana-core": string; "feature-set": number }>;
  getSlot(): Promise<number>;
  getParsedTransactions(signatures: string[], commitment: string): Promise<readonly null[]>;
}
interface SdkModule {
  Connection: new (url: string, config: { httpAgent: false; disableRetryOnRateLimit: true }) => SdkConnection;
}

export async function verifyInstalledSolanaDependency(projectRoot: string): Promise<void> {
  const specifier = new URL("../../../scripts/verify-solana-rpc-dependency.mjs", import.meta.url).href;
  const loaded = await import(specifier) as {
    verifySolanaRpcDependency(project: string): Promise<void>;
  };
  await loaded.verifySolanaRpcDependency(projectRoot);
}

export async function verifyInstalledSolanaTransport(projectRoot: string): Promise<void> {
  const requests: RpcRequest[][] = [];
  let mode: "normal" | "malformed" | "rpc-error" = "normal";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: RpcRequest | RpcRequest[] = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const messages = Array.isArray(body) ? body : [body];
    requests.push(messages);
    response.writeHead(200, { "Content-Type": "application/json" });
    if (mode === "malformed") {
      response.end('{"result":]');
      return;
    }
    const replies = messages.map(({ id, method }) => {
      if (mode === "rpc-error") return { jsonrpc: "2.0", id, error: { code: -32000, message: "controlled RPC failure" } };
      const result = method === "getVersion" ? { "solana-core": "local-λ🌍", "feature-set": 42 }
        : method === "getSlot" ? 12345 : null;
      return { jsonrpc: "2.0", id, result };
    });
    const encoded = Buffer.from(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
    const unicode = encoded.indexOf(Buffer.from("🌍"));
    const split = unicode >= 0 ? unicode + 1 : Math.floor(encoded.length / 2);
    response.write(encoded.subarray(0, split));
    setImmediate(() => response.end(encoded.subarray(split)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = requireValue(server.address());
    if (typeof address === "string") throw new Error("Expected local TCP address");
    const projectRequire = createRequire(path.join(projectRoot, "package.json"));
    const sdk = projectRequire("@solana/web3.js") as SdkModule;
    const connection = new sdk.Connection(`http://127.0.0.1:${address.port}`, {
      httpAgent: false, disableRetryOnRateLimit: true,
    });
    assert.deepEqual(await connection.getVersion(), { "solana-core": "local-λ🌍", "feature-set": 42 });
    assert.equal(await connection.getSlot(), 12345);
    assert.deepEqual(await connection.getParsedTransactions(["first", "second"], "confirmed"), [null, null]);
    assert.deepEqual(requests.map((batch) => batch.map(({ method }) => method)), [
      ["getVersion"], ["getSlot"], ["getTransaction", "getTransaction"],
    ]);
    const ids = requests.flat().map(({ id }) => id);
    assert.equal(new Set(ids).size, 4);
    for (const message of requests.flat()) {
      assert.equal(message.jsonrpc, "2.0");
      assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert(Array.isArray(message.params));
    }
    mode = "malformed";
    await assert.rejects(connection.getVersion());
    mode = "rpc-error";
    await assert.rejects(connection.getSlot(), /controlled RPC failure/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
