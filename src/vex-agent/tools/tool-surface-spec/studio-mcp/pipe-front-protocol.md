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

THE BOUND HOLDS AT EVERY MOMENT DURING A PUSH, NOT MERELY AFTER ONE. Both
decoders are STAGED: they consume the caller's chunk BY OFFSET and never
concatenate it into a buffer of their own. At most 28 bytes are staged as a
header; the header is validated in full, the plane's bound included; only then
is a payload buffer of exactly the DECLARED length allocated. A decoder that
merged the chunk first would satisfy the bound on the way out and violate it in
the middle - one OS read of a shared plane carries many frames, and a malformed
header followed by a large body is precisely the case an attacker picks. Each
decoder therefore reports the PEAK capacity of its own buffers
(`peakRetainedBytes` / `PeakRetainedBytes()`), and both suites assert it against
this table.

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
| `0x01` | `HELLO` | 0 | 21 + strings | section 5.1 |
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
| 17 | 4 | `initialAdmissionEpoch` | u32 | DYNAMIC, section 5.2 |
| 21 | var | `pipeName` | str | the pipe the front must serve |
| var | var | `timeoutRefusalBytes` | str | section 9 |

THE SIX NUMBERS ARE FROZEN EQUALITY CHECKS, not negotiation - `protocolVersion`,
`sddlKind`, `maxRaw`, `creditBytes`, `chunkBytes` and `handshakeDeadlineMs`, and
NOT `initialAdmissionEpoch`, which is the one dynamic field and is defined apart
in 5.2. The front compares each of the six against its own compiled-in constant
and, on ANY difference, refuses to serve: it writes one structural stderr line
naming the field, the value it received and the value it holds, and exits. It
does not adapt, and it does not serve with the main-supplied value.

That is the opposite of a version handshake and it is deliberate. Main and the
front ship in the SAME package, built together, signed together and updated
together - unlike the bridge, which ships on its own cadence and is exactly why
the external contract negotiates a version at all. Two internal peers that
disagree about `chunkBytes` are a packaging fault, and a front that quietly
adapted would turn a build error into a bounds mismatch discovered under load.
`protocolVersion` is included in the same equality check for the same reason:
there is no v1-front-with-v2-main case to support, and section 14 says what a
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

### 5.2 `initialAdmissionEpoch`, and why it cannot be frozen

The front's admission epoch is INITIALISED to this value, and from then on only
`LOCK` raises it (section 8). `ADMIT(conn, epoch)` is executed only when `epoch`
equals the front's current epoch, so the front must start at MAIN's epoch, not
at zero.

`initialAdmissionEpoch` IS ALWAYS MAIN'S CURRENT APP-LIFETIME ADMISSION EPOCH:
the value `studioAdmissionEpoch()` reports at the moment the front is spawned.
Main's epoch is monotonic and is NEVER reset for the life of the process
(`vex-app/src/main/studio/mcp-host/admission.ts`), so a RESTARTED front receives
the SAME current epoch the dead one was last serving, never a fresh count. The
front never resets, chooses or advances the epoch: its only epoch write is the
value a `LOCK` carries, and only main's lock path advances it.

A FRONT IS NOT ALWAYS THE FIRST FRONT, AND RESTARTING IT INVALIDATES NOTHING.
Killing the CHILD does not invalidate the stale continuations still living in
MAIN, and those continuations are precisely what the fence exists to stop; a
front restart is a transport event, not an authority event. So after one
lock/unlock cycle the epoch is non-zero and stays non-zero for as long as main
lives. A restarted front that assumed 0 would have two ways to be wrong and no
way to be right: reject every valid `ADMIT` main sends (no connection is ever
read again, and the failure is a silent hang rather than an error), or adopt the
epoch of the first `ADMIT` it sees, which is a stale order teaching the fence its
own value. Handing MAIN's current epoch over in `HELLO` is the only version where
the fence survives the restart it exists for.

It is DYNAMIC and therefore NOT one of the frozen equality values: the front
holds no compiled-in expectation to compare it against. It is the one number in
`HELLO` the front takes rather than checks.

U32 EXHAUSTION CLOSES ADMISSION PERMANENTLY. The epoch is a u32 and it only ever
rises. `4294967295` is the last usable value: main MUST NOT raise the epoch past
it, and a main that has reached it CLOSES ADMISSION PERMANENTLY - it refuses any
further epoch advancement and any further admission for the life of the process,
and the host reports a typed "admission permanently closed" unavailable state
whose only remedy is a FULL VEX APPLICATION RESTART. A FRONT RESTART IS NOT THE
REMEDY and must never be offered as one: the new front would be handed the same
exhausted epoch, and the only thing that could give it a fresh fence - resetting
main's epoch - is the exact reuse the fence forbids, because a queued `ADMIT`
main already purged still names a value the reset would reissue. The host-status
cause code for that unavailable state is MAIN's concern and stage 2b owes it;
this protocol does not name one, because it never travels on this wire. The front
reports its own view of the same condition with `ERROR`
`admission_epoch_exhausted` (section 6.5).

