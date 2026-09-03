/**
 * `vex.files.*` - the preload gate for Vex Studio project files (stage B3a).
 *
 * EVERY INPUT IS VALIDATED HERE, before it reaches an invoke, with the same
 * strict schemas main parses it with. That is not redundant with main's own
 * validation: a renderer bug is caught in the process that made it, with a
 * `validation.invalid_input` the component can act on, rather than as a
 * contract violation logged in the privileged process. The check itself lives
 * in `invokeWithSchema`, which parses the input with the schema handed to it
 * and answers `validation.invalid_input` BEFORE any invoke - so there is one
 * validation here, not a local pre-check duplicating it.
 *
 * ## Event routing
 *
 * ONE `ipcRenderer` listener for the whole namespace, not one per subscription.
 * Main sends every file event on a single channel with the subscription id
 * inside the (validated) payload, and this module dispatches to the callback
 * registered for that id. A listener per subscription would put N listeners on
 * one channel, and every one of them would be woken for every other
 * subscription's events.
 *
 * At most ONE callback per subscription id: re-registering REPLACES, and each
 * cleanup is tagged with the generation that created it, so a late cleanup from
 * a replaced subscription cannot remove the live one. That is the React
 * strict-mode double-effect bug the terminal bridge documents, and it bites
 * here for exactly the same reason.
 *
 * An event whose payload fails its schema is DROPPED before any callback runs.
 * Main is a different process; an off-contract payload never becomes renderer
 * state.
 *
 * ## Flow control lives HERE, not in the renderer
 *
 * `EV.files.changed` is a push, and `webContents.send` neither blocks nor
 * reports whether the renderer ever ran - so a stalled consumer would leave
 * main holding an unbounded IPC backlog. This module posts one `CH.files.ackEvent`
 * per `changed` batch, AFTER the renderer callback has returned, and main
 * stops sending batches to a subscription that owes more than
 * `FILES_EVENTS_OUTSTANDING_MAX` of them. Doing it here rather than in the
 * renderer is the same choice the terminal bridge made: a component that
 * forgets to acknowledge cannot wedge its own subscription, because
 * acknowledging is not something it was ever asked to do.
 */

import { EV, CH } from "../../shared/ipc/channels.js";
import {
  filesAckEventInputSchema,
  filesCreateInputSchema,
  filesDeleteInputSchema,
  filesEventSchema,
  filesListChildrenInputSchema,
  filesReadFileInputSchema,
  filesRenameInputSchema,
  filesUnwatchInputSchema,
  filesWatchInputSchema,
  type FilesEvent,
} from "../../shared/schemas/files.js";
import type { FilesBridge } from "../../shared/types/bridge/shell/files.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

interface Listener {
  readonly generation: number;
  readonly callback: (event: FilesEvent) => void;
}

const listeners = new Map<string, Listener>();
let generations = 0;
let detach: (() => void) | null = null;

/**
 * Attach the single channel listener, lazily.
 *
 * Lazily so a window that never opens a file tree registers nothing at all, and
 * detached again when the last subscription goes, so the channel is not held by
 * a namespace nobody is using.
 */
function ensureAttached(): void {
  if (detach !== null) return;
  detach = subscribe(EV.files.changed, filesEventSchema, (event) => {
    const listener = listeners.get(event.subscriptionId);
    if (listener === undefined) return;
    listener.callback(event);
    // ACK FROM CONSUMPTION, not from arrival. The ack is posted AFTER the
    // renderer's callback has returned, so what it acknowledges is that the
    // batch was consumed - the same thing the terminal bridge acknowledges from
    // xterm's write completion. An ack sent on arrival would prove only that a
    // message reached a process that may be doing nothing with it, which is
    // precisely the stall main's bound exists to notice.
    //
    // Only `changed` is acknowledged, because only `changed` is counted: main
    // never withholds a `status` or a `resync`.
    if (event.kind === "changed") acknowledge(event.subscriptionId);
  });
}

/**
 * Tell main one batch was consumed. Fire and forget, deliberately.
 *
 * The result gives this side nothing to act upon - a refusal means the subscription
 * is gone, and a subscription that is gone will send no further batches to fall
 * behind on. The promise is swallowed rather than left unhandled so a main
 * process that is shutting down cannot turn a rejected invoke into an
 * unhandled rejection in the preload realm.
 */
function acknowledge(subscriptionId: string): void {
  void invokeWithSchema(
    CH.files.ackEvent,
    { subscriptionId },
    filesAckEventInputSchema,
  ).catch(() => undefined);
}

function releaseIfIdle(): void {
  if (listeners.size > 0 || detach === null) return;
  detach();
  detach = null;
}

export const files = {
  listChildren(input) {
    return invokeWithSchema(
      CH.files.listChildren,
      input,
      filesListChildrenInputSchema,
    );
  },

  readFile(input) {
    return invokeWithSchema(CH.files.readFile, input, filesReadFileInputSchema);
  },

  watchFile(input) {
    return invokeWithSchema(CH.files.watchFile, input, filesWatchInputSchema);
  },

  unwatchFile(input) {
    return invokeWithSchema(CH.files.unwatchFile, input, filesUnwatchInputSchema);
  },

  // THE WRITES. Validated here with the same schemas main parses them with, so
  // a name the shared rule refuses never reaches the privileged process at all
  // and the component gets a `validation.invalid_input` it can act on. That is
  // a developer backstop and not the boundary: main enforces the same rule
  // again, because a preload that could be bypassed is not a gate.
  createNode(input) {
    return invokeWithSchema(CH.files.create, input, filesCreateInputSchema);
  },

  renameNode(input) {
    return invokeWithSchema(CH.files.rename, input, filesRenameInputSchema);
  },

  deleteNode(input) {
    return invokeWithSchema(CH.files.delete, input, filesDeleteInputSchema);
  },

  onFilesEvent(subscriptionId, cb) {
    ensureAttached();
    generations += 1;
    const generation = generations;
    listeners.set(subscriptionId, { generation, callback: cb });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Only remove the listener if it is still OURS. A cleanup that ran after
      // a re-subscription replaced this callback must not remove the
      // replacement.
      if (listeners.get(subscriptionId)?.generation === generation) {
        listeners.delete(subscriptionId);
      }
      releaseIfIdle();
    };
  },
} satisfies FilesBridge;
