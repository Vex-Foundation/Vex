import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebContents, createTrustedSender, type TestIpcEvent } from "./test-sender.js";
import type { VexConfig } from "@config/store.js";
import type { Result } from "@shared/ipc/result.js";
import type { ChainEndpoints } from "@shared/schemas/chain-endpoints.js";
type Handler = (event: TestIpcEvent, raw: unknown) => Promise<Result<ChainEndpoints>>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => {
  const config: Pick<VexConfig, "localChainRpcUrls" | "blockscoutBaseUrls"> = {
    localChainRpcUrls: { "1": "https://existing.example" }, blockscoutBaseUrls: {},
  };
  return { config, saveConfig: vi.fn() };
});
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) }, app: { isPackaged: true } }));
vi.mock("@config/store.js", () => ({ loadConfig: () => mocks.config, saveConfig: (config: VexConfig) => { mocks.saveConfig(config); mocks.config = config; } }));
vi.mock("../../logger/index.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { registerChainEndpointSettingsHandlers } from "../settings-chain-endpoints.js";
import { CH } from "@shared/ipc/channels.js";
const sender = createTrustedSender({ sender: createTestWebContents() });
const invoke = (channel: string, payload: unknown, event: TestIpcEvent = sender): Promise<Result<ChainEndpoints>> => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error("Settings handler was not registered");
  return handler(event, { requestId: "00000000-0000-4000-8000-000000000222", payload });
};
function dataOf(result: Result<ChainEndpoints>): ChainEndpoints {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected settings success");
  return result.data;
}
beforeEach(() => { vi.clearAllMocks(); handlers.clear(); mocks.config = { localChainRpcUrls: { "1": "https://existing.example" }, blockscoutBaseUrls: {} }; registerChainEndpointSettingsHandlers(); });
describe("chain endpoint settings", () => {
  it("saves both overrides per chain, reads them back, and clears to defaults", async () => {
    const input = { chainId: 4663, rpcUrl: "http://192.168.1.20:8545", blockscoutBaseUrl: "https://proxy.example/rhc/" };
    expect((await invoke(CH.settings.setChainEndpoints, input)).ok).toBe(true);
    expect(dataOf(await invoke(CH.settings.getChainEndpoints, { chainId: 4663 }))).toEqual({ ...input, blockscoutBaseUrl: "https://proxy.example/rhc" });
    expect(mocks.config.localChainRpcUrls?.["1"]).toBe("https://existing.example");
    expect((await invoke(CH.settings.setChainEndpoints, { chainId: 4663, rpcUrl: null, blockscoutBaseUrl: null })).ok).toBe(true);
    expect(dataOf(await invoke(CH.settings.getChainEndpoints, { chainId: 4663 }))).toEqual({ chainId: 4663, rpcUrl: null, blockscoutBaseUrl: null });
  });
  it.each(["http://public.example", "https://user:secret-value@example.com", "https://example.com?key=secret-value"])("rejects invalid Blockscout URLs by name before writing", async (blockscoutBaseUrl) => {
    const result = await invoke(CH.settings.setChainEndpoints, { chainId: 4663, rpcUrl: null, blockscoutBaseUrl });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected named URL refusal");
    expect(result.error.message).toContain("BLOCKSCOUT_OVERRIDE_INVALID");
    expect(result.error.message).not.toContain(blockscoutBaseUrl);
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });
  it("rejects invalid chain IDs and unknown fields", async () => {
    expect((await invoke(CH.settings.setChainEndpoints, { chainId: -1, rpcUrl: null, blockscoutBaseUrl: null })).ok).toBe(false);
    expect((await invoke(CH.settings.setChainEndpoints, { chainId: 4663, rpcUrl: null, blockscoutBaseUrl: null, authority: true })).ok).toBe(false);
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });
  it("rejects an untrusted sender before saving", async () => {
    const untrusted = { ...sender, senderFrame: { ...sender.senderFrame, url: "https://evil.example" } };
    expect((await invoke(CH.settings.setChainEndpoints, { chainId: 4663, rpcUrl: null, blockscoutBaseUrl: "https://proxy.example" }, untrusted)).ok).toBe(false);
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });
});
