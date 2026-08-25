/** A peer FIN emitted before the dynamically loaded transport must be replayed. */

import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { serveOverSocket } from "../mcp-host/serve.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("serveOverSocket peer EOF replay", () => {
  it("closes when readable EOF happened before transport startup", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "vex-studio-peer-end-"));
    roots.push(root);
    chmodSync(root, 0o700);
    const endpoint = path.join(root, "s.sock");

    let accept: (socket: Socket) => void = () => undefined;
    const accepted = new Promise<Socket>((resolve) => {
      accept = resolve;
    });
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      accept(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, resolve);
    });
    server.unref();

    const client = connect(endpoint);
    await once(client, "connect");
    client.unref();
    const socket = await accepted;
    socket.unref();

    const readableEnded = once(socket, "end");
    client.end();
    await readableEnded;
    expect(socket.readableEnded).toBe(true);
    expect(socket.destroyed).toBe(false);

    const closed = once(socket, "close");
    const handle = serveOverSocket(
      {
        socket,
        remainder: Buffer.alloc(0),
        projectId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        runCall: async () => ({
          kind: "completed",
          result: { success: true, output: "ok" },
        }),
        cancelCause: () => "disconnect",
        writeLine: async () => undefined,
        onWireFailure: vi.fn(),
        onServeFailure: vi.fn(),
      },
      { epoch: 1, currentEpoch: () => 1, version: "test" },
    );

    await closed;
    expect(socket.destroyed).toBe(true);
    await handle.close();
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
