/**
 * The user MCP egress policy: which endpoints are accepted, and what the
 * transport's `fetch` refuses. Every network case runs against a real local
 * HTTP server, and the SSRF cases prove no socket reached it.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFunction } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkEndpoint, createUserMcpFetch, MAX_ENDPOINT_CHARS } from "@vex-agent/user-mcp/egress.js";
import { MAX_RESPONSE_BYTES } from "@vex-agent/user-mcp/limits.js";
import { isLoopbackIpAddress } from "@vex-agent/sync/rpc-egress-policy.js";

describe("checkEndpoint", () => {
  const cases: Array<[string, ReturnType<typeof checkEndpoint>]> = [
    ["https://mcp.example.com/mcp", { ok: true, endpoint: "https://mcp.example.com/mcp", networkScope: "public" }],
    ["https://mcp.example.com/mcp?team=a", { ok: true, endpoint: "https://mcp.example.com/mcp?team=a", networkScope: "public" }],
    ["http://localhost:3000/mcp", { ok: true, endpoint: "http://localhost:3000/mcp", networkScope: "local" }],
    ["http://127.0.0.1:8123/mcp", { ok: true, endpoint: "http://127.0.0.1:8123/mcp", networkScope: "local" }],
    ["https://127.8.9.10/mcp", { ok: true, endpoint: "https://127.8.9.10/mcp", networkScope: "local" }],
    ["http://[::1]:9000/mcp", { ok: true, endpoint: "http://[::1]:9000/mcp", networkScope: "local" }],
    ["https://93.184.216.34/mcp", { ok: true, endpoint: "https://93.184.216.34/mcp", networkScope: "public" }],
    ["http://mcp.example.com/mcp", { ok: false, code: "not_https" }],
    ["https://10.0.0.5/mcp", { ok: false, code: "private_address" }],
    ["https://192.168.1.20/mcp", { ok: false, code: "private_address" }],
    ["https://169.254.169.254/latest", { ok: false, code: "private_address" }],
    ["https://[fe80::1]/mcp", { ok: false, code: "private_address" }],
    ["https://[fd00::1]/mcp", { ok: false, code: "private_address" }],
    // The URL parser normalises these address forms to 127.0.0.1, which is
    // where the connection really goes: loopback, judged as loopback.
    ["https://0x7f.1/mcp", { ok: true, endpoint: "https://127.0.0.1/mcp", networkScope: "local" }],
    ["https://2130706433/mcp", { ok: true, endpoint: "https://127.0.0.1/mcp", networkScope: "local" }],
    ["https://0xa.1/mcp", { ok: false, code: "private_address" }],
    ["http://192.168.1.20/mcp", { ok: false, code: "not_https" }],
    ["https://user:pw@mcp.example.com/mcp", { ok: false, code: "credentials_in_url" }],
    ["https://mcp.example.com/mcp#frag", { ok: false, code: "fragment_in_url" }],
    ["ftp://mcp.example.com/mcp", { ok: false, code: "invalid_url" }],
    ["not a url", { ok: false, code: "invalid_url" }],
    [`https://mcp.example.com/${"a".repeat(MAX_ENDPOINT_CHARS)}`, { ok: false, code: "invalid_url" }],
  ];
  for (const [raw, expected] of cases) {
    it(`${raw.slice(0, 60)} -> ${expected.ok ? expected.networkScope : expected.code}`, () => {
      expect(checkEndpoint(raw)).toEqual(expected);
    });
  }

  it("classifies loopback addresses exactly", () => {
    for (const a of ["127.0.0.1", "127.255.0.9", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackIpAddress(a)).toBe(true);
    for (const a of ["128.0.0.1", "10.0.0.1", "::2", "fe80::1", "::ffff:10.0.0.1", "localhost"]) expect(isLoopbackIpAddress(a)).toBe(false);
  });
});

// ── The fetch, against a real local HTTP server ──────────────────

let http: Server | null = null;
let connections = 0;
let seen: Array<{ url: string; authorization: string | null }> = [];

async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
  connections = 0;
  seen = [];
  http = createServer((req, res) => {
    seen.push({ url: req.url ?? "", authorization: req.headers.authorization ?? null });
    handler!(req, res);
  });
  http.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
  return (http.address() as AddressInfo).port;
}

afterEach(async () => {
  if (http) {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http!.close(() => resolve()));
    http = null;
  }
});

const lookupTo = (...addresses: string[]): LookupFunction =>
  ((_host: string, _options: unknown, callback: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void) => {
    callback(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
  }) as unknown as LookupFunction;

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("createUserMcpFetch", () => {
  it("adds the token for the endpoint's own origin", async () => {
    const port = await serve((_req, res) => res.end("ok"));
    const handle = createUserMcpFetch({ endpoint: `http://127.0.0.1:${port}/mcp`, networkScope: "local", token: "tok" });
    try {
      const response = await handle.fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
      expect(await response.text()).toBe("ok");
      expect(seen).toEqual([{ url: "/mcp", authorization: "Bearer tok" }]);
    } finally {
      await handle.close();
    }
  });

  it("refuses another origin before the token is added, and nothing is sent", async () => {
    const port = await serve((_req, res) => res.end("ok"));
    const handle = createUserMcpFetch({ endpoint: `http://127.0.0.1:${port + 1}/mcp`, networkScope: "local", token: "tok" });
    try {
      const error = await failure(handle.fetch(`http://127.0.0.1:${port}/mcp`));
      expect(error).toMatchObject({ name: "UserMcpEndpointError", code: "cross_origin" });
      expect(connections).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("never follows a redirect", async () => {
    const port = await serve((req, res) => {
      if (req.url === "/mcp") {
        res.writeHead(302, { location: `http://127.0.0.1:${(http!.address() as AddressInfo).port}/elsewhere` });
        res.end();
        return;
      }
      res.end("redirected");
    });
    const handle = createUserMcpFetch({ endpoint: `http://127.0.0.1:${port}/mcp`, networkScope: "local", token: "tok" });
    try {
      await failure(handle.fetch(`http://127.0.0.1:${port}/mcp`));
      expect(seen.map((s) => s.url)).toEqual(["/mcp"]);
    } finally {
      await handle.close();
    }
  });

  it(`caps a response body at ${MAX_RESPONSE_BYTES} bytes`, async () => {
    const port = await serve((_req, res) => res.end("y".repeat(MAX_RESPONSE_BYTES + 10)));
    const handle = createUserMcpFetch({ endpoint: `http://127.0.0.1:${port}/mcp`, networkScope: "local", token: null });
    try {
      const response = await handle.fetch(`http://127.0.0.1:${port}/mcp`);
      expect(await failure(response.text())).toMatchObject({ code: "response_too_large" });
    } finally {
      await handle.close();
    }
  });

  it("public scope: a name resolving to loopback (DNS rebinding) is refused, no socket opened", async () => {
    const port = await serve((_req, res) => res.end("reached"));
    const handle = createUserMcpFetch(
      { endpoint: `http://mcp.rebind.test:${port}/mcp`, networkScope: "public", token: "tok" },
      { lookup: lookupTo("127.0.0.1") },
    );
    try {
      const error = await failure(handle.fetch(`http://mcp.rebind.test:${port}/mcp`));
      expect(JSON.stringify(String((error as Error).cause ?? error))).toMatch(/non_public_address|refused/);
      expect(connections).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("public scope: a mixed public and private answer is refused", async () => {
    const port = await serve((_req, res) => res.end("reached"));
    const handle = createUserMcpFetch(
      { endpoint: `http://mixed.test:${port}/mcp`, networkScope: "public", token: null },
      { lookup: lookupTo("93.184.216.34", "10.0.0.1") },
    );
    try {
      await failure(handle.fetch(`http://mixed.test:${port}/mcp`));
      expect(connections).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("local scope: a name resolving to a LAN or link-local address is refused", async () => {
    const port = await serve((_req, res) => res.end("reached"));
    for (const address of ["192.168.1.5", "169.254.169.254", "93.184.216.34"]) {
      const handle = createUserMcpFetch(
        { endpoint: `http://localhost:${port}/mcp`, networkScope: "local", token: null },
        { lookup: lookupTo(address) },
      );
      try {
        await failure(handle.fetch(`http://localhost:${port}/mcp`));
      } finally {
        await handle.close();
      }
    }
    expect(connections).toBe(0);
  });

  it("local scope: localhost reaches this computer", async () => {
    const port = await serve((_req, res) => res.end("here"));
    const handle = createUserMcpFetch({ endpoint: `http://localhost:${port}/mcp`, networkScope: "local", token: null });
    try {
      expect(await (await handle.fetch(`http://localhost:${port}/mcp`)).text()).toBe("here");
    } finally {
      await handle.close();
    }
  });
});
