/**
 * A peer FIN emitted before the dynamically loaded transport must be replayed.
 *
 * The subject is `readableEnded` as a PERSISTENT fact: the FIN can land inside
 * `serveOverSocket`'s dynamic import of the MCP SDK, before the transport's own
 * `end` listener exists, and Node does not replay that event to a late
 * listener. So the serve path reads the property instead of waiting for the
 * edge, and this proves it against a real kernel stream rather than a double.
 *
 * The endpoint is a LOOPBACK TCP pair, not a unix socket. Nothing here is about
 * unix-socket security or the host's bind gate - it is stream EOF semantics,
 * which are the same on every platform, so this suite runs everywhere including
 * Windows. `allowHalfOpen: true` matches the Studio listener's own contract:
 * a peer FIN must NOT tear down the writable side, or the last response of a
 * one-shot session is lost.
 */

import { once } from "node:events";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { serveOverSocket } from "../mcp-host/serve.js";
import { NodeSocketTransport } from "../mcp-host/node-socket-transport.js";

describe("serveOverSocket peer EOF replay", () => {
  it("closes when readable EOF happened before transport startup", async () => {
    let accept: (socket: Socket) => void = () => undefined;
    const accepted = new Promise<Socket>((resolve) => {
      accept = resolve;
    });
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      accept(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    server.unref();
    const address = server.address() as AddressInfo;

    const client = connect(address.port, "127.0.0.1");
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
        wire: new NodeSocketTransport(socket),
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
  },
  // AN EXPLICIT, GENEROUS TIMEOUT, measured rather than guessed. `serveOverSocket`
  // dynamically imports the MCP SDK, and on a cold transform cache that import
  // alone was measured at ~40 s here. At the 15 s default this case failed on
  // the UNCHANGED tree too, so the bound is the SDK import, not a race being
  // papered over: every assertion below still waits on a state transition and
  // none waits on elapsed time. Same reasoning, and same shape, as the timeout
  // on `host-status-transitions.test.ts`.
  60_000);
});
