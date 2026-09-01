# Spike: inherited overlapped stdio planes (stage B4.2a)

One measurement, one decision, one removal condition.

## The question

Batch 4 adds a Go "pipe-front" process that owns the Windows named-pipe
mechanics for the Studio MCP host. Electron main spawns it and relays all
traffic over the front's inherited stdio. The internal main-to-front transport
has two candidate shapes, and the choice hangs on ONE fact nobody has measured:

> Can a Go child, spawned from Electron main on Windows with Node's
> Windows-specific `'overlapped'` stdio mode, open and USE additional inherited
> stdio pipes (slot 3 and up) as real duplex planes?

If YES, the internal planes are main-to-front control and front-to-main control
on dedicated inherited overlapped pipes, plus framed multiplexed data pipes in
each direction, with stderr carrying structural logs only.

If NO, the fallback is ONE framed multiplex over stdio with small bounded
chunks and strict control-frame priority.

Passing accepted pipe handles into Node is rejected either way (it needs a
native addon), so this spike does not measure it.

**This spike does not choose the shape.** It produces evidence; the transport
contract (plan section 6c) is written from it.

## What is measured

The Go child (`bridge/cmd/spike-overlapped-stdio/`) is the instrument; this
harness is the parent that drives it and records what it saw from its own side.

| # | measurement | why the decision needs it |
| --- | --- | --- |
| 1 | Do the extra stdio slots arrive at all, and with what CRT flags, handle values and `GetFileType`? | Without this there are no planes and the question is answered NO immediately. |
| 2 | Did the Go runtime poller take each handle (`SetReadDeadline` succeeds vs returns `os.ErrNoDeadline`)? | A handle the poller refused is synchronous: no deadlines, no concurrent duplex. |
| 3 | Concurrent duplex on ONE handle: a pending blocking read plus a concurrent write from another goroutine, both completing. | This is exactly the pattern a synchronous Windows handle deadlocks on. It is the load-bearing measurement. |
| 4 | Does a read deadline actually FIRE (`os.ErrDeadlineExceeded`), and can it then be cleared? | A control plane without a working deadline degrades to a close-the-handle watchdog. |
| 5 | Does `Close` during a blocked read CANCEL it, inside a watchdog? | Shutdown must not park a goroutine on a read forever. |
| 6 | Bounded throughput in small chunks, both directions at once, byte-verified and timed. | The framing design must not be built against an unknown order of magnitude. |
| 7 | A NON-READING parent on one plane while another plane stays live: where does the write block, and does the other plane keep flowing? | This is the head-of-line and credit-window input. It also measures how much the operating system buffered behind the stalled reader. |

Measurement 7 spans both halves, so it carries an EXIT INTERLOCK rather than a
race. The buffered byte count is only truthful while the WRITER is alive: if
the child exits first, the parent counts whatever survived the teardown and
reports it as a platform bound. So the child parks on a bounded read of plane 5
after the stall (`drain_handshake`), the harness drains for `DRAIN_MS` and then
writes ONE marker back on plane 5, and only then does the child proceed to its
report. Neither side can hang on the other: the child bounds the wait at 15s and
falls back to closing the plane, recording the phase as failed with the reason
that the parent's `bytes_drained_after_stall` is not trustworthy; the harness
bounds its marker write at 5s and records `drain_marker_error`.

Measurement 2 rests on a mechanism verified against the installed go1.27.0
sources and written up in `bridge/cmd/vex-mcp/dial_windows.go`:
`internal/poll.setDeadlineImpl` returns `ErrNoDeadline` exactly when the handle
was not registered with the runtime poller, which is what a handle without
`FILE_FLAG_OVERLAPPED` produces.

## How it is wired

```
slot 0  pipe         stdin, unused
slot 1  pipe         the child's ONE JSON report
slot 2  pipe         the child's NDJSON progress
slot 3  overlapped   plane A: duplex, read deadline, throughput
slot 4  overlapped   plane B: must keep flowing while plane C is stalled
slot 5  overlapped   plane C: the harness deliberately NEVER reads it during
                     the stall, then drains it and writes the release marker
slot 6  overlapped   plane D: the child closes it under a blocked read
```

