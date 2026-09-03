/**
 * ONE LOGICAL CONNECTION relayed through the pipe front, against the real wire.
 *
 * The transport under test is the SECOND implementation of the contract the
 * host already speaks, so every case here is phrased as the contract phrases
 * it: what `write` returning `false` obliges the caller to do, when the write
 * callback may run, what `pause` must stop, and which of the three latches an
 * edge is allowed to move. A case that passes here and fails on a `net.Socket`
 * would be a case testing this implementation rather than the contract.
 *
 * Everything is driven end to end through `FrontSupervisor` and the real codec,
 * because the flow control being tested is a property of the two of them
 * together: the window lives in the relay and the sequences it acknowledges are
 * assigned by the plane owner.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StudioDuplexTransport } from "@vex-agent/mcp/duplex-transport.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
}));

const { FrontSupervisor } = await import("../mcp-host/front-supervisor.js");
const { FRONT_CHUNK_BYTES, FRONT_CREDIT_BYTES } = await import(
  "../mcp-host/front-handshake.js"
);
const { FakeFront } = await import("./fake-front.js");

const PIPE_NAME = "\\\\.\\pipe\\vex-studio-test";

let fronts: InstanceType<typeof FakeFront>[];
let admitted: StudioDuplexTransport[];
let epoch: number;
let refusal: string | null;
/** Every supervisor this file built, so `afterEach` can release its timers. */
let built: InstanceType<typeof FrontSupervisor>[];

function build(): InstanceType<typeof FrontSupervisor> {
  const supervisor = new FrontSupervisor({
    pipeName: PIPE_NAME,
    command: "/opt/vex/vex-pipe-front.exe",
    admissionEpoch: () => epoch,
    timeoutRefusalBytes: "refused\n",
    refuseBeforeRead: () => refusal,
    onConnection: (wire) => admitted.push(wire),
    onTransition: () => undefined,
    spawnFront: () => {
      const front = new FakeFront({ generation: 0x4000 + fronts.length });
      fronts.push(front);
      return front;
    },
  });
  built.push(supervisor);
  void supervisor.start();
  return supervisor;
}

function front(): InstanceType<typeof FakeFront> {
  const value = fronts[fronts.length - 1];
  if (value === undefined) throw new Error("no front was spawned");
  return value;
}

/** Bring one admitted connection up and return its wire. */
function openConnection(id = 1): StudioDuplexTransport {
  front().sendOpen(id);
  const wire = admitted[admitted.length - 1];
  if (wire === undefined) throw new Error("the connection was not admitted");
  return wire;
}

/**
 * The plane 5 sequence of the nth `DATA` frame main wrote.
 *
 * A named lookup that THROWS rather than a non-null assertion: the frame's
 * absence is the interesting failure in every case below, and an assertion
 * would report it as a property access on undefined three lines later.
 */
function dataSequence(index: number): bigint {
  const frame = front().dataOfType("DATA")[index];
  if (frame === undefined) {
    throw new Error(`main wrote no plane 5 DATA frame at index ${String(index)}`);
  }
  return frame.sequence;
}

/**
 * WAIT FOR THE RESTART. Main kills a failed front and spawns the replacement
 * only once it has seen the `exit` event: on Windows the pipe name belongs to
 * the PROCESS, so a replacement bound in the same tick binds a name the corpse
 * still owns. `front-supervisor.test.ts` owns that proof; here it is only the
 * reason a restart is one macrotask away.
 */
async function restartSettles(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await Promise.resolve();
  await Promise.resolve();
}

async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  fronts = [];
  admitted = [];
  built = [];
  epoch = 11;
  refusal = null;
});

/**
 * Every supervisor is disposed, so no bring-up timer outlives the case that
 * armed it and fires into a spawn seam a later case owns.
 */
afterEach(() => {
  for (const supervisor of built) supervisor.dispose();
  built = [];
});

describe("admission, before a byte is read", () => {
  it("ADMITs with the captured epoch and grants the first credit window", () => {
    build();
    front().completeHandshake();
    openConnection(1);

    expect(front().controlOfType("ADMIT").map((frame) => ({
      connection: frame.connection,
      epoch: frame.admissionEpoch,
    }))).toEqual([{ connection: 1, epoch: 11 }]);
    expect(front().controlOfType("CREDIT").map((frame) => frame.bytes)).toEqual([
      FRONT_CREDIT_BYTES,
    ]);
  });

  it("REFUSEs with main's exact bytes and admits nothing when Vex is locked", () => {
    build();
    front().completeHandshake();
    refusal = '{"ok":false,"code":"locked","message":"Vex is locked"}\n';
    front().sendOpen(1);

    // A locked host reads NOTHING: no ADMIT, no credit, no transport, no
    // handshake-pending slot. The front writes main's bytes and closes.
    expect(front().controlOfType("REFUSE").map((frame) => frame.bytes)).toEqual([refusal]);
    expect(front().controlOfType("ADMIT")).toHaveLength(0);
    expect(admitted).toHaveLength(0);
  });
});

