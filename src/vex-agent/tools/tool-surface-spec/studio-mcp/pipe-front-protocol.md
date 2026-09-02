# Vex Studio pipe-front internal transport protocol (v1, FROZEN)

Status: frozen in stage B4.2b-2p. This is the NORMATIVE home of the internal
main<->front wire. Plan v3 section 6c states the decision and the measurement
that produced it; this document states the bytes. Both sides implement it
independently and neither may change it alone.

Scope: the wire between the Electron MAIN process and the packaged Windows
`vex-pipe-front` child process, carried on the child's inherited overlapped
stdio. It is INTERNAL. It is not the bridge-facing contract: everything a
`vex-mcp` bridge observes on the named pipe - the endpoint derivation, the
handshake, the acks, the MCP framing, the bounds and the deadlines - stays
exactly `bridge-endpoint-contract.md` v1, unchanged, and this protocol exists
to relay those bytes without reinterpreting a single one of them.

Machine-readable companion: `pipe-front-vectors.json` beside this file. Every
rule below that can be expressed as data is in that fixture, and BOTH codecs
run it as a table test from that one path with no copy:

| implementation | path |
| --- | --- |
| TypeScript codec | `src/vex-agent/mcp/pipe-front-frames.ts` |
| TypeScript vectors test | `src/__tests__/vex-agent/mcp/pipe-front-frames.test.ts` |
| Go codec | `bridge/internal/front/frames/` |
| Go vectors test | `bridge/internal/front/frames/frames_test.go` (loader: `bridge/internal/vectors/frontframes.go`) |

Prose here explains WHY; the fixture is what the tests compare against.

What this stage produces is the specification, the vectors and the two codecs.
The front process and the main-side relay are later stages and are written
AGAINST this document.

---

## 1. Planes

The front is spawned by main with SEVEN stdio slots. Slots 3 to 6 are the four
extra `'overlapped'` pipes the B4.2a spike measured usable (`dedicated_over
lapped_planes_usable: true`: inherited as pipe handles, taken by the Go runtime
poller, duplex on one handle, deadlines fire, `Close` cancels a blocked read,
per-pipe OS buffer 131072 bytes, and a stall on one plane does not stall
another).

| slot | name | direction | carries |
| --- | --- | --- | --- |
| 0 | stdin | main -> front | NOTHING. Never written after spawn. Its EOF is the parent-death signal of section 8 |
| 1 | stdout | front -> main | NOTHING. Never written by the front |
| 2 | stderr | front -> main | structural logs only: codes and counts, never framed protocol bytes and never peer content |
| 3 | control-down | main -> front | CONTROL frames, section 5 |
| 4 | control-up | front -> main | CONTROL frames, section 6 |
| 5 | data-down | main -> front | DATA and END frames, section 7 |
| 6 | data-up | front -> main | DATA and END frames, section 7 |

THE WHOLE PROTOCOL LIVES ON PLANES 3 TO 6, INCLUDING THE HANDSHAKE. `HELLO`
travels on plane 3 and `HELLO_ACK` on plane 4. stdin and stdout carry nothing.

That is a deliberate choice and it buys one property: a stray `print`,
`fmt.Println`, a panic banner or any library that writes to stdout cannot
corrupt a framed stream, because no framed stream is on stdout. The Go runtime
writes panics to stderr, which by this table is a log plane whose content main
never parses as frames. A protocol that put HELLO on stdio would have to treat
the very first bytes of the child's life - the window where a startup print is
most likely - as protocol.

Each plane is an independent framed stream with its OWN sequence counter
(section 3). Control is never queued behind data because control has its own
pipe, which is the property the dedicated-plane shape was chosen for.

---

## 2. Frame header

EVERY frame on planes 3 to 6 begins with the same 28-byte header, LITTLE-ENDIAN
throughout. Little-endian because both peers are x64/arm64 Windows processes and
the front's Go side reads it with `encoding/binary.LittleEndian`; there is no
network hop and no big-endian peer, so byte order is a fixed protocol constant,
not a portability decision.

