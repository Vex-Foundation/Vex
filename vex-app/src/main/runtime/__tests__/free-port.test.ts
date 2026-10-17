import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { chooseFreePort } from "../native/free-port.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function listen(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    servers.push(server);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

async function releasedPort(): Promise<number> {
  const port = await listen(0);
  await new Promise((r) => servers.pop()?.close(r));
  return port;
}

describe("chooseFreePort (D5)", () => {
  it("returns the last-used port when it is free", async () => {
    const port = await releasedPort();
    expect(await chooseFreePort([port])).toBe(port);
  });

  it("falls back to an OS-assigned port when the last-used one is taken", async () => {
    const taken = await listen(0);
    const chosen = await chooseFreePort([taken]);
    expect(chosen).not.toBe(taken);
    expect(chosen).toBeGreaterThan(0);
    // And the candidate is released: we can bind it ourselves.
    expect(await listen(chosen)).toBe(chosen);
  });

  it("skips null preferences and assigns one", async () => {
    expect(await chooseFreePort([null])).toBeGreaterThan(0);
    expect(await chooseFreePort([])).toBeGreaterThan(0);
  });
});
