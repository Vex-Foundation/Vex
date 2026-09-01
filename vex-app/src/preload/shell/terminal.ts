/**
 * `vex.terminal.*` - THE PORT OWNER (stage B2).
 *
 * This file holds the only reference in the renderer process to the
 * `MessagePort` that carries terminal output. The renderer gets callbacks; it
 * never gets the port, a channel name, or anything it could use to talk to the
 * pty host directly. That is the same rule the rest of `window.vex` follows -
 * it simply matters more here, because the thing being hidden is a live conduit
 * into a process that spawns shells.
 *
 * ## Three jobs, and they are all here for a reason
 *
 *  1. ACQUISITION. One port per window, obtained lazily and joined by every
 *     caller that arrives while it is in flight (`portPromise`), so eight
 *     terminals mounting in one tick produce ONE port rather than eight.
 *  2. FLOW-CONTROL ACKS. Preload counts the characters it delivered and sends
 *     one ack per `TERMINAL_ACK_CHARS`. Doing it here rather than in the
 *     renderer means a component that forgets to acknowledge cannot wedge a
 *     pty, and the accounting is identical for every consumer.
 *  3. SUBSCRIPTION IDENTITY. At most one callback per (terminalId, event type).
 *     Re-subscribing REPLACES, and each cleanup is tagged with the generation
 *     that created it, so a late cleanup from a replaced subscription cannot
 *     remove the live one - the classic React strict-mode double-effect bug.
 *
 * ## Validation
 *
 * Every packet arriving from the port is parsed with the shared strict schema
 * before it reaches a renderer callback. This is the LAST gate: the host is a
 * different process, and an off-contract payload dropped here never becomes
 * renderer state.
 */

import { ipcRenderer } from "electron";
import { CH, EV } from "../../shared/ipc/channels.js";
import { ok, type Result, type VexError } from "../../shared/ipc/result.js";
import {
  TERMINAL_ACK_CHARS,
  TERMINAL_PORT_NONCE_TTL_MS,
  TERMINAL_WRITE_MAX_BYTES,
  chunkByUtf8Bytes,
  terminalCreateInputSchema,
  terminalHostAvailabilitySchema,
  terminalIdInputSchema,
  terminalPersistWorkspaceInputSchema,
  terminalPortEventSchema,
  terminalProjectInputSchema,
  terminalResizeInputSchema,
  terminalWriteInputSchema,
  terminalWriteRequestSchema,
  terminalsLostSchema,
  type TerminalAckResult,
  type TerminalPortEvent,
} from "../../shared/schemas/terminal.js";
import type { TerminalBridge } from "../../shared/types/bridge/shell/terminal.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

type EventKind = "data" | "resync" | "property" | "exit" | "refused";

interface Subscription {
  readonly generation: number;
  /**
   * The subscriber, stored with its arguments erased.
   *
   * `never[]` rather than `unknown[]` so the store is contravariantly safe: a
   * callback of ANY argument list is assignable in, and nothing can call it
   * without narrowing first. The two `deliver` helpers are the only callers and
   * each restores the argument list its event kind actually carries.
   */
  readonly callback: (...args: never[]) => void;
}

const subscriptions = new Map<string, Subscription>();
let generationCounter = 0;

/** Unacknowledged characters delivered to the renderer, per terminal. */
const unacked = new Map<string, number>();

/**
 * Terminals whose replay sequence has begun and not yet been closed by a
 * `last` chunk. This is what makes the consumer's clear fire once per replay
 * rather than once per chunk.
 */
const replayInFlight = new Set<string>();

let port: MessagePort | null = null;
let portPromise: Promise<MessagePort | null> | null = null;

function key(terminalId: string, kind: EventKind): string {
  return `${terminalId}\0${kind}`;
}

function deliver(terminalId: string, kind: EventKind, payload: unknown): void {
  const entry = subscriptions.get(key(terminalId, kind));
  (entry?.callback as ((value: unknown) => void) | undefined)?.(payload);
}

/**
 * Deliver output to the data subscriber, with the completion callback it must
 * call once it has genuinely consumed the bytes.
 *
 * WITH NO SUBSCRIBER, THE ACK IS NOT OWED. Returning without settling is
 * deliberate: nothing consumed these characters, so crediting them would tell
 * the host a consumer kept up when there was none. The host's own detach
 * accounting is what covers that case.
 */
function deliverData(terminalId: string, data: string, done: () => void): void {
  const entry = subscriptions.get(key(terminalId, "data"));
  const callback = entry?.callback as
    | ((value: string, settle: () => void) => void)
    | undefined;
  callback?.(data, done);
}

