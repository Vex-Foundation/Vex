import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  writeUnlockedSecrets: vi.fn(),
  writeTradingKey: vi.fn(),
  deleteTradingKey: vi.fn(),
  getTradingRegistrationState: vi.fn(),
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../secrets/session.js", () => ({
  writeUnlockedSecrets: sessionMocks.writeUnlockedSecrets,
}));

vi.mock("../../secrets/lighter-trading-credential.js", () => ({
  writeUnlockedLighterTradingApiPrivateKey: (
    reference: unknown,
    privateKey: unknown,
  ) => sessionMocks.writeTradingKey(reference, privateKey),
  deleteUnlockedLighterTradingApiPrivateKey: (reference: unknown) =>
    sessionMocks.deleteTradingKey(reference),
  getUnlockedLighterTradingCredentialRegistrationState: (reference: unknown) =>
    sessionMocks.getTradingRegistrationState(reference),
}));

const { probeRobinhoodChainRpc, writeApiKeys } = await import("../api-keys-writer.js");

describe("writeApiKeys", () => {
  beforeEach(() => {
    sessionMocks.writeUnlockedSecrets.mockReset();
    sessionMocks.writeTradingKey.mockReset();
    sessionMocks.deleteTradingKey.mockReset();
    sessionMocks.getTradingRegistrationState.mockReset();
    sessionMocks.writeUnlockedSecrets.mockReturnValue({ ok: true, data: undefined });
    sessionMocks.writeTradingKey.mockReturnValue({
      present: true,
      reference: {
        kind: "encrypted_vault_reference",
      },
    });
    sessionMocks.deleteTradingKey.mockReturnValue({
      present: false,
      reference: {
        kind: "encrypted_vault_reference",
      },
    });
    sessionMocks.getTradingRegistrationState.mockReturnValue(null);
  });

  it("returns empty fieldsWritten when nothing is submitted", async () => {
    const result = await writeApiKeys({});
    expect(result).toEqual({ ok: true, data: { fieldsWritten: [] } });
    expect(sessionMocks.writeUnlockedSecrets).not.toHaveBeenCalled();
  });

  it("stores JUPITER_API_KEY in the encrypted vault", async () => {
    const result = await writeApiKeys({ jupiterApiKey: "sk-jup-xyz" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.fieldsWritten).toEqual(["JUPITER_API_KEY"]);
    expect(sessionMocks.writeUnlockedSecrets).toHaveBeenCalledWith({
      JUPITER_API_KEY: "sk-jup-xyz",
    });
  });

  it("verifies and stores the managed Robinhood Chain RPC in the encrypted vault", async () => {
    const endpoint =
      "https://robinhood-mainnet.g.alchemy.com/v2/test-managed-key";
    const probe = vi.fn().mockResolvedValue(undefined);
    const result = await writeApiKeys(
      { robinhoodChainRpcUrl: endpoint },
      { probeRobinhoodChainRpc: probe },
    );

    expect(result).toEqual({
      ok: true,
      data: { fieldsWritten: ["ROBINHOOD_CHAIN_RPC_URL"] },
    });
    expect(probe).toHaveBeenCalledWith(endpoint);
    expect(sessionMocks.writeUnlockedSecrets).toHaveBeenCalledWith({
      ROBINHOOD_CHAIN_RPC_URL: endpoint,
    });
  });

  it("rejects the bundled public Robinhood RPC as a production endpoint", async () => {
    const probe = vi.fn();
    const result = await writeApiKeys(
      { robinhoodChainRpcUrl: "https://rpc.mainnet.chain.robinhood.com/" },
      { probeRobinhoodChainRpc: probe },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("rate-limited");
      expect(result.error.message).not.toContain("https://");
    }
    expect(probe).not.toHaveBeenCalled();
    expect(sessionMocks.writeUnlockedSecrets).not.toHaveBeenCalled();
  });

  it("fails closed without storing an RPC endpoint that does not pass the live probe", async () => {
    const endpoint = "https://wrong-chain.example.test/key";
    const result = await writeApiKeys(
      { robinhoodChainRpcUrl: endpoint },
      {
        probeRobinhoodChainRpc: vi.fn().mockRejectedValue(
          new Error(`provider rejected ${endpoint}`),
        ),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("could not verify");
      expect(result.error.message).not.toContain(endpoint);
    }
    expect(sessionMocks.writeUnlockedSecrets).not.toHaveBeenCalled();
  });

  it("imports a Lighter trading API private key through the extra-secret vault boundary", async () => {
    const privateKey = `0x${"1".repeat(80)}`;
    const result = await writeApiKeys({
      lighterRhcTradingAccountIndex: 1171,
      lighterRhcTradingApiKeyIndex: 7,
      lighterRhcTradingApiPrivateKey: `  ${privateKey}  `,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fieldsWritten).toEqual([
        "LIGHTER_RHC_TRADING_API_PRIVATE_KEY",
      ]);
    }
    expect(sessionMocks.writeUnlockedSecrets).not.toHaveBeenCalled();
    expect(sessionMocks.writeTradingKey).toHaveBeenCalledWith(
      {
        kind: "encrypted_vault_reference",
        environment: "rhc",
        accountIndex: 1171,
        apiKeyIndex: 7,
        vaultCredentialId: "lighter/rhc/account-1171/api-key-7",
      },
      privateKey,
    );
    expect(sessionMocks.deleteTradingKey).not.toHaveBeenCalled();
  });

  it("removes a Lighter trading API private key by exact account/API-key scope", async () => {
    const result = await writeApiKeys({
      lighterCoreTradingAccountIndex: 42,
      lighterCoreTradingApiKeyIndex: 9,
      lighterCoreTradingRemove: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fieldsWritten).toEqual([
        "LIGHTER_CORE_TRADING_API_PRIVATE_KEY",
      ]);
    }
    expect(sessionMocks.writeUnlockedSecrets).not.toHaveBeenCalled();
    expect(sessionMocks.deleteTradingKey).toHaveBeenCalledWith({
      kind: "encrypted_vault_reference",
      environment: "core",
      accountIndex: 42,
      apiKeyIndex: 9,
      vaultCredentialId: "lighter/core/account-42/api-key-9",
    });
  });

  it("refuses to overwrite or remove a Vex-managed registered credential", async () => {
    sessionMocks.getTradingRegistrationState.mockReturnValue("key_registered_active");

    const result = await writeApiKeys({
      jupiterApiKey: "new-jupiter-key",
      lighterCoreTradingAccountIndex: 737810,
      lighterCoreTradingApiKeyIndex: 4,
      lighterCoreTradingRemove: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Vex manages the registered Lighter CORE credential");
      expect(result.error.message).toContain("orphan the registered key");
      expect(result.error.message).not.toContain("private");
    }
    expect(sessionMocks.writeUnlockedSecrets).not.toHaveBeenCalled();
    expect(sessionMocks.deleteTradingKey).not.toHaveBeenCalled();
    expect(sessionMocks.writeTradingKey).not.toHaveBeenCalled();
  });

  it("rejects Lighter trading changes without an exact account/API-key scope", async () => {
    const result = await writeApiKeys({
      lighterRhcTradingApiPrivateKey: `0x${"1".repeat(80)}`,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("provider.invalid_api_key");
      expect(result.error.message).toContain("account index and API-key index");
    }
    expect(sessionMocks.writeUnlockedSecrets).not.toHaveBeenCalled();
    expect(sessionMocks.writeTradingKey).not.toHaveBeenCalled();
  });

  it("rejects simultaneous Lighter trading remove and replace", async () => {
    const result = await writeApiKeys({
      lighterRhcTradingAccountIndex: 1171,
      lighterRhcTradingApiKeyIndex: 7,
      lighterRhcTradingApiPrivateKey: `0x${"1".repeat(80)}`,
      lighterRhcTradingRemove: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not both");
    expect(sessionMocks.writeTradingKey).not.toHaveBeenCalled();
    expect(sessionMocks.deleteTradingKey).not.toHaveBeenCalled();
  });

  it("returns fieldsWritten in canonical order", async () => {
    const result = await writeApiKeys({
      rettiwtApiKey: "r",
      tavilyApiKey: "t",
      jupiterApiKey: "j",
      lighterRhcTradingAccountIndex: 1171,
      lighterRhcTradingApiKeyIndex: 7,
      lighterRhcTradingApiPrivateKey: `0x${"1".repeat(80)}`,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fieldsWritten).toEqual([
        "JUPITER_API_KEY",
        "TAVILY_API_KEY",
        "RETTIWT_API_KEY",
        "LIGHTER_RHC_TRADING_API_PRIVATE_KEY",
      ]);
    }
  });

  it("returns the locked-vault error from the secret session", async () => {
    sessionMocks.writeUnlockedSecrets.mockReturnValue({
      ok: false,
      error: {
        code: "wallet.keystore_locked",
        domain: "wallet",
        message: "Unlock Vex first.",
        retryable: false,
        userActionable: true,
        redacted: true,
      },
    });

    const result = await writeApiKeys({ jupiterApiKey: "j" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("wallet.keystore_locked");
  });
});

describe("probeRobinhoodChainRpc", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubRpc(results: Readonly<Record<string, unknown>>): void {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { readonly method: string };
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: results[request.method],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
  }

  it("accepts chain 4663 with a fresh block and fee history", async () => {
    const nowHex = `0x${Math.floor(Date.now() / 1_000).toString(16)}`;
    stubRpc({
      eth_chainId: "0x1237",
      eth_getBlockByNumber: { number: "0x1", timestamp: nowHex },
      eth_feeHistory: { oldestBlock: "0x1", baseFeePerGas: ["0x1", "0x2", "0x3"] },
    });

    await expect(probeRobinhoodChainRpc(
      "https://robinhood-mainnet.g.alchemy.com/v2/test-key",
    )).resolves.toBeUndefined();
  });

  it("rejects a healthy endpoint on the wrong chain", async () => {
    const nowHex = `0x${Math.floor(Date.now() / 1_000).toString(16)}`;
    stubRpc({
      eth_chainId: "0x1",
      eth_getBlockByNumber: { number: "0x1", timestamp: nowHex },
      eth_feeHistory: { oldestBlock: "0x1", baseFeePerGas: ["0x1", "0x2", "0x3"] },
    });

    await expect(probeRobinhoodChainRpc(
      "https://ethereum.example.test/key",
    )).rejects.toThrow("rpc_wrong_chain");
  });

  it("rejects a stale Robinhood Chain block head", async () => {
    const staleHex = `0x${(Math.floor(Date.now() / 1_000) - 600).toString(16)}`;
    stubRpc({
      eth_chainId: "0x1237",
      eth_getBlockByNumber: { number: "0x1", timestamp: staleHex },
      eth_feeHistory: { oldestBlock: "0x1", baseFeePerGas: ["0x1", "0x2", "0x3"] },
    });

    await expect(probeRobinhoodChainRpc(
      "https://stale.example.test/key",
    )).rejects.toThrow("rpc_stale_block");
  });
});
