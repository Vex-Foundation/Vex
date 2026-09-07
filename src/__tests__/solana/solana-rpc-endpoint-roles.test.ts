/**
 * The two Solana endpoint roles, and the rule that decides between them.
 *
 * Solana has no transport list - `@solana/web3.js`'s `Connection` takes ONE url
 * - so the whole decision is which url, per role, and whether the user's own
 * endpoint wins. Three properties matter enough to assert:
 *
 *  1. a read connection takes the measured-faster endpoint;
 *  2. a BROADCAST connection stays on the endpoint this repository has always
 *     broadcast through, because `sendTransaction` was never probed on the
 *     other one and a read measurement is not broadcast evidence;
 *  3. a user's own endpoint overrides both, including one written by a past
 *     install, without a config migration.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadConfig = vi.fn();
vi.mock("../../config/store.js", () => ({ loadConfig: () => mockLoadConfig() }));

const { resolveSolanaRpcUrl } = await import(
  "@tools/solana-ecosystem/shared/solana-transaction/connection.js"
);

const READ = "https://solana-rpc.publicnode.com";
const BROADCAST = "https://api.mainnet-beta.solana.com";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveSolanaRpcUrl", () => {
  it("reads from the faster measured endpoint and broadcasts from the proven one", () => {
    mockLoadConfig.mockReturnValue({ solana: { rpcUrl: BROADCAST } });
    expect(resolveSolanaRpcUrl("read")).toBe(READ);
    expect(resolveSolanaRpcUrl("broadcast")).toBe(BROADCAST);
  });

  it("defaults to the read role", () => {
    mockLoadConfig.mockReturnValue({ solana: { rpcUrl: BROADCAST } });
    expect(resolveSolanaRpcUrl()).toBe(READ);
  });

  it("lets the user's own endpoint serve BOTH roles", () => {
    mockLoadConfig.mockReturnValue({ solana: { rpcUrl: "https://solana.example.test/mine" } });
    expect(resolveSolanaRpcUrl("read")).toBe("https://solana.example.test/mine");
    expect(resolveSolanaRpcUrl("broadcast")).toBe("https://solana.example.test/mine");
  });

  it("supersedes a bundled default a past install wrote into config.json", () => {
    // The stored value IS the endpoint this repository used to ship, so it is a
    // bundled default rather than a user choice, and the table's read answer
    // replaces it. Without this, a measured endpoint change would reach new
    // installs only.
    mockLoadConfig.mockReturnValue({ solana: { rpcUrl: BROADCAST } });
    expect(resolveSolanaRpcUrl("read")).toBe(READ);
  });

  it("treats an empty or whitespace configured endpoint as unset", () => {
    mockLoadConfig.mockReturnValue({ solana: { rpcUrl: "   " } });
    expect(resolveSolanaRpcUrl("read")).toBe(READ);
    mockLoadConfig.mockReturnValue({ solana: {} });
    expect(resolveSolanaRpcUrl("broadcast")).toBe(BROADCAST);
  });
});
