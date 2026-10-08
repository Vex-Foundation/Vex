import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocket as UndiciWebSocket } from "undici";
import { describe, expect, it } from "vitest";

import { defaultLighterCandleStreamSupervisorDeps } from "../candle-stream.js";
import { defaultLighterOrderStreamSupervisorDeps } from "../order-stream.js";
import {
  defaultLighterPublicMarketSupervisorDeps,
  type LighterPublicMarketSocket,
} from "../public-market-stream.js";

const factories = [
  {
    name: "account orders",
    createSocket: defaultLighterOrderStreamSupervisorDeps(async () => null).createSocket,
  },
  {
    name: "public market",
    createSocket: defaultLighterPublicMarketSupervisorDeps().createSocket,
  },
  {
    name: "candles",
    createSocket: defaultLighterCandleStreamSupervisorDeps().createSocket,
  },
];

describe.each(factories)("Lighter $name default socket handshake", ({ createSocket }) => {
  it("exchanges real text frames and closes cleanly through the patched transport", async () => {
    const server = await startHandshakeServer(false);
    try {
      const socket = createSocket(server.url);
      expect(socket).toBeInstanceOf(UndiciWebSocket);
      const result = await observeSocket(socket);
      expect(result.opened).toBe(true);
      expect(result.messages).toEqual(['{"type":"connected"}']);
      expect(server.received).toEqual(["client-evidence"]);
      expect(result.errors).toBe(0);
      expect(result.closeCode).toBe(1000);
    } finally {
      await server.stop();
    }
  });

  it("rejects an unsolicited subprotocol without opening or escaping its error handler", async () => {
    const server = await startHandshakeServer(true);
    try {
      const socket = createSocket(server.url);
      expect(socket).toBeInstanceOf(UndiciWebSocket);
      const result = await observeSocket(socket);
      expect(result.opened).toBe(false);
      expect(result.messages).toEqual([]);
      expect(server.received).toEqual([]);
      expect(result.errors).toBe(1);
      expect(result.closeCode).toBe(1006);
      expect(socket.readyState).toBe(UndiciWebSocket.CLOSED);
    } finally {
      await server.stop();
    }
  });
});

async function startHandshakeServer(unsolicitedProtocol: boolean) {
  const sockets = new Set<Socket>();
  const received: string[] = [];
  const server = createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      ...(unsolicitedProtocol ? ["Sec-WebSocket-Protocol: unsolicited"] : []),
      "",
      "",
    ].join("\r\n"));
    if (unsolicitedProtocol) return;
    const connected = Buffer.from('{"type":"connected"}');
    socket.write(Buffer.concat([Buffer.from([0x81, connected.length]), connected]));
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 6) return;
      const opcode = (pending[0] ?? 0) & 0x0f;
      const size = (pending[1] ?? 0) & 0x7f;
      const masked = ((pending[1] ?? 0) & 0x80) !== 0;
      if (opcode !== 1 || !masked || size > 125 || pending.length < 6 + size) return;
      const mask = pending.subarray(2, 6);
      const payload = Buffer.from(pending.subarray(6, 6 + size));
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      }
      received.push(payload.toString("utf8"));
      pending = Buffer.alloc(0);
      socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing loopback address.");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    received,
    stop: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}

async function observeSocket(socket: LighterPublicMarketSocket) {
  const result: { opened: boolean; messages: unknown[]; errors: number; closeCode: number } = {
    opened: false,
    messages: [],
    errors: 0,
    closeCode: 0,
  };
  return await new Promise<typeof result>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Socket handshake did not settle."));
    }, 5_000);
    socket.addEventListener("open", () => { result.opened = true; });
    socket.addEventListener("message", (event) => {
      if (event !== null && typeof event === "object" && "data" in event) {
        result.messages.push(event.data);
      }
      socket.send("client-evidence");
    });
    socket.addEventListener("error", () => { result.errors += 1; });
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      if (event !== null && typeof event === "object" && "code" in event && typeof event.code === "number") {
        result.closeCode = event.code;
      }
      resolve(result);
    });
  });
}