| offset | size | field | type | rule |
| --- | --- | --- | --- | --- |
| 0 | 4 | `magic` | u32 LE | EXACTLY `0x46584556`. On the wire the bytes are `56 45 58 46`, which read as the ASCII `VEXF`. Any other value is malformed (`bad_magic`) |
| 4 | 4 | `generation` | u32 LE | the front generation of section 4. `0` only on `HELLO` and `HELLO_ACK`; every other frame carries the negotiated non-zero generation. A mismatch is malformed (`bad_generation`) |
| 8 | 4 | `connection` | u32 LE | the logical connection id, or `0` for a frame that names no connection. Section 2.1 |
| 12 | 8 | `sequence` | u64 LE | per plane, starts at `1`, EXACTLY contiguous. Section 3 |
| 20 | 1 | `type` | u8 | section 5, 6 and 7. A type that is not defined for the frame's plane is malformed (`type_not_on_plane`) |
| 21 | 1 | `flags` | u8 | ALL EIGHT BITS RESERVED, `0`. A set bit is malformed (`flags_set`) |
| 22 | 2 | `reserved` | u16 LE | `0`. Non-zero is malformed (`reserved_set`) |
| 24 | 4 | `length` | u32 LE | payload byte count. Section 2.2 |

`flags` and `reserved` exist so a v2 has somewhere additive to go, and they are
STRICTLY zero in v1 for exactly that reason: a v1 reader that ignored a set bit
would let a v2 sender believe a v1 front understood a flag it silently dropped.
Fail closed instead.

`sequence` is a u64 and TypeScript reads it as a `BigInt`. A `number` cannot
hold u64 exactly, and the sequence is compared for equality on every frame.

### 2.1 The connection field

| requirement | types |
| --- | --- |
| `connection` MUST be `0` | `HELLO`, `LOCK`, `QUIT`, `PING`, `HELLO_ACK`, `BOUND`, `LOCK_ACK`, `QUIT_ACK`, `PONG`, `ERROR` |
| `connection` MUST be non-zero | `ADMIT`, `REFUSE`, `CREDIT`, `PAUSE`, `RESUME`, `CLOSE`, `OPEN`, `WRITE_DONE`, `PEER_CLOSED`, `DATA`, `END` |

A violation is malformed (`connection_zero` or `connection_not_zero`). On a DATA
plane, `connection == 0` is `connection_zero`: the data planes never carry a
frame with no connection, so a zero there is a framing fault and not an
addressing convention.

Connection ids are allocated by the FRONT, are non-zero, and are NEVER REUSED
within a generation. Exhausting the u32 space within one generation forces a
front restart, which is main's decision to take (a new generation resets the
space, section 4). At the raw bound of 21 concurrent connections, exhausting
2^32-1 ids would take a connection churn no MCP client produces; the rule exists
so that a late frame for a closed connection can never be mistaken for a live
one, which is a correctness property and not a capacity one.

### 2.2 Length, and the retained partial frame

| plane | payload bound |
| --- | --- |
| 3, 4 (control) | 4096 bytes |
| 5, 6 (data) | 32768 bytes |

`length` over the frame's plane bound is malformed (`length_over_bound`), and it
is detected AT HEADER PARSE, before a single payload byte is retained. That is
what makes the decoder's retention bound real:

MAXIMUM RETAINED PARTIAL FRAME = 28 + the plane's payload bound. 4124 bytes on a
control plane, 32796 bytes on a data plane. A decoder that buffered first and
checked the bound afterwards would let a hostile or broken sender pin memory
with one 4 GiB length field, which is exactly the shape this ordering forbids.

The control bound of 4096 is not arbitrary: it is the frozen
`handshakeMaxBytes` of the endpoint contract's section 3 limits table, so ANY
ack or refusal line the host is allowed to author on the external wire fits in
ONE control frame with room for the frame's own fixed fields. See section 9.

---

## 3. Sequence

Each of the four planes carries its own u64 counter. The first frame a sender
writes on a plane has `sequence = 1`, and every following frame on that plane is
exactly the previous plus one. A gap, a repeat or a decrease is malformed
(`sequence_gap`).

Contiguity, not monotonicity. A pipe does not reorder or drop, so a gap is not
congestion: it is a sender that lost a frame internally or a reader that lost
its place, and both are unrecoverable states in which the safe move is to fail
the front rather than to resynchronise on a stream whose framing is already in
question.

The counters are INDEPENDENT across planes and across directions. Plane 5's
sequence 7 has no relationship to plane 3's sequence 7.

Sequence exhaustion is unreachable and is nevertheless defined: a frame whose
`sequence` is `18446744073709551615` (2^64-1) is malformed
(`sequence_exhausted`), and no sender may emit it. At the measured 156 MiB/s per
direction in 32 KiB chunks - about 5000 frames per second - reaching 2^64 takes
on the order of 10^11 years. The rule is a definition, not a mechanism: a wrap
would silently reissue sequence 1 and hand a decoder a valid-looking replay.