/**
 * Register a subscription, replacing any previous one for the same pair.
 *
 * The returned cleanup removes the entry ONLY if it is still the one this call
 * created. Without that check, a component that re-subscribes and then runs its
 * previous effect's cleanup would delete the subscription it had just replaced,
 * and the terminal would silently stop updating.
 */
function register(
  terminalId: string,
  kind: EventKind,
  callback: (...args: never[]) => void,
): () => void {
  generationCounter += 1;
  const generation = generationCounter;
  const mapKey = key(terminalId, kind);
  subscriptions.set(mapKey, { generation, callback });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (subscriptions.get(mapKey)?.generation === generation) {
      subscriptions.delete(mapKey);
    }
  };
}

/* ------------------------------------------------------------------ *
 * Port acquisition
 * ------------------------------------------------------------------ */

/**
 * The transfer listener is installed at module load, BEFORE any acquisition
 * can be requested. Installing it inside the acquisition would race the
 * `postMessage` main sends from inside the very handler being awaited.
 */
/**
 * The acquisition in flight, if any, and the nonce it is waiting for.
 *
 * `nonce` is `null` between registering the waiter and learning the nonce from
 * the invoke reply. A port that arrives in that gap is PARKED in `unclaimed`
 * rather than closed - it belongs to this acquisition, we simply cannot prove
 * it yet - and is matched as soon as the reply names it.
 */
let pendingArrival: { deliver: (value: MessagePort) => void; nonce: string | null }
  | null = null;

/**
 * Ports that arrived before their nonce was known. At most one, briefly.
 *
 * Cleared when matched, and dropped when the acquisition ends - so a genuinely
 * stray port (a nonce from an acquisition that already timed out) is still
 * closed rather than retained. An unclaimed live conduit into the pty host with
 * no owner is exactly what the original close was protecting against, and that
 * protection is preserved; what changed is that "no one has asked for this
 * nonce YET" is no longer mistaken for "no one ever will".
 */
const unclaimed = new Map<string, MessagePort>();

/** Why the port was last dropped. Read by the boundary tests and the log. */
let lastPortDropReason: string | null = null;

ipcRenderer.on(EV.terminal.port, (event, payload: unknown) => {
  const nonce = (payload as { nonce?: unknown } | null)?.nonce;
  const arrived = event.ports[0];
  if (typeof nonce !== "string" || arrived === undefined) return;

  const pending = pendingArrival;
  if (pending === null) {
    // No acquisition at all. Closing is the correct response.
    arrived.close();
    return;
  }
  if (pending.nonce === null) {
    // The reply has not named the nonce yet. Park it; `acquirePort` matches it
    // the moment it can.
    unclaimed.set(nonce, arrived);
    return;
  }
  if (pending.nonce !== nonce) {
    // A nonce from an acquisition that is no longer the live one.
    arrived.close();
    return;
  }
  pending.deliver(arrived);
});

function attachPortHandlers(target: MessagePort): void {
  target.onmessage = (message: MessageEvent) => {
    const parsed = terminalPortEventSchema.safeParse(message.data);
    if (!parsed.success) return;
    handlePortEvent(parsed.data);
  };
  // THE RECOVERY TRIGGER. The other end is the pty host; when that process
  // goes, the port is entangled-closed and every post into it becomes a silent
  // no-op. Listening for the close is what turns "the terminals stopped
  // working forever" into "the next use acquires a fresh port".
  target.addEventListener("close", () => {
    dropPort("host_port_closed");
  });
  target.start();
}

/**
 * Post to the port, recovering if it turns out to be dead.
 *
 * Every write to the data plane goes through here rather than touching `port`
 * directly, so there is ONE place that notices a port has died and ONE
 * recovery. Returns whether the packet was handed over.
 */
function postToPort(packet: unknown): boolean {
  const active = port;
  if (active === null) return false;
  try {
    active.postMessage(packet);
    return true;
  } catch {
    dropPort("post_failed");
    return false;
  }
}

