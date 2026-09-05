/**
 * The `net.Socket` implementation of the Studio byte wire.
 *
 * It lives in MAIN because main owns the listener and therefore the socket:
 * the engine declares `StudioDuplexTransport` and never imports `node:net` for
 * it, main supplies the implementation. That direction is what lets the Windows
 * pipe-front become a SECOND implementation later without the framing, the
 * inbound bound or the close accounting changing at all.
 *
 * It is a PASSTHROUGH and nothing else. Every Node stream semantic the contract
 * promises - `once` detaching after one delivery, `off` by listener identity,
 * a paused stream pushing back on the kernel rather than buffering, half-open
 * `end` - is the socket's own, unmodified. There is no state here to get wrong,
 * which is the point: the only judgement in this file is `setNoDelay`.
 */

import type { Socket } from "node:net";

import type {
  StudioDuplexTransport,
  StudioDuplexTransportEvent,
  StudioDuplexTransportEvents,
} from "@vex-agent/mcp/duplex-transport.js";

export class NodeSocketTransport implements StudioDuplexTransport {
  private readonly socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    // NAGLE OFF, at construction. An MCP frame is one small line and the answer
    // to it is another; waiting ~40 ms for a segment to fill would add that
    // latency to every single call. This used to sit in `StudioConnection`,
    // which is host lifecycle state and had no business knowing the wire was a
    // TCP-family socket at all - it is socket mechanics, so it belongs here,
    // and a wire that has no such setting simply has no such line.
    socket.setNoDelay(true);
  }

  on<E extends StudioDuplexTransportEvent>(
    event: E,
    listener: StudioDuplexTransportEvents[E],
  ): void {
    this.socket.on(event, listener);
  }

  once<E extends StudioDuplexTransportEvent>(
    event: E,
    listener: StudioDuplexTransportEvents[E],
  ): void {
    this.socket.once(event, listener);
  }

  off<E extends StudioDuplexTransportEvent>(
    event: E,
    listener: StudioDuplexTransportEvents[E],
  ): void {
    this.socket.off(event, listener);
  }

  write(line: string, callback?: () => void): boolean {
    return this.socket.write(line, callback);
  }

  end(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }

  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  get destroyed(): boolean {
    return this.socket.destroyed;
  }

  get writableEnded(): boolean {
    return this.socket.writableEnded;
  }

  get readableEnded(): boolean {
    return this.socket.readableEnded;
  }
}