Sequence numbers are per generation. A restart is a new generation and every
plane restarts at 1 (section 4).

---

## 4. Generation, and the bootstrap

1. Main spawns the front and writes `HELLO` on plane 3 with `generation = 0`,
   `connection = 0`, `sequence = 1`.
2. The front answers `HELLO_ACK` on plane 4 with header `generation = 0`,
   `connection = 0`, `sequence = 1`, and a PAYLOAD carrying a fresh NON-ZERO
   `generation` of its own choosing.
3. Every subsequent frame in BOTH directions, on all four planes, carries that
   generation in its header. A frame carrying any other value is malformed
   (`bad_generation`).

A reader of plane 4 LEARNS the generation from `HELLO_ACK` itself; readers of
planes 3, 5 and 6 are told it by their owner. `HELLO` and `HELLO_ACK` are legal
ONLY while a reader is still in the bootstrap state: once a generation is
adopted, a further bootstrap frame is `bad_generation`, so a second `HELLO_ACK`
can never re-point a live reader at a new generation.

`HELLO` and `HELLO_ACK` are the only two frames with header `generation = 0`,
and a header `generation` of `0` on any other type is `bad_generation`. Main
cannot echo a generation it has not yet been told, so the bootstrap pair is
carved out explicitly rather than left as an implicit special case a reader has
to infer.

The generation is chosen by the FRONT because the front is the process whose
identity it names: it distinguishes the frames of THIS front process from those
of the one main just killed. Monotonicity across restarts is MAIN'S bookkeeping
(main rejects a `HELLO_ACK` whose generation it has already seen and restarts),
because only main survives a restart and only main can remember.

WHY IT IS LOAD-BEARING. When main kills a front and starts a new one, frames
from the dead front may still sit in the OS pipe buffer - up to 131072 bytes per
plane, measured. Without a generation those frames address connection ids the
new front will one day allocate, and a stale `DATA` would be delivered to a live
connection belonging to a different peer. The generation makes every such frame
malformed by construction, and section 10 makes malformed fatal.

---

## 5. Control frames, main -> front (plane 3)

| id | name | connection | payload bytes | payload |
| --- | --- | --- | --- | --- |
| `0x01` | `HELLO` | 0 | 17 + strings | section 5.1 |
| `0x02` | `ADMIT` | non-zero | 4 | `admissionEpoch` u32 |
| `0x03` | `REFUSE` | non-zero | 2 + n | `bytes` str |
| `0x04` | `CREDIT` | non-zero | 4 | `bytes` u32 |
| `0x05` | `PAUSE` | non-zero | 0 | none |
| `0x06` | `RESUME` | non-zero | 0 | none |
| `0x07` | `CLOSE` | non-zero | 0 | none |
| `0x08` | `LOCK` | 0 | 4 | `admissionEpoch` u32 |
| `0x09` | `QUIT` | 0 | 4 | `deadlineMs` u32 |
| `0x0A` | `PING` | 0 | 8 | `nonce` u64 |

Type `0x00` is not defined anywhere and is malformed on every plane.

STRING ENCODING, used by every `str` field in this document: a `u16 LE` byte
LENGTH followed by exactly that many UTF-8 bytes. The length counts BYTES, not
code points or UTF-16 units. FIXED-WIDTH FIELDS COME FIRST IN EVERY PAYLOAD,
then the length-prefixed strings in the order the layout names them, so a
decoder reads a payload's fixed part at constant offsets and only then walks the
variable tail. A payload whose declared string lengths do not consume the frame
exactly is malformed (`payload_length_mismatch`), and a string length that runs
past the payload is malformed (`string_over_payload`).

The FRAME's `length` is authoritative: a payload with trailing bytes after the
last declared field is malformed. There is no room in v1 for an unknown
trailing field, which is the same fail-closed decision as `flags`.

### 5.1 `HELLO` payload

| offset | size | field | type | v1 value |
| --- | --- | --- | --- | --- |
| 0 | 2 | `protocolVersion` | u16 | `1` |
| 2 | 1 | `sddlKind` | u8 | `1` = "owner+SYSTEM protected allow-list" |
| 3 | 2 | `maxRaw` | u16 | `21` |
| 5 | 4 | `creditBytes` | u32 | `65536` |
| 9 | 4 | `chunkBytes` | u32 | `32768` |
| 13 | 4 | `handshakeDeadlineMs` | u32 | `5000` |
| 17 | var | `pipeName` | str | the pipe the front must serve |
| var | var | `timeoutRefusalBytes` | str | section 9 |

