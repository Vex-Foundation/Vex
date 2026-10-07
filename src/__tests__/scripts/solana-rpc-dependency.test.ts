import path from "node:path";
import { describe, it } from "vitest";
import { verifyInstalledSolanaDependency, verifyInstalledSolanaTransport } from "../helpers/solana-rpc-dependency.js";

const projectRoot = path.resolve(import.meta.dirname, "../../..");

describe("installed root Solana RPC dependency", () => {
  it("removes stream-json and preserves the reviewed browser parser graph and unsafe-key semantics", async () => {
    await verifyInstalledSolanaDependency(projectRoot);
  });

  it("uses the installed SDK over real HTTP for chunked Unicode, generated IDs, batches and failures", async () => {
    await verifyInstalledSolanaTransport(projectRoot);
  });
});
