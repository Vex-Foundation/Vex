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
 */

import { EV, CH } from "../../shared/ipc/channels.js";
import {
  filesEventSchema,
  filesListChildrenInputSchema,
  filesReadFileInputSchema,
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
    listeners.get(event.subscriptionId)?.callback(event);
  });
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