WIDENING THE WIRE EPOCH TO U64 IS REJECTED. It buys nothing an operator reaches:
one epoch step per lock, and a lock is a human or policy event, so 2^32 of them
is not a number a session produces. A wider field would trade the frozen `HELLO`
and `LOCK` layouts for headroom past a limit no run arrives at. The bound is
DEFINED rather than widened for the same reason `sequence_exhausted` is: a silent
wrap would reissue an epoch a queued `ADMIT` still names, and a purged order
would execute.

---

## 6. Control frames, front -> main (plane 4)

| id | name | connection | payload bytes | payload |
| --- | --- | --- | --- | --- |
| `0x41` | `HELLO_ACK` | 0 | 10 + strings | section 6.1 |
| `0x42` | `BOUND` | 0 | 1 + 2 + n | `flagsApplied` u8, `pipeName` str |
| `0x43` | `OPEN` | non-zero | 0 | none |
| `0x44` | `WRITE_DONE` | non-zero | 8 | `ackThroughSequence` u64 |
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

THE SUPERVISOR PROCESSES A DECODED BATCH IN ORDER, AND DISCARDS THE TAIL WHEN
`HELLO_ACK` FAILS. One `push` of plane 4 can return `HELLO_ACK` and several
later frames at once, and the codec ADOPTS the announced generation while
decoding - it must, or every frame after `HELLO_ACK` in the same batch would be
`bad_generation`. Adoption is a FRAMING decision and proves nothing semantic.
Main's supervisor therefore walks the returned batch in order and validates
`HELLO_ACK` - `protocolVersion`, `pid` against the spawned child's, the
generation against the ones it has already seen - BEFORE acting on any later
frame in the same batch. On failure it kills the front and DISCARDS every
remaining event of that batch, acted on or not. Without that rule a front could
attach a `BOUND` and an `OPEN` behind a `HELLO_ACK` main is about to reject, and
main would announce a listener for a process it has already decided is not its
child.

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

### 6.4 `WRITE_DONE` is a CUMULATIVE acknowledgement

`ackThroughSequence` is the GREATEST plane 5 sequence for this connection whose
pipe write has RETURNED. It is cumulative, in the shape VS Code's `Protocol`
uses on its own socket (`_incomingAckId`: one number that acknowledges
everything up to itself, and a peer free to send it as often or as rarely as it
likes):

| rule | statement |
| --- | --- |
| when | after each completed chunk, or after several - the front MAY coalesce |
| what it names | the greatest completed plane 5 sequence for that connection, never a per-write identifier |
| monotonic | it never decreases for a connection. A decrease is `ack_regression` (section 12) and is fatal |
| what main does | releases the outstanding window bytes of every chunk through that sequence |
| what the seam sees | the write callback for a logical write runs when, and only when, an acknowledgement covers that write's FINAL sequence |
| `END` | costs no window, so it is never acknowledged |

ONE ACK PER LOGICAL WRITE WAS THE DEFECT, and it is worth naming because the
frame looked correct. If a 4 MiB response can only be acknowledged after its
last chunk, then its 128 chunks are all outstanding at once and the 65536-byte
window of section 11.2 bounds nothing INSIDE a write: one connection could
occupy the whole shared 131072-byte plane 5 buffer and head-of-line block the
other twenty. Cumulative acknowledgement makes the window a real bound at every
instant, including within one logical write, at no cost in frames - the front
may still send exactly one ack per write when a write fits in the window.

The callback rule is unchanged and is what the frame exists for
(`src/vex-agent/mcp/duplex-transport.ts`): "`callback` means THE PEER-SIDE WRITE
COMPLETED ... An implementation that relays through another process (the Windows
pipe-front) may only run it once that process has reported the pipe write
complete; running it on hand-off to the relay would make the outbound queue
believe a frame is delivered while it sits in somebody else's buffer, and the
queue's bound would stop bounding anything real." The front emits an
acknowledgement only after the Go pipe write RETURNS, never when it accepts a
chunk from plane 5, and main runs the callback only on the ack that covers the
write's last sequence.

### 6.5 `ERROR`, and the frozen code set