THE SIX NUMBERS ARE FROZEN EQUALITY CHECKS, not negotiation. The front compares
each against its own compiled-in constant and, on ANY difference, refuses to
serve: it writes one structural stderr line naming the field, the value it
received and the value it holds, and exits. It does not adapt, and it does not
serve with the main-supplied value.

That is the opposite of a version handshake and it is deliberate. Main and the
front ship in the SAME package, built together, signed together and updated
together - unlike the bridge, which ships on its own cadence and is exactly why
the external contract negotiates a version at all. Two internal peers that
disagree about `chunkBytes` are a packaging fault, and a front that quietly
adapted would turn a build error into a bounds mismatch discovered under load.
`protocolVersion` is included in the same equality check for the same reason:
there is no v1-front-with-v2-main case to support, and section 12 says what a
change costs.

`sddlKind` is an ENUM and not a descriptor string. The actual SDDL is compiled
into the front, where it can be reviewed and tested; main names WHICH policy to
apply. A main process that could hand the front an arbitrary security
descriptor would be a privileged sink fed from a string, and the string would
have to be trusted by the very component whose job is to be the only one that
knows the pipe security model. `1` is the only value v1 defines; any other is a
refusal in the same class as a number mismatch.

`pipeName` is the name derived by the frozen endpoint contract section 1.2. The
front SERVES it and never derives it: two derivations are two sources of truth,
and the front does not have main's config directory.

---

## 6. Control frames, front -> main (plane 4)

| id | name | connection | payload bytes | payload |
| --- | --- | --- | --- | --- |
| `0x41` | `HELLO_ACK` | 0 | 10 + strings | section 6.1 |
| `0x42` | `BOUND` | 0 | 1 + 2 + n | `flagsApplied` u8, `pipeName` str |
| `0x43` | `OPEN` | non-zero | 0 | none |
| `0x44` | `WRITE_DONE` | non-zero | 8 | `throughSequence` u64 |
| `0x45` | `PEER_CLOSED` | non-zero | 9 | `reason` u8, `throughDataSequence` u64 |
| `0x46` | `LOCK_ACK` | 0 | 8 | `admissionEpoch` u32, `closedCount` u32 |
| `0x47` | `QUIT_ACK` | 0 | 0 | none |
| `0x48` | `PONG` | 0 | 8 | `nonce` u64 |
| `0x49` | `ERROR` | 0 | 6 | `code` u16, `count` u32 |

### 6.1 `HELLO_ACK` payload

| offset | size | field | type |
| --- | --- | --- | --- |
| 0 | 2 | `protocolVersion` | u16 |
| 2 | 4 | `announcedGeneration` | u32, NON-ZERO |
| 6 | 4 | `pid` | u32 |
| 10 | var | `frontVersion` | str |
| var | var | `buildHash` | str |

`announcedGeneration = 0` is malformed (`generation_zero`): the whole point of
the field is to leave the bootstrap generation behind. It is named apart from
the header's `generation` on purpose - the two carry DIFFERENT values in this
one frame, the header still `0` and the payload the new one, and a decoded
frame that used one name for both would silently lose the header's.

`pid` is a CONSISTENCY CHECK, not authentication. Main compares it with the
`child.pid` it already holds from `spawn`, and a mismatch means main is talking
to a process it did not start, which is a fatal structural condition. It is not
an authorisation: main's authority over the front comes from having spawned a
packaged, signed binary at a path it controls, and a pid an attacker could
choose is not evidence of anything. `frontVersion` and `buildHash` are recorded
in main's structural log so a support bundle can say which front produced a
session.

### 6.2 `BOUND`

`flagsApplied` is a bitfield of what the front VERIFIED, read back from the
created pipe handle at runtime:

| bit | mask | meaning |
| --- | --- | --- |
| 0 | `0x01` | `rejectRemote` - the pipe rejects remote clients |
| 1 | `0x02` | `firstInstance` - the front created the pipe rather than joining an existing one |
| 2 | `0x04` | `messageMode` - the pipe is in message mode, which is what makes `CloseWrite` available (endpoint contract 3.5) |
| 3-7 | - | reserved, `0`. A set bit is malformed (`bound_flags_reserved`) |

`BOUND` IS EMITTED ONLY AFTER RUNTIME READBACK, NEVER AFTER MERELY REQUESTING.
A flag the front asked for and did not confirm is reported as `0`, and main
decides what to do about it. The distinction is the whole value of the frame: a
front that echoed its own request would tell main "remote clients are rejected"
on a build where the flag silently did nothing, and main would announce a
listener with a security property it does not have. The pipe name is echoed so
main can assert the front served the name it was told to serve.

