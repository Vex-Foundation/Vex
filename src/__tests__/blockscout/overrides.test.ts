import { afterEach, describe, expect, it, vi } from "vitest";
const config = vi.hoisted(() => ({ blockscoutBaseUrls: {} as Record<string, string> }));
vi.mock("@config/store.js", () => ({ loadConfig: () => config }));
import { getUserBlockscoutOverrideForChain, validateBlockscoutBaseUrl } from "@config/chain-blockscout-overrides.js";
import { buildRobinhoodTokenBalancesUrl, getBlockscoutBaseUrlForChain, isExactRobinhoodTokenBalancesUrl } from "@tools/blockscout/operation.js";
import { readRobinhoodErc20IdentityCandidates } from "@tools/blockscout/client.js";
import { registerBlockscoutTransport } from "@tools/blockscout/transport.js";
afterEach(() => { config.blockscoutBaseUrls = {}; });
const address = "0x0000000000000000000000000000000000000001";
describe("user Blockscout overrides", () => {
  it("keeps the public default when absent", () => {
    expect(getUserBlockscoutOverrideForChain(4663)).toBeUndefined();
    expect(getBlockscoutBaseUrlForChain(4663)).toBe("https://robinhoodchain.blockscout.com");
  });
  it.each(["https://proxy.example/private", "https://192.168.1.2/blockscout", "http://127.0.0.1:8080/rhc", "http://localhost:8080", "http://[::1]:8080"])("honours owner endpoint %s", (base) => {
    config.blockscoutBaseUrls["4663"] = base;
    const url = buildRobinhoodTokenBalancesUrl(address);
    expect(url.toString()).toBe(`${base}/api/v2/addresses/${address}/token-balances`);
    expect(isExactRobinhoodTokenBalancesUrl(url.toString(), url)).toBe(true);
    expect(isExactRobinhoodTokenBalancesUrl(`${url}?redirect=1`, url)).toBe(false);
    expect(isExactRobinhoodTokenBalancesUrl(`https://other.example${url.pathname}`, url)).toBe(false);
  });
  it.each(["garbage", "https:example.com", "http://example.com", "https://user:private-value@example.com", "https://example.com?api_key=private-value", "https://example.com/#private-value", "file:///tmp/test", "https://bad host"])("refuses invalid input by name without echo: %s", (raw) => {
    expect(() => validateBlockscoutBaseUrl(raw)).toThrow(expect.objectContaining({ code: "BLOCKSCOUT_OVERRIDE_INVALID" }));
    try { validateBlockscoutBaseUrl(raw); } catch (error) { expect(String(error)).not.toContain(raw); }
  });
  it("the client accepts inventory from the configured host and prefix", async () => {
    config.blockscoutBaseUrls["4663"] = "https://proxy.example/rhc";
    const release = registerBlockscoutTransport({ name: "electron_net", fetchAddressTokenBalances: async () => ({
      finalUrl: `https://proxy.example/rhc/api/v2/addresses/${address}/token-balances`, status: 200,
      contentType: "application/json", body: new TextEncoder().encode("[]"),
    }) });
    try { expect((await readRobinhoodErc20IdentityCandidates(address)).inventoryComplete).toBe(true); }
    finally { release(); }
  });
  it("refuses an invalid stored override rather than silently using public host", async () => {
    config.blockscoutBaseUrls["4663"] = "http://example.com";
    expect(() => buildRobinhoodTokenBalancesUrl(address)).toThrow(expect.objectContaining({ code: "BLOCKSCOUT_OVERRIDE_INVALID" }));
  });
});
