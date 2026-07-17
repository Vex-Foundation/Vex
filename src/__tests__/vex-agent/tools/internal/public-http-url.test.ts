import { describe, it, expect } from "vitest";
import {
  assertPublicHttpUrl,
  isBlockedIp,
  isHttpUrl,
  tryDecimalIpv4,
  PublicHttpUrlError,
} from "../../../../vex-agent/tools/internal/public-http-url.js";

describe("isHttpUrl", () => {
  it("allows http and https only", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("http://example.com/path")).toBe(true);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("gopher://x")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});

describe("isBlockedIp", () => {
  it("blocks loopback and private IPv4", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("127.1.2.3")).toBe(true);
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("172.31.255.255")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("100.64.0.1")).toBe(true);
    expect(isBlockedIp("0.0.0.0")).toBe(true);
  });

  it("allows public IPv4 examples", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("1.1.1.1")).toBe(false);
    expect(isBlockedIp("93.184.216.34")).toBe(false); // example.com-ish public
  });

  it("blocks IPv6 loopback, link-local, ULA", () => {
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("fd12:3456:789a::1")).toBe(true);
    expect(isBlockedIp("fc00::1")).toBe(true);
  });

  it("blocks IPv4-mapped private", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.1")).toBe(true);
  });
});

describe("tryDecimalIpv4", () => {
  it("maps 2130706433 to 127.0.0.1", () => {
    expect(tryDecimalIpv4("2130706433")).toBe("127.0.0.1");
  });

  it("returns null for non-decimal hostnames", () => {
    expect(tryDecimalIpv4("example.com")).toBeNull();
    expect(tryDecimalIpv4("127.0.0.1")).toBeNull();
  });
});

describe("assertPublicHttpUrl", () => {
  it("rejects private literal IPs without DNS", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1/secret")).rejects.toMatchObject({
      code: "private_destination",
    });
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({
      code: "private_destination",
    });
    await expect(assertPublicHttpUrl("http://192.168.0.1/")).rejects.toMatchObject({
      code: "private_destination",
    });
  });

  it("rejects localhost hostname", async () => {
    await expect(assertPublicHttpUrl("http://localhost:8080/")).rejects.toMatchObject({
      code: "private_destination",
    });
  });

  it("rejects decimal loopback hostname", async () => {
    await expect(assertPublicHttpUrl("http://2130706433/secret")).rejects.toMatchObject({
      code: "private_destination",
    });
  });

  it("rejects file scheme", async () => {
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toMatchObject({
      code: "scheme",
    });
  });

  it("rejects embedded credentials", async () => {
    await expect(
      assertPublicHttpUrl("http://user:pass@example.com/"),
    ).rejects.toMatchObject({ code: "invalid_url" });
  });

  it("rejects DNS that resolves to private IP (rebinding-style)", async () => {
    await expect(
      assertPublicHttpUrl("http://evil.example/", {
        lookup: async () => "127.0.0.1",
      }),
    ).rejects.toMatchObject({ code: "private_destination" });

    await expect(
      assertPublicHttpUrl("http://evil.example/", {
        lookup: async () => "10.1.2.3",
      }),
    ).rejects.toMatchObject({ code: "private_destination" });
  });

  it("allows public host when DNS returns public IP", async () => {
    const result = await assertPublicHttpUrl("https://example.com/path", {
      lookup: async () => "93.184.216.34",
    });
    expect(result.address).toBe("93.184.216.34");
    expect(result.url.hostname).toBe("example.com");
  });

  it("surfaces PublicHttpUrlError with stable name", async () => {
    try {
      await assertPublicHttpUrl("http://127.0.0.1/");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PublicHttpUrlError);
      expect((e as PublicHttpUrlError).name).toBe("PublicHttpUrlError");
    }
  });
});