### 6.3 `PEER_CLOSED`

`reason` is a STRUCTURAL cause and never a domain cause:

| value | name | meaning |
| --- | --- | --- |
| `1` | `peer_eof` | the peer closed or half-closed its side |
| `2` | `io_error` | the pipe handle failed |
| `3` | `commanded_close` | the front closed the handle because main told it to (`CLOSE`, `LOCK`, `QUIT`) |

`0` and any value above `3` are malformed (`peer_closed_reason`).

MAIN MAPS THIS TO A TEARDOWN CAUSE; THE FRONT NEVER AUTHORS ONE. Endpoint
contract section 4 makes the cause a trusted typed value owned by the teardown's
owner, and that owner is main: if main has already latched `lock` or `vex_quit`
for this connection, the latched cause stands; otherwise the cause is
`disconnect`. `commanded_close` exists so main can tell "the front did what I
asked" from "the peer left", which is a structural log distinction, not a second
place to decide what a human sees. The front cannot author `lock` and does not
know the word.

`throughDataSequence` is the plane 6 sequence of the LAST `DATA` or `END` frame
the front delivered for this connection, or `0` if it delivered none. MAIN
DELAYS THE CLOSE EDGE until its plane 6 decoder has delivered through that
sequence. Without it the close edge - which is what aborts every in-flight MCP
handler and withdraws a blocked approval (endpoint contract 3.2 and 4) - could
overtake the peer's last response, because control and data are on DIFFERENT
pipes with no ordering between them. The dedicated-plane shape is what removes
head-of-line blocking; this field is the price, and it is paid once per
connection.

### 6.4 `WRITE_DONE`

`throughSequence` is the plane 5 sequence of the LAST chunk of ONE logical
write. Exactly ONE `WRITE_DONE` per logical write, whatever the chunk count.

This is the frame the seam's write callback settles on
(`src/vex-agent/mcp/duplex-transport.ts`): "`callback` means THE PEER-SIDE WRITE
COMPLETED ... An implementation that relays through another process (the Windows
pipe-front) may only run it once that process has reported the pipe write
complete; running it on hand-off to the relay would make the outbound queue
believe a frame is delivered while it sits in somebody else's buffer, and the
queue's bound would stop bounding anything real." The front therefore emits
`WRITE_DONE` after the Go pipe write for the last chunk RETURNS, not when it
accepts the chunk from plane 5.

### 6.5 `ERROR`

`code` is a front-authored structural code from the front's own closed set, and
`count` is how many times it has occurred since the last `ERROR` for that code.
It is a counter frame for main's structural log. It carries NO string: peer
bytes, provider payloads and paths never travel in it, and a code plus a count
is what a log line needs (rules 05 and 07). It never carries a connection and
never ends one; a failure that ends a connection is a `PEER_CLOSED`.

---

## 7. Data frames (planes 5 and 6)

| id | name | connection | payload |
| --- | --- | --- | --- |
| `0x81` | `DATA` | non-zero | 1 to 32768 raw bytes |
| `0x82` | `END` | non-zero | 0 bytes |

A `DATA` frame with `length = 0` is malformed (`empty_data`). A zero-byte write
conveys nothing, consumes a sequence number and a credit accounting step, and
gives a broken sender an infinite supply of legal frames; there is no case in
which either side needs to send one.

`DATA` payload bytes are OPAQUE. They are the external peer's bytes on the way
in and the host's frames on the way out, and neither the front nor the framing
layer parses them. The one exception is the front's newline scan of section 9,
which finds a byte and interprets nothing.

### 7.1 `END` travels on the DATA plane, and that is the point

`END` is the ordered graceful half-close marker, and it is a DATA-plane frame so
it CANNOT OVERTAKE THE LAST CHUNK. Putting it on the control plane would put it
on a different pipe from the bytes it terminates, and the receiver could see
"the peer is done" before the peer's last 32 KiB.

| direction | `END` means |
| --- | --- |
| plane 5, main -> front | the relay's `end()`: close the WRITABLE side of the pipe handle, leave the readable side open |
| plane 6, front -> main | the peer's FIN: main raises the seam's `end` with the writable side PRESERVED |

Half-open is contract, not accident. `duplex-transport.ts`: "A peer that
half-closes is saying 'no more requests', not 'no more answers': `end` must fire
without the writable side being torn down, so the last response of a one-shot
session can still be written. An implementation that ends the writable side on
peer FIN breaks every `claude -p` style session, silently."