The harness reads the child's stderr NDJSON to know which phase to drive. That
is a HARNESS convenience and not a proposal: a real transport would never put
control on a log stream.

The child's ONE JSON report is read from slot 1 only after that stream has
ENDED. Node's `exit` event says the process died, not that its stdout was
delivered, so a report parsed at `exit` can be a prefix of the document the
child wrote. The bound on that wait is armed when the child exits, not when it
is spawned; if it expires, the artifact says so in `child_report_error` and in
`parent_observations.report_collection`.

It runs under Electron, not plain `node`, because production spawns the front
from Electron main and the libuv that creates these pipes must be the shipped
one. Same reason `scripts/probe-node-pty.mjs` runs under Electron.

## Running it on Windows

The measurement only happens on Windows. Everywhere else the Go binary prints
one sentence and exits 2, and the harness records `unsupported-platform`.

```powershell
# from the repository root, with Go 1.27.0 on PATH
cd bridge
$env:GOTOOLCHAIN = "local"
go build -o dist\windows-amd64\spike-overlapped-stdio.exe .\cmd\spike-overlapped-stdio

cd ..\vex-app
pnpm exec electron scripts\spikes\overlapped-stdio\run-spike.mjs `
  --json scripts\spikes\overlapped-stdio\artifacts\overlapped-stdio-windows.json `
  --require-measurement
```

Flags:

| flag | default | meaning |
| --- | --- | --- |
| `--child PATH` | `bridge/dist/<goos>-<goarch>/spike-overlapped-stdio[.exe]` | the built instrument. |
| `--json PATH` | none, the document goes to stdout | where to write the evidence artifact. Directories are created. |
| `--require-measurement` | off | fail the run unless the child completed its measurement. CI passes this; a local exploratory run need not. |

## Reading the result

The artifact's `outcome` is one of:

- `measured` - the child ran and reported. **Read `child_report.verdict`**, whose
  `dedicated_overlapped_planes_usable` is the answer to the question above. A
  `false` there is a valid, decision-grade result, not a failure.
- `unsupported-platform` - not Windows. Nothing was measured.
- `child-failed` / `timeout` - the instrument broke. Nothing was measured and
  nothing may be concluded.

`parent_observations` carries what this harness saw independently of the
child's own claims: which stdio slots Node actually produced, whether the
duplex reply was written, the parent-side throughput counters with `write()`
backpressure and drain waits, how many keepalive frames it echoed during the
stall, how many bytes the operating system had buffered behind the plane it
refused to read, whether the release marker for the child's exit interlock was
delivered, and whether the report was collected from a CLOSED stdout.

Retention is bounded and the overflow is counted, never silently dropped:
`child_stdout_dropped_bytes` and `child_stderr_dropped_lines` are zero in every
healthy run, and non-zero means the instrument produced more than a report.

Provenance (OS build, Electron, Node-inside-Electron, Chrome, Go version,
commit, UTC timestamp) is in `environment` and `go_version`.

## Exit contract

Both halves use the same rule: the exit code reports whether the MEASUREMENT
COMPLETED, never what it measured.

- harness `0` - a complete evidence artifact was produced, including one
  recording a negative answer or an unsupported platform;
- harness non-zero - it could not measure: no binary, spawn failure, the
  artifact could not be written, the watchdog fired, or `--require-measurement`
  was passed and the child did not complete;
- child `0` - report written; `2` - wrong platform; `3` - no inherited planes;
  `4` - hard watchdog; `5` - the report could not be written.

The CI job `studio-overlapped-spike` therefore goes red only when the
instrument breaks. It is evidence collection, not a gate, and it deliberately
carries no `continue-on-error`: a broken instrument must be visible.

## Removal condition

**This spike is CONSUMED by the B4.2b transport decision.** Once the
main-to-front transport contract is written from its evidence and the real
transport conformance suite lands at stage B4.3, this directory and
`bridge/cmd/spike-overlapped-stdio/` are DELETED, and the CI job with them.
Any measurement still worth keeping moves into that conformance suite, where it
guards the shipped transport instead of a decision already made. The committed
artifacts are the record; git history is the archive for the instrument.

A reviewer who sees stage B4.3 land while this directory still exists rejects
it.