function handlePortEvent(event: TerminalPortEvent): void {
  switch (event.kind) {
    case "data": {
      // THE ACK IS OWED BY THE CONSUMER, and it is owed exactly once.
      //
      // The characters are counted only when the consumer reports that it has
      // actually written them - which for xterm means its parser has finished
      // with them, not that they were queued. `settled` makes a consumer that
      // calls `done` twice harmless; a consumer that never calls it stops
      // acking, which is precisely how the pty learns to pause.
      const chars = event.data.length;
      const terminalId = event.terminalId;
      let settled = false;
      deliverData(terminalId, event.data, () => {
        if (settled) return;
        settled = true;
        countForAck(terminalId, chars);
      });
      return;
    }
    case "replay":
      // A replay chunk is data too, but the consumer must be told to clear
      // first - and EXACTLY ONCE, on the FIRST chunk of the sequence.
      //
      // A mirror larger than TERMINAL_REPLAY_CHUNK_MAX_BYTES arrives as several
      // packets. Signalling a resync on each of them would make the consumer
      // clear its screen between chunks, so only the final chunk would survive,
      // and it would report `droppedRows` once per chunk instead of once per
      // replay. `last` closes the sequence; the host always terminates a replay
      // with it, including the empty-mirror case.
      if (!replayInFlight.has(event.terminalId)) {
        replayInFlight.add(event.terminalId);
        deliver(event.terminalId, "resync", {
          reason: "replay",
          droppedRows: event.droppedRows,
        });
      }
      if (event.last) replayInFlight.delete(event.terminalId);
      // A REPLAY CHUNK IS NEVER ACKNOWLEDGED. The host clears every outstanding
      // count when the replay completes - the consumer's screen then EQUALS the
      // mirror by construction - so an ack for a replay chunk arriving after
      // that clear is charged against live debt the consumer never incurred,
      // and the pty is credited for characters nobody consumed. The consumer
      // still gets a `done` it may call; it is a no-op here on purpose, so one
      // consumer implementation works for both packet kinds.
      deliverData(event.terminalId, event.data, () => undefined);
      return;
    case "property":
      deliver(event.terminalId, "property", event.change);
      return;
    case "exit":
      deliver(event.terminalId, "exit", {
        exitCode: event.exitCode,
        signal: event.signal,
      });
      unacked.delete(event.terminalId);
      replayInFlight.delete(event.terminalId);
      return;
    case "resyncRequired":
      deliver(event.terminalId, "resync", {
        reason: event.reason,
        droppedRows: 0,
      });
      // AND ASK FOR THE REPLAY. The host detached this consumer to protect
      // itself and is waiting to be asked; nothing else in the system sends
      // this request, so before this line the emergency-ceiling path ended in a
      // terminal that had cleared its screen and would never be sent another
      // byte. Preload owns it rather than the renderer because preload owns the
      // port and the ack accounting the replay resets.
      unacked.set(event.terminalId, 0);
      replayInFlight.delete(event.terminalId);
      postToPort({ kind: "resync", terminalId: event.terminalId });
      return;
    case "refused":
      if (event.terminalId !== null) {
        deliver(event.terminalId, "refused", event.code);
      }
      return;
  }
}

/**
 * Acknowledge in `TERMINAL_ACK_CHARS` units.
 *
 * The unit must be `<= TERMINAL_FLOW_LOW_WATERMARK_CHARS` or a paused pty can
 * never resume; the shared contract states that invariant and a table test
 * pins it.
 */
function countForAck(terminalId: string, chars: number): void {
  const total = (unacked.get(terminalId) ?? 0) + chars;
  if (total < TERMINAL_ACK_CHARS) {
    unacked.set(terminalId, total);
    return;
  }
  unacked.set(terminalId, 0);
  if (!postToPort({ kind: "ack", terminalId, charCount: total })) {
    // The port died with the ack owed. Put the count back so a re-acquired port
    // does not start life having silently forgiven the host's outstanding debt.
    unacked.set(terminalId, total);
  }
}

async function ensurePort(): Promise<MessagePort | null> {
  if (port !== null) return port;
  portPromise ??= acquirePort().finally(() => {
    portPromise = null;
  });
  return await portPromise;
}

/**
 * Acquire the window's one data-plane port.
 *
 * ## The arrival handler is registered BEFORE the invoke, and that is the fix
 *
 * Main transfers the port from INSIDE the `acquirePort` handler, so the
 * `EV.terminal.port` event can be delivered to this process before the invoke's
 * reply is. Registering the arrival waiter only after awaiting the reply meant
 * an early port found no one waiting for its nonce and was CLOSED as a stray -
 * and the acquisition then sat until its own timeout and returned null. It did
 * not reproduce only because the boundary test's helper delayed `postPort`
 * past the reply; the production path had no such delay and the race was
 * decided by scheduling.
 *
 * The nonce cannot be known before the invoke, so the waiter is registered
 * against a PENDING acquisition instead: `pendingArrival` is what the transfer
 * listener consults when it sees a nonce nobody has claimed yet. A port that
 * arrives in the same microtask as the reply is therefore held, not closed.
 */