`END` is followed by no further `DATA` or `END` for that connection in that
direction. A `DATA` after an `END` on the same connection and plane is a sender
fault; it is NOT caught by the framing codec (which is stateless about
connections by design, section 11) and is a relay-level invariant the front and
main each enforce on their own side.

### 7.2 Chunking and logical writes

One logical write may span several `DATA` frames of at most `chunkBytes`
(32768). The chunks of one connection's logical write are contiguous on the
plane with respect to that connection; frames for DIFFERENT connections may
interleave between them, which is what makes the plane a multiplex.

`WRITE_DONE` names the last chunk's sequence (section 6.4). That is why the
frame carries a sequence and not a count: sequences are already the plane's
identity, and a per-connection counter would be a second one.

---

## 8. Lifecycle

| stage | rule |
| --- | --- |
| start | the front starts LOCKED. It creates the pipe, verifies the flags, emits `BOUND`, and then ACCEPTS connections, sends `OPEN`, and READS NOTHING from any of them |
| admit | `ADMIT(conn, epoch)` begins reading that connection ONLY IF `epoch` equals the front's current admission epoch |
| refuse | `REFUSE(conn, bytes)` writes main's exact bytes to the peer and closes, WITHOUT EVER READING |
| lock | `LOCK(epoch)` is processed BEFORE any queued frame. It sets the admission epoch, stops all reads, closes all handles, and answers `LOCK_ACK` |
| quit | `QUIT(deadlineMs)` drains and answers `QUIT_ACK` |
| control EOF | plane 3 closed is TERMINAL: the front exits |
| parent death | stdin EOF, or the parent handle signalling, exits the front |

THE ADMISSION EPOCH IS THE FENCE. A `LOCK(epoch)` raises the front's epoch;
every `ADMIT` still queued behind it names the OLD epoch and is PURGED, not
executed. Without that rule a lock could be immediately undone by an `ADMIT`
main sent a microsecond before deciding to lock, and reading would resume on a
connection main has already latched a `lock` cause for. This is the
"fail closed on control-channel loss" obligation of endpoint contract 4.1.1 in
its ordinary, non-failure form: an ambiguous order never opens a door.

`LOCK` IS PRIORITY. The front processes it ahead of any queued frame on plane 3,
which is the "PRIORITY LOCK FRAME to the front, ahead of any queued traffic"
that 4.1.1 requires. The front answers `LOCK_ACK` within 1000 ms; past that
deadline main KILLS the front and restarts it LOCKED, under a NEW generation.
The restarted front's connection ids are new and every frame from the dead one
is `bad_generation` (section 4). "A front that cannot be commanded is never left
holding live handles."

`closedCount` in `LOCK_ACK` is how many handles the front actually closed. Main
logs it against the number of logical connections it believed were open; a
divergence is a structural defect worth seeing, not a reason to hold the lock.

QUIT RUNS UNDER MAIN'S ONE ABSOLUTE 5000 MS BUDGET, never 5000 ms per layer.
`deadlineMs` in `QUIT` is what REMAINS of that budget at the moment main sends
the frame, so the front's drain and main's own shutdown share one clock. Two
independent 5-second deadlines is a 10-second quit, and endpoint contract 3
promises one.

---

## 9. Handshake timing, and who authors bytes

The endpoint contract's handshake deadline is 5000 ms and it is MEASURED FROM
`Accept`. Under the front architecture the front is the process that accepts, so
the front owns the timer, and main's first sight of the connection is already
later than the clock's start.

THE FRONT DETECTS THE FIRST NEWLINE AND NOTHING ELSE. It does not parse JSON, it
does not look at a project id, it does not interpret a single project byte. On
expiry it writes `HELLO`'s `timeoutRefusalBytes` verbatim and closes.

THE REFUSAL BYTES ARE MAIN'S, ALWAYS. Main authors every refusal line the
external peer sees: `timeoutRefusalBytes` for the deadline case, and `REFUSE`'s
`bytes` for every decision main makes itself. The front is CAUSE-TRANSPARENT: it
relays bytes it did not compose, so the frozen v1 acks and refusal codes stay
exactly what the bridge already parses, and a second author of refusal text
never appears.

THE HOST ENCODER ENFORCES THE 4096 BOUND. A `REFUSE` or `HELLO` whose refusal
string would not fit in the control bound is A HOST BUG: the encoder REJECTS the
frame loudly and main reports it. It is never truncated. The bound is not
tight - `handshakeMaxBytes` is itself 4096, and no ack the host is permitted to
author approaches it - so a rejection here means main tried to write something
it was never allowed to write on the external wire either.