`code` is a front-authored STRUCTURAL code from a CLOSED set, and `count` is how
many times it has occurred since the last `ERROR` for that code. It is a counter
frame for main's structural log. It carries NO string: peer bytes, provider
payloads and paths never travel in it, and a code plus a count is what a log line
needs (rules 05 and 07). It never carries a connection and never ends one; a
failure that ends a connection is a `PEER_CLOSED`.

| code | name | the front reports it when |
| --- | --- | --- |
| `1` | `malformed_main_frame` | a frame from main did not parse; the front exits (section 10) |
| `2` | `plane_read_failed` | a read on one of the four planes failed |
| `3` | `plane_write_failed` | a write on one of the four planes failed |
| `4` | `listener_bind_failed` | the named pipe could not be created |
| `5` | `sddl_readback_mismatch` | the descriptor read back from the handle is not the one requested (section 6.2's readback, failing) |
| `6` | `credit_violation` | a relay-level credit or window rule was broken (section 11) |
| `7` | `admission_epoch_exhausted` | the u32 admission epoch is spent; main has closed admission PERMANENTLY and the remedy is an APPLICATION restart, never a front restart (section 5.2) |
| `8` | `connection_ids_exhausted` | the connection id space is spent for this generation (section 2.1) |
| `9` | `internal_invariant` | the front detected a broken invariant of its own |

`0` and every value above `9` are UNDEFINED, and main treats an undefined code as
a malformed frame (`error_code`), which by section 10 kills the front. The set
being closed is the point: an open set would make `ERROR` the one frame whose
meaning the front invents, and main's structural log would carry numbers no
reader can resolve. A v2 adds codes the way it adds anything else - on both
sides, in one commit (section 14).

The codes are a LOG vocabulary, never a teardown cause: main maps a connection's
end from `PEER_CLOSED` (section 6.3), and no `ERROR` code changes that.

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
main each enforce on their own side, under the name `data_after_end`
(section 12.3).

### 7.2 Chunking and logical writes

One logical write may span several `DATA` frames of at most `chunkBytes`
(32768). The chunks of one connection's logical write are contiguous on the
plane with respect to that connection; frames for DIFFERENT connections may
interleave between them, which is what makes the plane a multiplex.

`WRITE_DONE` acknowledges THROUGH a sequence (section 6.4). That is why the
frame carries a sequence and not a count: sequences are already the plane's
identity, they are what a cumulative acknowledgement needs to be ordered on, and
a per-connection counter would be a second identity for the same thing.

A logical write's own boundary is MAIN's bookkeeping, not the wire's: main knows
which sequence is the last chunk of the write it started, so it can settle that
write's callback on the first acknowledgement that reaches it. The front does
not need to know where one logical write ends and the next begins, and after
this change it does not track that at all - it acknowledges completed chunks.

---

## 8. Lifecycle

| stage | rule |
| --- | --- |
| start | the front starts LOCKED at `HELLO`'s `initialAdmissionEpoch` (section 5.2). It creates the pipe, verifies the flags, emits `BOUND`, and then ACCEPTS connections, sends `OPEN`, and READS NOTHING from any of them |
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

### 8.1 The 21 raw handles, and the 22nd connection

The front owns the RAW HANDLE COUNT, and it is a count of HANDLES, not of
logical connections main knows about:

| rule | statement |
| --- | --- |
| increment | on `Accept` RETURNING a handle, BEFORE `OPEN` is queued. Not when main answers |
| decrement | only after the handle is PHYSICALLY CLOSED, not when the front decides to close it, not when `PEER_CLOSED` is queued |
| the 21st | is accepted and gets an `OPEN`. Main may answer `REFUSE` with its own `at_capacity` line, which is main's policy, not the front's |
| the 22nd | is accepted and IMMEDIATELY CLOSED: no `OPEN`, no read, no write, not one byte in either direction. It is not queued and it is not remembered |
| the accept loop | STAYS ARMED. The front never stops accepting |

THE COUNTER BRACKETS THE HANDLE, NOT THE CONVERSATION. Counting from `OPEN`
would leave the window between `Accept` and `OPEN` uncounted, and a burst of
connections would push the real handle count past 21 while the front believed
it was at 20. Decrementing when the front DECIDES to close would do the same at
the other end: the handle is still open, the OS still holds it, and the front
would admit a replacement against a slot that does not exist yet. Both errors
are invisible in a test and only appear under the burst that fills the bound.

NEVER STOP ACCEPTING. Leaving the 22nd connection pending in the OS backlog
would block its bridge inside `CreateFile` with no answer and no error, which is
strictly worse than a closed pipe: `vex-mcp` handles a connection that closes -
it is an ordinary "server is busy" - and cannot handle one that never answers,
because there is nothing to report and nothing to retry. An immediate close is a
fast, legible refusal. It carries no refusal LINE because main authors every
line the peer sees (section 9) and main has not been told about this connection
at all; a front-authored line here would be the second author the whole design
exists to prevent.

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
| `error_code` | `ERROR`'s `code` is outside the frozen closed set of section 6.5 |

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
    `peer_closed_reason`, `bound_flags_reserved`, `error_code`

THE ORDER IS PINNED MECHANICALLY, NOT BY PROSE. The fixture carries the order as
data (`validationOrder`, with `validationOrderReasons` mapping each step to the
reasons it can produce) and a MULTI-FAULT PRECEDENCE VECTOR for every adjacent
pair in it: bytes that violate BOTH steps, whose single expected reason is the
EARLIER one. Both suites run those rows and both assert the coverage, so moving
a check turns tests red on both sides in the same commit instead of producing
two codecs that disagree about one operator-visible word.

Two adjacent pairs cannot be violated at once. They are declared in
`validationOrderUnsatisfiablePairs`, and each declaration must say HOW its
earlier step is pinned instead, so the declaration cannot become a way to drop a
step from the order:

| pair | why no frame can violate both | how the earlier step is pinned |
| --- | --- | --- |
| `unknown_type` then `type_not_on_plane` | a byte that is no type at all is on no plane; the second rule needs a DEFINED type | against the next satisfiable step, `bad_generation` |
| `empty_data` then `payload_too_short` | `empty_data` is only reachable for `DATA`, which has no fixed part to be short of | it leads no pair at all - `DATA` has no strings and no enums either - so it is pinned as the LATER half of `connection_rule` then `empty_data`, the boundary between the two phases |

---

## 11. Flow control and bounds

| bound | value | owner |
| --- | --- | --- |
| control payload | 4096 bytes | both |
| data payload / `chunkBytes` | 32768 bytes | both |
| per-connection credit, front -> main | 65536 bytes | main grants, the front spends |
| per-connection UNACKNOWLEDGED bytes, main -> front | 65536 bytes | main |
| fairness, either data plane | one 32768-byte chunk per connection per turn | the sender of that plane |
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
connection past its outstanding credit (`credit_overrun`), and a `CREDIT` that
would exceed the 64 KiB window (`duplicate_credit`), are both framing-level
faults handled by section 10, and both are named in section 12.3. They are not
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

### 11.2 The main -> front window is a HARD per-connection bound

MAIN NEVER HAS MORE THAN 65536 UNACKNOWLEDGED PAYLOAD BYTES OUTSTANDING FOR ONE
CONNECTION, INCLUDING WITHIN ONE LOGICAL WRITE. Outstanding means: written on
plane 5 and not yet covered by a `WRITE_DONE` acknowledgement for that
connection (section 6.4). When the next chunk would cross the window, main stops
writing that connection's chunks and waits for an acknowledgement; every other
connection keeps flowing, because the window is per connection.

A logical write larger than the window is therefore sent in PIECES, paced by the
front's cumulative acknowledgements, and completes when the acknowledgement
covering its final sequence arrives. This is the correction to the earlier rule,
which let one larger write be sent in full before waiting and so let a 4 MiB
response put 4 MiB into a 131072-byte shared plane; section 6.4 states why the
frame changed with it.

65536 is deliberately half the measured 131072-byte OS pipe buffer, so one
connection's outstanding bytes can never fill the shared plane 5 and block a
second connection's chunk behind it. Head-of-line is bounded by the window, not
by the operating system.

FAIRNESS, IDENTICAL TO PLANE 6: at most ONE 32768-byte chunk per connection per
turn, round-robin. The window alone does not give fairness - twenty connections
each inside their own window still queue in whatever order main happened to
iterate - and a plane 5 without round-robin would let one busy connection write
its whole window before a second connection's first chunk. Both directions now
carry the same two mechanisms, a hard per-connection window and round-robin
scheduling, which is what keeps the aggregate of `21 * 65536` a real number in
both directions and is why no plane-level fraction cap is needed on top.

There is NO credit frame in this direction. Main is the only sender on plane 5
and it owns the window itself; a `CREDIT` from the front would be the front
granting main permission to write, which is authority in the wrong process.

### 11.3 The codec is stateless about connections

Both codecs validate the HEADER, the per-plane sequence, and the per-type
payload layout. They do NOT track connections, credit, admission, `END`
ordering, or write windows: those are relay state with a different lifetime, a
different owner and a different test surface. A codec that owned them would be
the relay, and the two later stages would have nothing to implement against.

---

## 12. The per-connection state machines

The codec is stateless about connections (11.3) and the two relays are not. This
section is the ONE machine both of them implement, so 2a (the front) and 2b
(main's relay) are two implementations of a written contract rather than two
guesses that agree until they do not. The state names below are the names each
side uses in its structural log.

### 12.1 The FRONT, per accepted handle

| state | entered by | may do |
| --- | --- | --- |
| `accepted` | `Accept` returns a handle; the raw count rises (8.1) | nothing but queue `OPEN`, or close immediately as the 22nd |
| `open-sent` | `OPEN` written on plane 4 | wait. It READS NOTHING |
| `admitted` | `ADMIT` whose epoch is current | read the peer, spend credit, write main's chunks, acknowledge them |
| `refused` | `REFUSE`, or the handshake deadline expiring | write main's exact bytes once, then close. It never reads |
| `reading` | the first read issued while `admitted` | the steady state: read to the credit bound, stop reading at it, resume on `RESUME` |
| `ended` | peer FIN observed, or `END` from main written | the half-close of 7.1. The other direction still flows |
| `closed` | the handle is PHYSICALLY closed; the raw count falls (8.1) | nothing. `PEER_CLOSED` has been queued with its `throughDataSequence` |

A stale `ADMIT` - one whose epoch is not current - moves NOTHING. It is purged
(`stale_admit_purged`), and the connection stays where it was.

### 12.2 MAIN's relay, per logical connection

| state | entered by | may do |
| --- | --- | --- |
| `opened` | `OPEN` decoded | decide: `ADMIT`, or `REFUSE` with main's own line |
| `admitted` | `ADMIT` written | grant the first `CREDIT` |
| `live` | the first `DATA` decoded, or the first chunk written | relay both directions under the window (11.2) and the credit (11.1) |
| `peer-ended` | `END` decoded on plane 6 | raise the seam's `end`, KEEP the writable side (7.1), keep writing answers |
| `closing` | `CLOSE` written, or `LOCK`/`QUIT` latched | expect `PEER_CLOSED`; hold the close edge until plane 6 is drained through its `throughDataSequence` (6.3) |
| `closed` | `PEER_CLOSED` decoded AND plane 6 drained through its sequence | settle the teardown cause: the latched `lock`/`vex_quit`, else `disconnect` |

STAGE 2b OWES A BOUNDARY TEST FOR THE EPOCH FENCE, and it is normative: no epoch
wrap or reset while main remains alive across a front restart - the restarted
front's `HELLO` carries the same current epoch, a stale `ADMIT` captured before
the restart is purged, and reaching `0xffffffff` closes admission permanently
(section 5.2). No relay exists yet, so the obligation belongs to 2b and not to
this stage; 2b is not accepted without it.

### 12.3 The named structural failures

Every failure listed here is FATAL by section 10 - the front exits, or main
kills the front - EXCEPT `stale_admit_purged`, which is intentionally NOT fatal:
it is the fence working rather than a peer breaking an invariant, and it is
logged instead of acted on. Each has one name that both sides log and neither
side invents:

| name | the invariant it breaks |
| --- | --- |
| `credit_overrun` | a `DATA` frame takes a connection past the credit main granted it |
| `duplicate_credit` | a `CREDIT` would take a connection's window past 65536 outstanding bytes |
| `data_after_end` | a `DATA` or `END` arrives for a connection already `ended` in that direction |
| `stale_admit_purged` | an `ADMIT` names an epoch that is not the front's current one. NOT fatal: it is the fence working, and it is logged |
| `write_window_exceeded` | main wrote a chunk that takes a connection past 65536 unacknowledged bytes |
| `ack_regression` | a `WRITE_DONE` names a sequence lower than one already acknowledged for that connection, or one main never sent |

`stale_admit_purged` is the one entry that is not a failure of the peer, and it
is in the table precisely so it is not implemented as one: purging is the
designed outcome of section 8's fence, and a relay that treated it as fatal
would kill the front every time a lock raced an admit.

---

## 13. Trust

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

## 14. Changing this protocol

The version in `HELLO` is a MAJOR, and it is a FROZEN EQUALITY CHECK (section
5.1), so there is no compatible change: main and the front ship in one package,
built and signed together, and any wire change is a v2 on both sides in the same
commit. `flags`, `reserved` and the unused type ids are where a v2 goes.

Regenerate `pipe-front-vectors.json` deliberately in the same change, and review
it as the wire artifact it is. Both codecs run it; a change that is not in the
fixture is a change neither side proves.