describe("the read side and its credit", () => {
  it("delivers DATA and replenishes exactly what it consumed", () => {
    build();
    front().completeHandshake();
    const wire = openConnection(1);
    const seen: Buffer[] = [];
    wire.on("data", (chunk) => seen.push(chunk));

    front().sendData(1, Buffer.from("hello"));
    expect(seen.map((chunk) => chunk.toString())).toEqual(["hello"]);
    // The initial grant plus one replenishment of exactly the bytes consumed:
    // outstanding credit is back at the window and never above it.
    expect(front().controlOfType("CREDIT").map((frame) => frame.bytes)).toEqual([
      FRONT_CREDIT_BYTES,
      5,
    ]);
  });

  it("kills the front when DATA exceeds the credit main granted", async () => {
    build();
    front().completeHandshake();
    const wire = openConnection(1);
    // PAUSED, so nothing is replenished and the granted window is the whole
    // budget: three full chunks are 98304 bytes against a 65536-byte grant.
    // `credit_overrun` is a named structural failure (protocol 12.3) and it is
    // FATAL: a peer spending credit it was not given has lost the accounting.
    wire.pause();
    front().sendData(1, Buffer.alloc(FRONT_CHUNK_BYTES, 0x61));
    front().sendData(1, Buffer.alloc(FRONT_CHUNK_BYTES, 0x61));
    expect(fronts).toHaveLength(1);
    front().sendData(1, Buffer.alloc(FRONT_CHUNK_BYTES, 0x61));
    await restartSettles();
    expect(fronts).toHaveLength(2);
  });

  it("PAUSE stops replenishment AND sends the frame, and holds what still arrives", () => {
    build();
    front().completeHandshake();
    const wire = openConnection(1);
    const seen: string[] = [];
    wire.on("data", (chunk: Buffer) => seen.push(chunk.toString()));

    wire.pause();
    expect(front().controlOfType("PAUSE")).toHaveLength(1);

    // 2a measured that the front cannot cancel an in-flight read, so at most
    // one chunk arrives after PAUSE, inside credit already granted. It is
    // RETAINED - main drains plane 6 continuously so one paused connection
    // cannot stall the twenty others sharing the plane.
    front().sendData(1, Buffer.from("late"));
    expect(seen).toEqual([]);
    const creditsWhilePaused = front().controlOfType("CREDIT").length;

    wire.resume();
    expect(front().controlOfType("RESUME")).toHaveLength(1);
    expect(seen).toEqual(["late"]);
    // Replenishment resumes only now: withholding credit alone would not have
    // stopped the already-granted window, and the frame alone would have left
    // a stale grant a RESUME could not reason about.
    expect(front().controlOfType("CREDIT").length).toBe(creditsWhilePaused + 1);
  });
});

describe("the half-open latches, which are independent", () => {
  it("peer FIN raises end and readableEnded, and leaves the writable side alone", () => {
    build();
    front().completeHandshake();
    const wire = openConnection(1);
    let ended = 0;
    wire.on("end", () => (ended += 1));

    front().sendPeerEnd(1);

    expect({
      ended,
      readableEnded: wire.readableEnded,
      writableEnded: wire.writableEnded,
      destroyed: wire.destroyed,
    }).toEqual({ ended: 1, readableEnded: true, writableEnded: false, destroyed: false });

    // "A peer that half-closes is saying 'no more requests', not 'no more
    // answers'": the last response of a one-shot session must still go out.
    wire.write("answer\n");
    expect(front().dataOfType("DATA")).toHaveLength(1);
  });

  it("end() writes END on the DATA plane, behind the chunks it terminates", () => {
    build();
    front().completeHandshake();
    const wire = openConnection(1);
    wire.write("first\n");
    wire.end();

    // END on the CONTROL plane would put it on a different pipe from the bytes
    // it terminates, and the receiver could see "the peer is done" before the
    // peer's last chunk (protocol 7.1).
    expect(front().dataDown.map((frame) => frame.type)).toEqual(["DATA", "END"]);
    expect({
      writableEnded: wire.writableEnded,
      readableEnded: wire.readableEnded,
    }).toEqual({ writableEnded: true, readableEnded: false });
  });
});