---

## 10. Malformed handling, symmetric

A malformed frame is FATAL in both directions, and the two sides differ only in
what they own:

| observer | action |
| --- | --- |
| the FRONT sees a malformed frame from main | exit with a structural stderr code; every connection's handle is closed |
| MAIN sees a malformed frame from the front | kill the front and restart it LOCKED under a new generation; every logical connection fails CLOSED with main's own latched cause, or `disconnect` |

BOTH REPORT, on their structural log: the PLANE, the TYPE, the LENGTH, the
SEQUENCE of the offending frame, and the reason. Never the payload, which is
peer content.

There is no resynchronisation and no skipping. Once the framing is wrong, the
position in the stream is unknown, and every byte after it is a guess. Killing
the front is cheap; a mis-framed relay that silently delivers one connection's
bytes to another is not recoverable at all.

The reason vocabulary, identical in both codecs and in the fixture:

| reason | trigger |
| --- | --- |
| `bad_magic` | header `magic` is not `0x46584556` |
| `bad_generation` | header `generation` is not the negotiated one (or not `0` on `HELLO` / `HELLO_ACK`) |
| `flags_set` | header `flags` is not `0` |
| `reserved_set` | header `reserved` is not `0` |
| `length_over_bound` | header `length` exceeds the plane's payload bound |
| `sequence_gap` | header `sequence` is not exactly the expected next value |
| `sequence_exhausted` | header `sequence` is `2^64-1` |
| `unknown_type` | header `type` is not a defined type |
| `type_not_on_plane` | the type is defined but not carried by this plane |
| `connection_zero` | a type that requires a connection carries `0` |
| `connection_not_zero` | a type that names no connection carries a non-zero id |
| `payload_length_mismatch` | the payload does not consume the frame exactly |
| `string_over_payload` | a `u16` string length runs past the payload |
| `invalid_utf8` | a `str` field is not valid UTF-8 |
| `empty_data` | a `DATA` frame has `length = 0` |
| `generation_zero` | `HELLO_ACK`'s payload generation is `0` |
| `sddl_kind` | `HELLO`'s `sddlKind` is not `1` |
| `peer_closed_reason` | `PEER_CLOSED`'s `reason` is not `1`, `2` or `3` |
| `bound_flags_reserved` | `BOUND`'s `flagsApplied` sets a reserved bit |

### 10.1 Validation order is FROZEN

A frame can violate two rules at once, and two codecs that checked them in
different orders would report different reasons for the same bytes. The reason
travels into a structural log an operator reads and into the fixture both
implementations are held to, so the order is contract:

HEADER PHASE, in this order:

1. `bad_magic`
2. `flags_set`
3. `reserved_set`
4. `unknown_type`
5. `type_not_on_plane`
6. `bad_generation`
7. `sequence_exhausted`
8. `sequence_gap`
9. `length_over_bound`
10. `connection_zero` / `connection_not_zero`

The header phase completes before ONE payload byte is retained, which is what
makes the retention bound of section 2.2 hold.

PAYLOAD PHASE, in this order:

11. `empty_data`
12. `payload_length_mismatch` for a payload too short for the type's fixed part
13. walking the length-prefixed tail IN FIELD ORDER, per field:
    `string_over_payload` when the `u16` length runs past the payload, then
    `invalid_utf8` when the bytes are not valid UTF-8
14. `payload_length_mismatch` if bytes remain after the last declared field
15. the type-specific enums: `generation_zero`, `sddl_kind`,
    `peer_closed_reason`, `bound_flags_reserved`

---

## 11. Flow control and bounds

| bound | value | owner |
| --- | --- | --- |
| control payload | 4096 bytes | both |
| data payload / `chunkBytes` | 32768 bytes | both |
| per-connection credit, front -> main | 65536 bytes | main grants, the front spends |
| per-connection outstanding bytes, main -> front | 65536 bytes | main |
| raw accepted connections | 21 | the front |
| `LOCK_ACK` deadline | 1000 ms | main |
| handshake deadline | 5000 ms | the front, from `Accept` |
| quit budget | 5000 ms absolute across main and the front | main |
| measured per-pipe OS buffer | 131072 bytes | Windows |
| maximum retained partial frame | 4124 control / 32796 data | each decoder |
| aggregate front -> main retention in main | 1409052 bytes | main |