async function acquirePort(): Promise<MessagePort | null> {
  let deliver: (value: MessagePort) => void = () => undefined;
  const arrival = new Promise<MessagePort | null>((resolve) => {
    deliver = resolve;
    const timer = setTimeout(() => {
      resolve(null);
    }, TERMINAL_PORT_NONCE_TTL_MS);
    // The preload process outlives every acquisition; the timer must not keep
    // the event loop alive on its own if this ever runs in a bare Node harness.
    (timer as { unref?: () => void }).unref?.();
  });
  // REGISTERED FIRST. A port that arrives before the reply is now expected.
  pendingArrival = { deliver, nonce: null };

  try {
    const ticket = await invokeWithSchema<{ ok: boolean; value?: { nonce: string } }>(
      CH.terminal.acquirePort,
      {},
    );
    if (!ticket.ok || ticket.data.ok !== true || ticket.data.value === undefined) {
      return null;
    }
    const nonce = ticket.data.value.nonce;
    if (pendingArrival !== null) pendingArrival.nonce = nonce;
    // A port that arrived while the nonce was still unknown was parked; this is
    // where it is matched against the nonce that finally names it.
    const parked = unclaimed.get(nonce);
    if (parked !== undefined) {
      unclaimed.delete(nonce);
      deliver(parked);
    }

    const arrived = await arrival;
    if (arrived === null) return null;

    // CONFIRM BEFORE USE. An unconfirmed nonce expires in main, which tears the
    // port down underneath us; a confirmation that failed used to be ignored,
    // so the bridge would go on posting into a conduit main was about to close
    // and every terminal on it would silently stop.
    const confirmed = await invokeWithSchema<{ ok: boolean }>(CH.terminal.confirmPort, {
      nonce,
    });
    if (!confirmed.ok || confirmed.data.ok !== true) {
      arrived.close();
      return null;
    }

    attachPortHandlers(arrived);
    port = arrived;
    return arrived;
  } finally {
    pendingArrival = null;
    // Anything still parked belongs to no live acquisition. It is now genuinely
    // stray, and a stray port is a live conduit into the pty host with no owner.
    for (const parked of unclaimed.values()) parked.close();
    unclaimed.clear();
  }
}

/**
 * Give up the current port and let the next call acquire a fresh one.
 *
 * A `MessagePort` dies when the process on the other end does, and it dies
 * SILENTLY: posting into a closed port throws nothing and delivers nothing. So
 * a pty host that crashed left this module holding a dead conduit forever, and
 * every subsequent attach, ack and detach went nowhere with no error anywhere.
 *
 * Dropping the reference is the whole recovery. `ensurePort` acquires again on
 * the next use, and main mints a port against a host it has restarted; the
 * subscriptions are left in place because their terminals may be revived.
 */
function dropPort(reason: string): void {
  if (port === null) return;
  try {
    port.close();
  } catch {
    // Already gone. Dropping the reference is what matters.
  }
  port = null;
  unacked.clear();
  replayInFlight.clear();
  lastPortDropReason = reason;
}

/* ------------------------------------------------------------------ *
 * Bridge
 * ------------------------------------------------------------------ */

function portUnavailable(): Result<TerminalAckResult, VexError> {
  return ok({ ok: false, code: "port_unavailable" });
}

/**
 * A refusal shaped like the outcome the caller expects.
 *
 * The port methods do not reach an invoke at all, so `invokeWithSchema`'s own
 * validation error is not available to them; they answer with the same typed
 * refusal every other local failure on this surface uses.
 */
function invalidInput(): Result<TerminalAckResult, VexError> {
  return ok({ ok: false, code: "invalid_packet" });
}

/**
 * `vex.terminal.*`, with EVERY INPUT VALIDATED AT THE GATE.
 *
 * Main revalidates all of this and main is the authority - but the preload
 * boundary's own contract is that a narrow domain method parses what it is
 * handed before it crosses the process line, and these methods did not. The
 * cost of the omission is not theoretical: an unparsed payload reaches the
 * privileged side as whatever the renderer chose to put in it, and the only
 * thing standing between that and a handler is the handler remembering. Here
 * the schemas are the shared ones main uses, so the two gates cannot drift.
 */
