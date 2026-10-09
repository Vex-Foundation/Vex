import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: { fetch: vi.fn() } }));
import { createDesktopRpcFetch } from "../desktop-fetch.js";

const URL = "https://rpc.mainnet.chain.robinhood.com";

describe("desktop RPC HTTP adapter", () => {
  it("keeps the official request, body and cancellation on native networking without cookie authority or redirects", async () => {
    const native = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"result":"0x1237"}'));
    const standard = vi.fn<typeof fetch>();
    const signal = new AbortController().signal;
    const body = '{"jsonrpc":"2.0","method":"eth_sendRawTransaction","params":["0x02"],"id":1}';
    await createDesktopRpcFetch(native, standard)(URL, { method: "POST", body, signal });
    expect(native).toHaveBeenCalledExactlyOnceWith(URL, {
      method: "POST", body, signal, credentials: "omit", redirect: "error",
    });
    expect(standard).not.toHaveBeenCalled();
  });

  it("does not retry or fall back when a native broadcast fails", async () => {
    const refusal = new Error("transport unavailable");
    const native = vi.fn<typeof fetch>().mockRejectedValue(refusal);
    const standard = vi.fn<typeof fetch>();
    await expect(createDesktopRpcFetch(native, standard)(URL, { method: "POST", body: "fixture-signed-material" }))
      .rejects.toBe(refusal);
    expect(native).toHaveBeenCalledTimes(1);
    expect(standard).not.toHaveBeenCalled();
  });

  it.each([
    "https://robinhood-rpc.publicnode.com",
    "https://rpc.mainnet.chain.robinhood.com.evil.invalid/",
    "https://rpc.mainnet.chain.robinhood.com/private?token=fixture",
    "https://user:fixture@rpc.mainnet.chain.robinhood.com/",
    "http://rpc.mainnet.chain.robinhood.com/",
    "http://localhost:8545",
    "not-a-url",
  ])("preserves the existing transport for %s", async (input) => {
    const native = vi.fn<typeof fetch>();
    const standard = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const init = { method: "POST", body: "fixture", redirect: "manual" as const };
    await createDesktopRpcFetch(native, standard)(input, init);
    expect(standard).toHaveBeenCalledExactlyOnceWith(input, init);
    expect(native).not.toHaveBeenCalled();
  });
});