The aggregate is `21 * 65536 + 32796` - every raw connection's full outstanding
credit plus one plane 6 decoder's maximum partial frame. It is the number a
reviewer should hold main to when main "drains plane 6 continuously".

### 11.1 Credit, front -> main (plane 6)

The front may send `DATA` for a connection only against credit main granted with
`CREDIT(conn, bytes)`, and it NEVER BUFFERS MORE THAN THE OUTSTANDING CREDIT for
that connection: at the credit bound it STOPS READING the pipe handle, so the
back pressure reaches the external peer through the OS rather than through a
buffer in the front with a comforting name. That is `duplex-transport.ts`'s
`pause` obligation - "it must stop reading from the operating system, so the
pressure reaches the peer" - honoured one process further out.

Credit is spent by `DATA` payload bytes only. `END` costs no credit: it carries
no payload, and a half-close that could be blocked by an exhausted credit window
would be a deadlock (main is waiting for the EOF it will only grant credit for
after it sees it).

FAIRNESS: at most ONE 32 KiB chunk per connection per turn on plane 6,
round-robin. One busy connection cannot starve twenty others on a shared plane.

CREDIT OVERRUN IS MALFORMED AND FATAL. A `DATA` frame that would take a
connection past its outstanding credit, and a `CREDIT` that would exceed the
64 KiB window, are both framing-level faults handled by section 10. They are not
codec-level: the codec is stateless about connections (section 11.3), so the
relay on each side enforces them.

MAIN DRAINS PLANE 6 CONTINUOUSLY, EVEN FOR A PAUSED CONNECTION. Plane 6 is
shared: a main that stopped reading it because ONE logical connection is paused
would stall all twenty others behind it. Main keeps reading and retains at most
the paused connection's outstanding credit, which is what makes the aggregate
above a real bound.

`PAUSE(conn)` IS SENT IMMEDIATELY AND CREDIT REPLENISHMENT STOPS. Both, not
either. Withholding new credit alone does not stop an already-granted window, so
up to 64 KiB would still arrive after main decided to pause; sending `PAUSE`
alone would leave a stale grant that a `RESUME` cannot reason about. `RESUME`
resumes reading and replenishment together.

### 11.2 The main -> front window

Main starts NO new logical write for a connection while 65536 or more of its
bytes are outstanding - sent on plane 5 and not yet covered by a `WRITE_DONE`. A
single logical write LARGER than the window is still sent in full, chunked; the
window governs when the NEXT one starts.

65536 is deliberately half the measured 131072-byte OS pipe buffer, so one
connection's outstanding bytes can never fill the shared plane 5 and block a
second connection's chunk behind it. Head-of-line is bounded by the window, not
by the operating system.

### 11.3 The codec is stateless about connections

Both codecs validate the HEADER, the per-plane sequence, and the per-type
payload layout. They do NOT track connections, credit, admission, `END`
ordering, or write windows: those are relay state with a different lifetime, a
different owner and a different test surface. A codec that owned them would be
the relay, and the two later stages would have nothing to implement against.

---

## 12. Trust

VERBATIM, and it is the paragraph any later change to this file must keep true:

> vex-mcp authenticates the named-pipe server process it actually connected to;
> under the front architecture that server is vex-pipe-front, so host
> authentication validates the front process's same-user SID before the bridge
> sends its project handshake. The front is trusted for pipe mechanics because
> it is the verified packaged child, never for wallet policy or teardown-cause
> authorship.

DACL: a PROTECTED allow-list containing only the current user's SID and SYSTEM
allow ACEs. NO Everyone-deny ACE. A deny ACE is a common reflex and the wrong
one here: an allow-list already denies everyone it does not name, and a
protected descriptor stops inheritance from adding anyone, while a deny ACE
sorted ahead of the allows can deny the owner through a group membership nobody
predicted.

This is what `sddlKind = 1` names, and endpoint contract 1.6's host
authentication is what makes the front's identity checkable from the bridge
side: `GetNamedPipeServerProcessId` on the connected handle now reports the
FRONT's pid, and the same-user SID comparison is the anti-squatting control.

---

## 13. Changing this protocol

The version in `HELLO` is a MAJOR, and it is a FROZEN EQUALITY CHECK (section
5.1), so there is no compatible change: main and the front ship in one package,
built and signed together, and any wire change is a v2 on both sides in the same
commit. `flags`, `reserved` and the unused type ids are where a v2 goes.

Regenerate `pipe-front-vectors.json` deliberately in the same change, and review
it as the wire artifact it is. Both codecs run it; a change that is not in the
fixture is a change neither side proves.
