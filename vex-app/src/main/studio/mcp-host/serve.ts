/**
 * Build the MCP server over ONE accepted wire.
 *
 * Split from the host because it is not host state: it owns the dynamic import
 * of the engine's transport and server modules, the close-before-ready latch,
 * and the failure path when the serve chain cannot be built at all. The host
 * owns the listener, the epoch and the bounds, and hands this function the
 * epoch to compare against.
 *
 * The engine modules are imported DYNAMICALLY so the main bundle's static graph
 * does not gain the MCP SDK at module load, exactly as the other engine
 * touch-points in main do. The handle returned before the import resolves is a
 * real one: a close that arrives first is remembered and applied.
 */

import { log } from "../../logger/index.js";
import { studioWireErrorCode } from "@vex-agent/mcp/wire-errors.js";

import type { ServeConnectionInput } from "./connection.js";

export interface ServeOverSocketDeps {
  /** The epoch this connection was accepted under. */
  readonly epoch: number;
  /** The host's CURRENT epoch, re-read after every await in this chain. */
  readonly currentEpoch: () => number;
  /** The app version an MCP client sees in `serverInfo`. */
  readonly version: string;
}

export function serveOverSocket(
  input: ServeConnectionInput,
  deps: ServeOverSocketDeps,
): { close: () => Promise<void> } {
  let closed = false;
  let inner: { close: () => Promise<void> } | null = null;

  const ready = (async () => {
    const [{ StudioSocketTransport }, { serveStudioMcpConnection }] = await Promise.all([
      import("@vex-agent/mcp/socket-transport.js"),
      import("@vex-agent/mcp/server.js"),
    ]);
    const transport = new StudioSocketTransport(input.wire, {
      remainder: input.remainder,
      writeLine: input.writeLine,
      onFailure: (failure) => {
        input.onWireFailure(failure.kind);
      },
    });
    // The dynamic import is the widest await in the whole establish chain.
    // A lock inside it must not be overtaken into a serving connection.
    if (closed || deps.epoch !== deps.currentEpoch()) {
      await transport.close();
      return;
    }
    inner = serveStudioMcpConnection(
      transport,
      {
        projectId: input.projectId,
        runCall: input.runCall,
        cancelCause: input.cancelCause,
        version: deps.version,
      },
      (error: Error) => {
        // THE CODE, never the message. An SDK error on this wire can quote the
        // payload it rejected, and this callback's argument goes straight to a
        // log line.
        input.onWireFailure(studioWireErrorCode(error));
      },
    );
    // `allowHalfOpen` keeps the writable side available for final responses,
    // but it also means a peer FIN does not produce `close`. The FIN can land
    // during the dynamic imports above, before the transport owns `end`; Node
    // does not replay that event to a late listener. `readableEnded` is the
    // persistent fact, so replay it after `serveStudioMcpConnection`
    // synchronously starts the transport. The method is idempotent when the
    // live listener also saw it.
    if (input.wire.readableEnded) transport.notifyPeerEnd();
    if (closed || deps.epoch !== deps.currentEpoch()) await inner.close();
  })().catch((cause: unknown) => {
    // THE SERVE PATH FAILED TO EXIST. Before this, a failed SDK import or a
    // server construction that threw left a paused, registered socket that
    // nothing would ever close: the transport was never handed to the entry,
    // so no `onclose` could fire. The failure goes to the OWNER, which closes
    // the connection, releases its slot and clears the registry.
    log.error("[studio:mcp] could not serve connection", cause);
    input.onServeFailure(cause instanceof Error ? cause.message : String(cause));
  });

  return {
    close: async (): Promise<void> => {
      closed = true;
      await ready;
      if (inner !== null) await inner.close();
    },
  };
}