export const terminal = {
  create(input) {
    return invokeWithSchema(CH.terminal.create, input, terminalCreateInputSchema);
  },

  async write(input) {
    // PARSED BEFORE ANYTHING TOUCHES IT. Chunking first walked the bytes of a
    // value nothing had checked was a string, so a malformed call threw at the
    // preload boundary instead of being refused by name.
    if (!terminalWriteRequestSchema.safeParse(input).success) return invalidInput();
    let last: Result<TerminalAckResult, VexError> = ok({ ok: true, value: null });
    // CHUNKING, NOT TRUNCATION: a paste larger than one packet is sent whole,
    // in packets that fit the bound, and the caller's promise resolves only
    // after the last one.
    for (const chunk of chunkByUtf8Bytes(input.data, TERMINAL_WRITE_MAX_BYTES)) {
      last = await invokeWithSchema<TerminalAckResult, { terminalId: string; data: string }>(
        CH.terminal.write,
        { terminalId: input.terminalId, data: chunk },
        terminalWriteInputSchema,
      );
      // Stop at the first refusal rather than firing the rest into a terminal
      // that has already said no - a half-delivered paste is worse than a
      // refused one, and the caller sees the refusal that stopped it.
      if (!last.ok || last.data.ok === false) return last;
    }
    return last;
  },

  resize(input) {
    return invokeWithSchema(CH.terminal.resize, input, terminalResizeInputSchema);
  },

  kill(input) {
    return invokeWithSchema(CH.terminal.kill, input, terminalIdInputSchema);
  },

  async attach(input) {
    if (!terminalIdInputSchema.safeParse(input).success) return invalidInput();
    const active = await ensurePort();
    if (active === null) return portUnavailable();
    unacked.set(input.terminalId, 0);
    // A replay abandoned by a previous detach must not suppress the clear that
    // opens THIS attachment's replay.
    replayInFlight.delete(input.terminalId);
    if (!postToPort({ kind: "attach", terminalId: input.terminalId })) {
      return portUnavailable();
    }
    return ok({ ok: true, value: null });
  },

  async detach(input) {
    if (!terminalIdInputSchema.safeParse(input).success) return invalidInput();
    if (port === null) return portUnavailable();
    const sent = postToPort({ kind: "detach", terminalId: input.terminalId });
    unacked.delete(input.terminalId);
    replayInFlight.delete(input.terminalId);
    if (!sent) return portUnavailable();
    return ok({ ok: true, value: null });
  },

  onData(terminalId, cb) {
    return register(terminalId, "data", cb as (...args: never[]) => void);
  },

  onResync(terminalId, cb) {
    return register(terminalId, "resync", cb as (...args: never[]) => void);
  },

  onProperty(terminalId, cb) {
    return register(terminalId, "property", cb as (...args: never[]) => void);
  },

  onExit(terminalId, cb) {
    return register(terminalId, "exit", cb as (...args: never[]) => void);
  },

  onRefused(terminalId, cb) {
    return register(terminalId, "refused", cb as (...args: never[]) => void);
  },

  persistWorkspace(input) {
    return invokeWithSchema(
      CH.terminal.persistWorkspace,
      input,
      terminalPersistWorkspaceInputSchema,
    );
  },

  readWorkspace(input) {
    return invokeWithSchema(CH.terminal.readWorkspace, input, terminalProjectInputSchema);
  },

  getAvailability() {
    return invokeWithSchema(CH.terminal.availability, {});
  },

  onAvailability(cb) {
    return subscribe(EV.terminal.availability, terminalHostAvailabilitySchema, cb);
  },

  /**
   * The terminals that died with an unexpectedly terminated pty host.
   *
   * Nothing consumed this before, and the consequence was visible: after a host
   * crash the workspace went on drawing live tabs over shells that no longer
   * existed and accepting keystrokes into them, because the per-terminal `exit`
   * events that would have said otherwise died with the port that carried them.
   * This is the only signal that can report it.
   *
   * The subscription also clears the ack accounting for the lost ids, so a
   * revived terminal does not inherit a debt owed by a process that is gone.
   */
  onTerminalsLost(cb) {
    return subscribe(EV.terminal.terminalsLost, terminalsLostSchema, (payload) => {
      for (const terminalId of payload.terminalIds) {
        unacked.delete(terminalId);
        replayInFlight.delete(terminalId);
      }
      cb(payload.terminalIds);
    });
  },
} satisfies TerminalBridge;

/**
 * Test seam: forget the acquired port and every subscription.
 *
 * Exported because the preload boundary tests drive acquisition, replacement
 * and cleanup across cases, and module-level state that no test can reset makes
 * the second case depend on the first.
 */
export function __resetTerminalBridgeForTests(): void {
  port = null;
  portPromise = null;
  pendingArrival = null;
  lastPortDropReason = null;
  subscriptions.clear();
  unacked.clear();
  replayInFlight.clear();
  for (const parked of unclaimed.values()) parked.close();
  unclaimed.clear();
}

/** Why the port was last dropped, or `null`. A test seam for the recovery path. */
export function __lastPortDropReasonForTests(): string | null {
  return lastPortDropReason;
}