describe("the main -> front window, and the cumulative acknowledgement", () => {
  it("paces one logical write INSIDE the window and settles on the covering ack", () => {
    build();
    front().completeHandshake();
    const wire = openConnection(1);
    let settled = 0;
    const line = "a".repeat(FRONT_CHUNK_BYTES * 4);

    const accepted = wire.write(line, () => (settled += 1));

    // Four chunks, a 65536-byte window: two go out and the writer is told to
    // park. Before the correction this rule fixed, all four would have been in
    // flight and the window would have bounded nothing INSIDE one write.
    expect(accepted).toBe(false);
    expect(front().dataOfType("DATA")).toHaveLength(2);
    expect(settled).toBe(0);

    // A CUMULATIVE ack for the first chunk releases exactly its bytes, so
    // exactly one more chunk may go.
    front().sendWriteDone(1, dataSequence(0));
    expect(front().dataOfType("DATA")).toHaveLength(3);
    expect(settled).toBe(0);

    front().sendWriteDone(1, dataSequence(1));
    expect(front().dataOfType("DATA")).toHaveLength(4);
    // Still nothing: an acknowledgement that does not cover the write's LAST
    // sequence releases window bytes and settles no callback.
    expect(settled).toBe(0);

    front().sendWriteDone(1, dataSequence(3));
    expect(settled).toBe(1);
  });

  it("raises drain only after the blocked write SETTLED and there is room", () => {
    build();
    front().completeHandshake();
    const wire = openConnection(1);
    let drained = 0;
    wire.on("drain", () => (drained += 1));
    let settled = 0;
    wire.write("a".repeat(FRONT_CHUNK_BYTES * 4), () => (settled += 1));

    front().sendWriteDone(1, dataSequence(0));
    front().sendWriteDone(1, dataSequence(1));
    // A drain here would tell the one writer to send its next frame into a
    // buffer that is still full, which is how a bounded queue becomes an
    // unbounded one.
    expect({ drained, settled }).toEqual({ drained: 0, settled: 0 });

    front().sendWriteDone(1, dataSequence(3));
    expect({ drained, settled }).toEqual({ drained: 1, settled: 1 });
  });

  it("never lets one connection's outstanding bytes pass the window, and is FAIR", () => {
    build();
    front().completeHandshake();
    const flooding = [openConnection(1), openConnection(2)];
    const healthy = openConnection(3);

    for (const wire of flooding) wire.write("a".repeat(FRONT_CHUNK_BYTES * 8));
    healthy.write("b".repeat(16));

    const perConnection = new Map<number, number>();
    for (const frame of front().dataOfType("DATA")) {
      perConnection.set(
        frame.connection,
        (perConnection.get(frame.connection) ?? 0)
          + (frame.type === "DATA" ? frame.payload.length : 0),
      );
    }
    // Two floods, each held at its own window, and the healthy connection's
    // single small frame is NOT queued behind either of them: the window alone
    // does not give fairness, so plane 5 is round-robin as well.
    expect(perConnection.get(1)).toBe(FRONT_CREDIT_BYTES);
    expect(perConnection.get(2)).toBe(FRONT_CREDIT_BYTES);
    expect(perConnection.get(3)).toBe(16);
  });

  it("kills the front on an acknowledgement that regresses or names an unsent sequence", async () => {
    build();
    front().completeHandshake();
    openConnection(1);
    admitted[0]?.write("a".repeat(16));
    front().sendWriteDone(1, dataSequence(0) + 5n);
    await restartSettles();
    expect(fronts).toHaveLength(2);
  });
});

describe("close, and the edge that must not overtake the last response", () => {
  it("holds the close edge until plane 6 has delivered through the named sequence", async () => {
    build();
    front().completeHandshake();
    const wire = openConnection(1);
    let closed = 0;
    wire.on("close", () => (closed += 1));

    // The front delivered two data frames and names the second. Control and
    // data are DIFFERENT pipes with no ordering between them, so the close edge
    // - which aborts every in-flight handler and withdraws a blocked approval -
    // must wait for the bytes (protocol 6.3).
    front().sendData(1, Buffer.from("one"));
    front().sendPeerClosed(1, "peer_eof", 2n);
    await microtasks();
    expect(closed).toBe(0);

    front().sendData(1, Buffer.from("two"));
    await microtasks();
    expect(closed).toBe(1);
  });

  it("destroy() sends CLOSE, raises close once, and drops later frames for it", async () => {
    build();
    front().completeHandshake();
    const wire = openConnection(1);
    let closed = 0;
    wire.on("close", () => (closed += 1));

    wire.destroy();
    wire.destroy();
    await microtasks();
    expect({ closed, frames: front().controlOfType("CLOSE").length }).toEqual({
      closed: 1,
      frames: 1,
    });

    // A frame the front wrote a microsecond before main decided to close is
    // NOT a fault; it is dropped, exactly as the front drops main's late
    // frames. The connection is not resurrected and the front is not killed.
    front().sendData(1, Buffer.from("late"));
    await microtasks();
    expect({ closed, spawns: fronts.length }).toEqual({ closed: 1, spawns: 1 });
  });

  it("kills the front when DATA arrives for a direction already ended", async () => {
    build();
    front().completeHandshake();
    openConnection(1);
    front().sendPeerEnd(1);
    front().sendData(1, Buffer.from("after"));
    // `data_after_end` (protocol 12.3), and it is fatal like every other named
    // failure except the purged stale admit.
    await restartSettles();
    expect(fronts).toHaveLength(2);
  });

  it("authors NO teardown cause: it raises the edge and the host owns the reason", async () => {
    build();
    front().completeHandshake();
    const wire = openConnection(1);
    // The contract's `destroy()` takes no cause, and this implementation adds
    // none: a PEER_CLOSED that arrives after main has latched `lock` cannot
    // rewrite it, because there is no code path here that could. The proof is
    // structural - the edge fires exactly once whatever the front's reason.
    let closed = 0;
    wire.on("close", () => (closed += 1));
    wire.destroy();
    front().sendPeerClosed(1, "commanded_close", 0n);
    await microtasks();
    expect(closed).toBe(1);
  });
});
