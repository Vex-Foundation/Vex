//go:build windows

// Command spike-overlapped-stdio answers ONE unmeasured platform question for
// the Vex Studio pipe-front transport (production plan stage B4.2a).
//
// THE QUESTION. Can a Go child, spawned from Electron main on Windows with
// Node's Windows-specific "overlapped" stdio mode, open and USE additional
// inherited stdio pipes beyond stderr - concurrent duplex on one handle,
// deadlines that fire, close that cancels a blocked read, useful throughput
// in small chunks, and a bound on writes the parent is not reading?
//
// WHY IT IS A SPIKE AND NOT AN ARGUMENT. The answer decides the internal
// main-to-front transport shape: dedicated control and data planes on their
// own inherited overlapped pipes if yes, one framed multiplex over stdout with
// strict control-frame priority if no. Every input to that decision except
// this one is already known from documentation; this one is only knowable by
// running it on Windows.
//
// CONTRACT. Exactly one JSON document is written to stdout and nothing else.
// Progress and choreography go to stderr as NDJSON, which is also how the
// parent harness knows which phase to drive. The exit code reports whether the
// MEASUREMENT COMPLETED, never what it measured: 0 when a full report was
// produced (a negative answer is a result), non-zero only when this program
// itself could not measure - no inherited planes, or the hard watchdog fired.
//
// This program is deleted or absorbed into the real transport conformance
// suite when stage B4.3 lands; see the harness README for the removal
// condition.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"
	"sync/atomic"
	"time"
)

// The planes, by CRT descriptor number. The harness must hand over stdio
// slots in exactly this order.
const (
	planeDuplex      = 3 // duplex, deadline and throughput measurements
	planeKeepalive   = 4 // stays live while planeUnread is stalled
	planeUnread      = 5 // the parent never reads this one
	planeCloseCancel = 6 // a blocked read here is cancelled by Close
	planeCount       = 7
)

// Markers are distinctive so a stray byte cannot be mistaken for a reply.
const (
	childDuplexMarker   = "vex-spike-child-duplex-3f91\n"
	parentDuplexMarker  = "vex-spike-parent-duplex-8c02\n"
	parentDrainedMarker = "vex-spike-parent-drained-5d17\n"
)

const (
	// Throughput: enough bytes in small chunks to show a rate, small enough
	// to stay inside a CI job's patience.
	throughputBytes = 4 << 20
	throughputChunk = 32 << 10

	// Backpressure: how much this process is willing to push into a pipe
	// nobody is draining before it declares the write unbounded.
	backpressureChunk = 64 << 10
	backpressureCap   = 16 << 20
	backpressureWait  = 2 * time.Second

	// Keepalive ping cadence on the plane that must survive the stall.
	keepaliveInterval = 50 * time.Millisecond
	keepaliveFrame    = 16

	// Per-phase bounds. Every one of them is a FAILED MEASUREMENT when it
	// fires, recorded as such, never a hang.
	duplexWait     = 5 * time.Second
	deadlineProbe  = 200 * time.Millisecond
	deadlineWait   = 3 * time.Second
	closeAfter     = 300 * time.Millisecond
	closeWait      = 2 * time.Second
	throughputWait = 60 * time.Second

	// How long this process stays alive after the stall so the parent can
	// finish measuring what the operating system buffered behind it. It only
	// has to cover the parent's drain window plus its marker write; it is
	// generous because a slow CI runner must not turn a good measurement into
	// a failed one.
	drainHandshakeWait = 15 * time.Second

	// The last line of defence. If the process is still alive here, the
	// harness itself is broken and must not be reported as a measurement.
	hardDeadline = 180 * time.Second
)

func main() {
	go func() {
		time.Sleep(hardDeadline)
		emit("watchdog", map[string]any{"deadline_ms": hardDeadline.Milliseconds()})
		fmt.Fprintln(os.Stderr, "spike-overlapped-stdio: hard watchdog fired; the measurement did not complete")
		os.Exit(4)
	}()

	rep := report{
		Spike:      "overlapped-stdio",
		Schema:     1,
		GOOS:       runtime.GOOS,
		GOARCH:     runtime.GOARCH,
		GoVersion:  runtime.Version(),
		PID:        os.Getpid(),
		StartedUTC: time.Now().UTC().Format(time.RFC3339Nano),
	}

	planes, ok := discover(&rep)
	if !ok {
		writeReport(rep)
		fmt.Fprintln(os.Stderr, "spike-overlapped-stdio: no inherited planes to measure")
		os.Exit(3)
	}
	defer closeAll(planes)

	measure(&rep, planes)
	rep.MeasurementCompleted = true
	writeReport(rep)
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

// discover recovers the inherited planes and records, per slot, the single
// observable that decides the whole question: did the Go runtime poller take
// the handle. os.File.SetReadDeadline returns os.ErrNoDeadline exactly when
// internal/poll's runtimeCtx is zero, i.e. when the handle was NOT registered
// with the poller, which is what a synchronous (non-FILE_FLAG_OVERLAPPED)
// handle produces. The mechanism is written up against the installed go1.27.0
// sources in bridge/cmd/vex-mcp/dial_windows.go.
func discover(rep *report) (map[int]*os.File, bool) {
	rep.Discovery.NaiveFDProbe = probeNaiveFDNumber()

	slots, reserved, err := inheritedStdioSlots()
	rep.Discovery.CbReserved2 = reserved
	if err != nil {
		rep.Discovery.Error = err.Error()
		return nil, false
	}
	rep.Discovery.CRTSlotCount = len(slots)

	planes := make(map[int]*os.File, planeCount)
	for _, slot := range slots {
		sr := slotReport{FD: slot.fd, CRTFlags: describeFlags(slot.flags)}
		if !slot.usable() {
			sr.Handle = "invalid"
			rep.Discovery.Slots = append(rep.Discovery.Slots, sr)
			continue
		}
		sr.Handle = "0x" + strconv.FormatUint(uint64(slot.handle), 16)
		sr.FileType, sr.FileTypeError = describeFileType(slot.handle)

		// The first three slots are stdin/stdout/stderr, already owned by the
		// os package. Re-wrapping them would give this process two owners for
		// one handle and a double close at exit.
		if slot.fd < planeDuplex {
			sr.Note = "standard stream, owned by the os package; not re-opened"
			rep.Discovery.Slots = append(rep.Discovery.Slots, sr)
			continue
		}

		f := os.NewFile(uintptr(slot.handle), fmt.Sprintf("inherited-plane-%d", slot.fd))
		if f == nil {
			sr.Note = "os.NewFile returned nil for this handle"
			rep.Discovery.Slots = append(rep.Discovery.Slots, sr)
			continue
		}
		sr.Opened = true

		// The pollability probe. A zero deadline clears rather than sets one,
		// so this asks the question without changing behaviour.
		if err := f.SetReadDeadline(time.Time{}); err != nil {
			sr.DeadlineError = err.Error()
			sr.Pollable = false
		} else {
			sr.Pollable = true
		}
		rep.Discovery.Slots = append(rep.Discovery.Slots, sr)
		planes[slot.fd] = f
	}

	emit("discovery_done", map[string]any{
		"crt_slot_count": len(slots),
		"planes_opened":  len(planes),
	})
	return planes, len(planes) > 0
}

// probeNaiveFDNumber records what the unix-shaped assumption actually yields
// on Windows: handle value 3, asked ONLY what kind of object it is. It never
// performs I/O, because a stray write to an unrelated kernel handle is not an
// acceptable price for an observation this cheap.
func probeNaiveFDNumber() naiveProbe {
	p := naiveProbe{
		FD: planeDuplex,
		Explanation: "on Windows os.NewFile takes a HANDLE VALUE, not a CRT descriptor number, " +
			"so the literal 3 does not name the fourth stdio pipe",
	}
	p.FileType, p.Error = describeFileType(3)
	return p
}

func closeAll(planes map[int]*os.File) {
	for _, f := range planes {
		_ = f.Close()
	}
}

// ---------------------------------------------------------------------------
// measurements
// ---------------------------------------------------------------------------

func measure(rep *report, planes map[int]*os.File) {
	duplex := planes[planeDuplex]
	keepalive := planes[planeKeepalive]
	unread := planes[planeUnread]
	cancel := planes[planeCloseCancel]

	duplexOK := false
	if duplex == nil {
		rep.Phases = append(rep.Phases,
			skipped("concurrent_duplex", "plane 3 was not inherited"),
			skipped("read_deadline", "plane 3 was not inherited"),
			skipped("throughput", "plane 3 was not inherited"))
	} else {
		r := runPhase("concurrent_duplex", func() phaseResult { return measureConcurrentDuplex(duplex) })
		duplexOK = r.OK
		rep.Phases = append(rep.Phases, r)

		if !duplexOK {
			// A read may still be pending on this handle, so every further
			// result on it would measure the stuck read rather than the
			// platform.
			rep.Phases = append(rep.Phases,
				skipped("read_deadline", "the duplex phase left plane 3 in an unknown state"),
				skipped("throughput", "the duplex phase left plane 3 in an unknown state"))
		} else {
			rep.Phases = append(rep.Phases,
				runPhase("read_deadline", func() phaseResult { return measureReadDeadline(duplex) }),
				runPhaseExpecting("throughput", map[string]any{
					"bytes_each_direction": throughputBytes,
					"chunk_bytes":          throughputChunk,
				}, func() phaseResult { return measureThroughput(duplex) }))
		}
	}

	if cancel == nil {
		rep.Phases = append(rep.Phases, skipped("close_cancels_blocked_read", "plane 6 was not inherited"))
	} else {
		rep.Phases = append(rep.Phases,
			runPhase("close_cancels_blocked_read", func() phaseResult { return measureCloseCancels(cancel) }))
		// measureCloseCancels closes the plane; drop it so closeAll does not
		// double close.
		delete(planes, planeCloseCancel)
	}

	if unread == nil || keepalive == nil {
		rep.Phases = append(rep.Phases,
			skipped("write_backpressure", "planes 4 and 5 were not both inherited"),
			skipped("drain_handshake", "the stall was never produced, so the parent has nothing to drain"))
	} else {
		rep.Phases = append(rep.Phases,
			runPhase("write_backpressure", func() phaseResult { return measureBackpressure(unread, keepalive) }))

		// The stall measurement is not finished when this process stops
		// writing: the parent still has to drain what the operating system
		// buffered, and that drain is only meaningful while its writer lives.
		handshake := runPhaseExpecting("drain_handshake", map[string]any{
			"wait_ms": drainHandshakeWait.Milliseconds(),
		}, func() phaseResult { return awaitParentDrain(unread) })
		if handshake.Extra["plane_closed_to_cancel_read"] == true {
			delete(planes, planeUnread)
		}
		rep.Phases = append(rep.Phases, handshake)
	}

	rep.Verdict = concludeVerdict(rep)
}

// measureConcurrentDuplex is the phase the whole spike turns on.
//
// A pending blocking read plus a concurrent write ON THE SAME HANDLE is the
// pattern a SYNCHRONOUS Windows handle deadlocks: the I/O manager serializes
// operations, so the write waits behind the read that has nothing to read.
// The choreography copies go-winio's own TestTimeoutPendingRead: start the
// read, sleep long enough to be SURE it is pending, only then issue the
// concurrent operation.
func measureConcurrentDuplex(f *os.File) phaseResult {
	res := phaseResult{Name: "concurrent_duplex", Extra: map[string]any{}}

	reply := make([]byte, len(parentDuplexMarker))
	readDone := make(chan error, 1)
	go func() {
		_, err := io.ReadFull(f, reply)
		readDone <- err
	}()

	time.Sleep(100 * time.Millisecond)

	writeDone := make(chan error, 1)
	go func() {
		_, err := f.Write([]byte(childDuplexMarker))
		writeDone <- err
	}()

	select {
	case err := <-writeDone:
		if err != nil {
			res.Error = "the concurrent write failed: " + err.Error()
			return res
		}
		res.Extra["write_completed_while_read_pending"] = true
	case <-time.After(duplexWait):
		res.Error = fmt.Sprintf(
			"the write did not complete within %s while a read was pending on the same handle "+
				"(the symptom of a synchronous, non-overlapped handle)", duplexWait)
		res.Extra["write_completed_while_read_pending"] = false
		return res
	}

	select {
	case err := <-readDone:
		if err != nil {
			res.Error = "the pending read failed: " + err.Error()
			return res
		}
		if string(reply) != parentDuplexMarker {
			res.Error = "unexpected reply from the parent: " + strconv.Quote(string(reply))
			return res
		}
	case <-time.After(duplexWait):
		res.Error = fmt.Sprintf("the pending read did not complete within %s of the parent reply", duplexWait)
		return res
	}

	res.OK = true
	res.Detail = "a blocking read and a concurrent write on one inherited handle both completed"
	return res
}

// measureReadDeadline proves the deadline is real rather than merely accepted.
// SetReadDeadline returning nil only says the poller took the handle; this
// says the timer actually fires and the read returns os.ErrDeadlineExceeded.
func measureReadDeadline(f *os.File) phaseResult {
	res := phaseResult{Name: "read_deadline", Extra: map[string]any{}}

	if err := f.SetReadDeadline(time.Now().Add(deadlineProbe)); err != nil {
		res.Error = "SetReadDeadline: " + err.Error()
		return res
	}
	done := make(chan error, 1)
	start := time.Now()
	go func() {
		b := make([]byte, 1)
		_, err := f.Read(b)
		done <- err
	}()

	select {
	case err := <-done:
		elapsed := time.Since(start)
		res.Extra["fired_after_ms"] = elapsed.Milliseconds()
		res.Extra["error"] = errString(err)
		if errors.Is(err, os.ErrDeadlineExceeded) {
			res.OK = true
			res.Detail = "the read returned os.ErrDeadlineExceeded"
		} else if err == nil {
			res.Error = "the read returned data instead of timing out; the parent was expected to stay silent"
		} else {
			res.Error = "the read failed with something other than a deadline: " + err.Error()
		}
	case <-time.After(deadlineWait):
		res.Error = fmt.Sprintf("the read deadline did not fire within %s", deadlineWait)
	}

	// Clear it so the throughput phase measures throughput.
	if err := f.SetReadDeadline(time.Time{}); err != nil {
		res.Extra["clear_deadline_error"] = err.Error()
		res.OK = false
		res.Error = "the deadline could not be cleared: " + err.Error()
	}
	return res
}

// measureCloseCancels proves Close on a handle with a blocked read CANCELS it
// rather than leaving the goroutine parked forever. go-winio buys this with an
// explicit CancelIoEx in closeHandle; the question here is whether the Go
// runtime poller gives the same guarantee for an inherited handle.
func measureCloseCancels(f *os.File) phaseResult {
	res := phaseResult{Name: "close_cancels_blocked_read", Extra: map[string]any{}}

	done := make(chan error, 1)
	go func() {
		b := make([]byte, 1)
		_, err := f.Read(b)
		done <- err
	}()

	time.Sleep(closeAfter)
	start := time.Now()
	closeErr := f.Close()
	res.Extra["close_error"] = errString(closeErr)

	select {
	case err := <-done:
		res.Extra["read_returned_after_ms"] = time.Since(start).Milliseconds()
		res.Extra["read_error"] = errString(err)
		if err == nil {
			res.Error = "the blocked read returned success after Close, which is not a cancellation"
			return res
		}
		res.OK = true
		res.Detail = "Close returned the blocked read with " + errString(err)
	case <-time.After(closeWait):
		res.Error = fmt.Sprintf("the blocked read had not returned %s after Close", closeWait)
	}
	return res
}

// measureThroughput pushes a bounded volume in SMALL chunks in both directions
// at once, which is the shape the framed transport would actually produce. The
// number is not a benchmark; it exists so the transport decision is not made
// against an unknown order of magnitude.
func measureThroughput(f *os.File) phaseResult {
	res := phaseResult{Name: "throughput", Extra: map[string]any{
		"bytes_each_direction": throughputBytes,
		"chunk_bytes":          throughputChunk,
	}}

	start := time.Now()

	// PER-DIRECTION accounting, because "neither direction finished" was
	// reported in the 2026-09-01 run while the child-to-parent direction had
	// demonstrably delivered all 4 MiB (the parent counted them). A phase that
	// cannot say WHICH side stalled sends the next reader to the wrong half of
	// the system.
	var readBytes, writeBytes atomic.Int64

	readDone := make(chan error, 1)
	go func() {
		buf := make([]byte, throughputChunk)
		remaining := throughputBytes
		for remaining > 0 {
			want := throughputChunk
			if remaining < want {
				want = remaining
			}
			n, err := io.ReadFull(f, buf[:want])
			remaining -= n
			readBytes.Add(int64(n))
			if err != nil {
				readDone <- err
				return
			}
		}
		readDone <- nil
	}()

	writeDone := make(chan error, 1)
	go func() {
		chunk := make([]byte, throughputChunk)
		for i := range chunk {
			chunk[i] = byte('a' + i%26)
		}
		remaining := throughputBytes
		for remaining > 0 {
			want := throughputChunk
			if remaining < want {
				want = remaining
			}
			n, err := f.Write(chunk[:want])
			remaining -= n
			writeBytes.Add(int64(n))
			if err != nil {
				writeDone <- err
				return
			}
		}
		writeDone <- nil
	}()

	var readErr, writeErr error
	readSettled, writeSettled := false, false
	timedOut := false
	timeout := time.After(throughputWait)
	for !timedOut && (!readSettled || !writeSettled) {
		select {
		case readErr = <-readDone:
			readSettled = true
		case writeErr = <-writeDone:
			writeSettled = true
		case <-timeout:
			timedOut = true
		}
	}

	elapsed := time.Since(start)
	res.Extra["elapsed_ms"] = elapsed.Milliseconds()
	res.Extra["read_bytes"] = readBytes.Load()
	res.Extra["write_bytes"] = writeBytes.Load()
	res.Extra["read_status"] = directionStatus(readSettled, readErr)
	res.Extra["write_status"] = directionStatus(writeSettled, writeErr)

	if timedOut {
		res.Error = fmt.Sprintf(
			"the throughput phase did not finish %d bytes each way within %s: "+
				"the read direction %s after %d bytes, the write direction %s after %d bytes",
			throughputBytes, throughputWait,
			directionStatus(readSettled, readErr), readBytes.Load(),
			directionStatus(writeSettled, writeErr), writeBytes.Load())
		return res
	}

	if elapsed > 0 {
		res.Extra["mib_per_second_each_direction"] = float64(throughputBytes) / (1 << 20) / elapsed.Seconds()
	}
	if readErr != nil {
		res.Error = "read direction: " + readErr.Error()
		return res
	}
	if writeErr != nil {
		res.Error = "write direction: " + writeErr.Error()
		return res
	}
	res.OK = true
	res.Detail = fmt.Sprintf("%d bytes each way in %d byte chunks", throughputBytes, throughputChunk)
	return res
}

// directionStatus names what one half of the throughput exchange did, so the
// artifact reports which side stalled rather than a claim about both.
func directionStatus(settled bool, err error) string {
	switch {
	case !settled:
		return "stalled"
	case err != nil:
		return "failed: " + err.Error()
	default:
		return "completed"
	}
}

// measureBackpressure answers the head-of-line question the credit design
// needs: when the parent stops reading ONE plane, does the write to it block
// at a bound and does a DIFFERENT plane keep flowing while it is stalled.
func measureBackpressure(unread, keepalive *os.File) phaseResult {
	res := phaseResult{Name: "write_backpressure", Extra: map[string]any{
		"chunk_bytes": backpressureChunk,
		"cap_bytes":   backpressureCap,
	}}

	stop := make(chan struct{})
	pings := make(chan pingStats, 1)
	go runKeepalive(keepalive, stop, pings)

	chunk := make([]byte, backpressureChunk)
	for i := range chunk {
		chunk[i] = byte('A' + i%26)
	}

	accepted := 0
	start := time.Now()
	var stallErr error
	for accepted < backpressureCap {
		if err := unread.SetWriteDeadline(time.Now().Add(backpressureWait)); err != nil {
			stallErr = fmt.Errorf("SetWriteDeadline: %w", err)
			break
		}
		n, err := unread.Write(chunk)
		accepted += n
		if err != nil {
			stallErr = err
			break
		}
	}
	stalledAfter := time.Since(start)
	close(stop)
	stats := <-pings

	res.Extra["bytes_accepted_before_stall"] = accepted
	res.Extra["stalled_after_ms"] = stalledAfter.Milliseconds()
	res.Extra["stall_error"] = errString(stallErr)
	res.Extra["keepalive_pings_sent"] = stats.sent
	res.Extra["keepalive_echoes_received"] = stats.received
	res.Extra["keepalive_max_gap_ms"] = stats.maxGap.Milliseconds()
	res.Extra["keepalive_error"] = stats.err

	switch {
	case stallErr == nil:
		res.Error = fmt.Sprintf(
			"the unread plane accepted the full %d byte cap without blocking; this run found no bound", backpressureCap)
	case errors.Is(stallErr, os.ErrDeadlineExceeded):
		res.OK = stats.received > 0
		res.Detail = fmt.Sprintf("the unread plane blocked after %d bytes", accepted)
		if stats.received == 0 {
			res.Error = "the other plane exchanged nothing while the unread plane was stalled (head-of-line blocking across planes)"
		}
	default:
		res.Error = "the unread plane failed rather than blocking: " + stallErr.Error()
	}
	return res
}

// awaitParentDrain is the EXIT INTERLOCK for measurement 7. It measures
// nothing about the platform; it stops this process from destroying the
// parent's measurement by exiting underneath it.
//
// After the stall the operating system is still holding whatever it buffered
// behind a parent that refused to read plane 5, and the size of that buffer is
// the number the credit window has to respect. The parent obtains it by
// draining the plane, which is only truthful while the WRITER is still alive:
// if this process exits first, the parent measures whatever survived the
// teardown and reports it as a platform bound. So the parent writes one marker
// on plane 5 when its drain is complete, and this process does not proceed to
// its report until that marker arrives.
//
// The wait is bounded twice, the way go-winio bounds a pending read in
// win32File.asyncIO: a deadline when the runtime poller took the handle, and a
// Close that cancels the read when it did not. A dead or broken parent can
// delay this process by drainHandshakeWait; it can never park it.
func awaitParentDrain(f *os.File) phaseResult {
	res := phaseResult{Name: "drain_handshake", Extra: map[string]any{
		"wait_ms": drainHandshakeWait.Milliseconds(),
	}}

	// Best effort: on a handle the poller refused there is no deadline, and
	// the select below plus Close is what bounds the read instead.
	if err := f.SetReadDeadline(time.Now().Add(drainHandshakeWait)); err != nil {
		res.Extra["set_deadline_error"] = err.Error()
	}

	buf := make([]byte, len(parentDrainedMarker))
	done := make(chan error, 1)
	go func() {
		_, err := io.ReadFull(f, buf)
		done <- err
	}()

	start := time.Now()
	select {
	case err := <-done:
		res.Extra["waited_ms"] = time.Since(start).Milliseconds()
		if err != nil {
			res.Error = "the parent's drain marker did not arrive: " + err.Error()
			return res
		}
		if string(buf) != parentDrainedMarker {
			res.Error = "unexpected marker from the parent: " + strconv.Quote(string(buf))
			return res
		}
		res.OK = true
		res.Detail = "the parent finished draining plane 5 before this process exited"
	case <-time.After(drainHandshakeWait + time.Second):
		// The deadline was refused or did not fire. Close is the cancellation
		// of last resort, so the read goroutine is not left holding a handle
		// nobody owns; the caller drops this plane from the close set.
		res.Extra["plane_closed_to_cancel_read"] = true
		_ = f.Close()
		res.Extra["waited_ms"] = time.Since(start).Milliseconds()
		res.Error = fmt.Sprintf(
			"no drain marker within %s; the parent's bytes_drained_after_stall was measured against a "+
				"process that may already have been exiting and is not trustworthy", drainHandshakeWait+time.Second)
	}
	return res
}

type pingStats struct {
	sent     int
	received int
	maxGap   time.Duration
	err      string
}

// keepaliveEcho is what the reader goroutine owns and hands over exactly once,
// so no counter is shared between goroutines.
type keepaliveEcho struct {
	received int
	maxGap   time.Duration
	err      error
}

// runKeepalive exchanges fixed-size frames on its own plane for as long as the
// stall lasts, so the report can say whether a second plane kept flowing.
//
// The reader is stopped the way go-winio's pending-read tests stop one: a
// deadline set from another goroutine, which is the only way to end a blocked
// read without closing the handle the caller still owns.
func runKeepalive(f *os.File, stop <-chan struct{}, out chan<- pingStats) {
	echo := make(chan keepaliveEcho, 1)
	go func() {
		buf := make([]byte, keepaliveFrame)
		var e keepaliveEcho
		last := time.Now()
		for {
			if _, err := io.ReadFull(f, buf); err != nil {
				e.err = err
				echo <- e
				return
			}
			e.received++
			if gap := time.Since(last); gap > e.maxGap {
				e.maxGap = gap
			}
			last = time.Now()
		}
	}()

	collect := func(sent int, writeErr string) pingStats {
		stats := pingStats{sent: sent, err: writeErr}
		_ = f.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		select {
		case e := <-echo:
			stats.received = e.received
			stats.maxGap = e.maxGap
			if e.err != nil && !errors.Is(e.err, os.ErrDeadlineExceeded) && stats.err == "" {
				stats.err = e.err.Error()
			}
		case <-time.After(2 * time.Second):
			if stats.err == "" {
				stats.err = "the keepalive reader did not return after its deadline"
			}
		}
		return stats
	}

	frame := make([]byte, keepaliveFrame)
	copy(frame, "vex-spike-ping--")
	ticker := time.NewTicker(keepaliveInterval)
	defer ticker.Stop()
	sent := 0
	for {
		select {
		case <-stop:
			out <- collect(sent, "")
			return
		case <-ticker.C:
			if err := f.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
				out <- collect(sent, "SetWriteDeadline: "+err.Error())
				return
			}
			if _, err := f.Write(frame); err != nil {
				out <- collect(sent, "keepalive write: "+err.Error())
				return
			}
			sent++
		}
	}
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

type slotReport struct {
	FD            int    `json:"fd"`
	CRTFlags      string `json:"crt_flags"`
	Handle        string `json:"handle"`
	FileType      string `json:"file_type,omitempty"`
	FileTypeError string `json:"file_type_error,omitempty"`
	Opened        bool   `json:"opened"`
	Pollable      bool   `json:"pollable"`
	DeadlineError string `json:"set_deadline_error,omitempty"`
	Note          string `json:"note,omitempty"`
}

type naiveProbe struct {
	FD          int    `json:"fd"`
	FileType    string `json:"file_type,omitempty"`
	Error       string `json:"error,omitempty"`
	Explanation string `json:"explanation"`
}

type discoveryReport struct {
	CbReserved2  int          `json:"cb_reserved2"`
	CRTSlotCount int          `json:"crt_slot_count"`
	Error        string       `json:"error,omitempty"`
	NaiveFDProbe naiveProbe   `json:"naive_fd_number_as_handle"`
	Slots        []slotReport `json:"slots,omitempty"`
}

type phaseResult struct {
	Name      string         `json:"name"`
	OK        bool           `json:"ok"`
	Skipped   bool           `json:"skipped,omitempty"`
	Detail    string         `json:"detail,omitempty"`
	Error     string         `json:"error,omitempty"`
	ElapsedMs int64          `json:"elapsed_ms"`
	Extra     map[string]any `json:"extra,omitempty"`
}

type verdict struct {
	ExtraPlanesInherited bool     `json:"extra_planes_inherited"`
	PollerTookHandles    bool     `json:"runtime_poller_took_every_plane"`
	ConcurrentDuplex     bool     `json:"concurrent_duplex_on_one_handle"`
	ReadDeadlineFires    bool     `json:"read_deadline_fires"`
	CloseCancelsRead     bool     `json:"close_cancels_blocked_read"`
	ThroughputMeasured   bool     `json:"throughput_measured"`
	BoundedWrite         bool     `json:"unread_plane_write_is_bounded"`
	DedicatedPlanesUsabe bool     `json:"dedicated_overlapped_planes_usable"`
	Notes                []string `json:"notes,omitempty"`
}

type report struct {
	Spike                string          `json:"spike"`
	Schema               int             `json:"schema"`
	MeasurementCompleted bool            `json:"measurement_completed"`
	GOOS                 string          `json:"goos"`
	GOARCH               string          `json:"goarch"`
	GoVersion            string          `json:"go_version"`
	PID                  int             `json:"pid"`
	StartedUTC           string          `json:"started_utc"`
	Discovery            discoveryReport `json:"discovery"`
	Phases               []phaseResult   `json:"phases,omitempty"`
	Verdict              verdict         `json:"verdict"`
}

func runPhase(name string, fn func() phaseResult) phaseResult {
	return runPhaseExpecting(name, nil, fn)
}

// runPhaseExpecting is the ONE owner of a phase's event order. A phase whose
// parent half needs a parameter (the throughput size, the drain wait) announces
// it in `phase_expects` BEFORE `phase_begin`, so a reader that consumes the
// events in order never sees a start it cannot yet act on. The announcement
// used to be emitted from inside the phase body, which put it AFTER the start
// and cost the 2026-09-01 Windows run its parent-to-child throughput direction.
// The parent is order-independent anyway (see choreography.mjs); this makes the
// instrument's own stream honest rather than relying on that.
func runPhaseExpecting(name string, expects map[string]any, fn func() phaseResult) phaseResult {
	if expects != nil {
		fields := map[string]any{"phase": name}
		for k, v := range expects {
			fields[k] = v
		}
		emit("phase_expects", fields)
	}
	emit("phase_begin", map[string]any{"phase": name})
	start := time.Now()
	res := fn()
	res.Name = name
	res.ElapsedMs = time.Since(start).Milliseconds()
	emit("phase_end", map[string]any{"phase": name, "ok": res.OK, "error": res.Error})
	return res
}

func skipped(name, why string) phaseResult {
	emit("phase_skipped", map[string]any{"phase": name, "reason": why})
	return phaseResult{Name: name, Skipped: true, Detail: why}
}

func concludeVerdict(rep *report) verdict {
	v := verdict{}
	planes := 0
	pollable := 0
	for _, s := range rep.Discovery.Slots {
		if s.Opened {
			planes++
			if s.Pollable {
				pollable++
			}
		}
	}
	v.ExtraPlanesInherited = planes > 0
	v.PollerTookHandles = planes > 0 && pollable == planes
	if planes > 0 && pollable != planes {
		v.Notes = append(v.Notes, fmt.Sprintf(
			"%d of %d inherited planes were taken by the runtime poller; the rest are synchronous handles",
			pollable, planes))
	}

	for _, p := range rep.Phases {
		switch p.Name {
		case "concurrent_duplex":
			v.ConcurrentDuplex = p.OK
		case "read_deadline":
			v.ReadDeadlineFires = p.OK
		case "close_cancels_blocked_read":
			v.CloseCancelsRead = p.OK
		case "throughput":
			v.ThroughputMeasured = p.OK
		case "write_backpressure":
			v.BoundedWrite = p.OK
		}
		if p.Skipped {
			v.Notes = append(v.Notes, p.Name+" was skipped: "+p.Detail)
		} else if !p.OK && p.Error != "" {
			v.Notes = append(v.Notes, p.Name+" failed: "+p.Error)
		}
	}

	v.DedicatedPlanesUsabe = v.ExtraPlanesInherited && v.PollerTookHandles &&
		v.ConcurrentDuplex && v.ReadDeadlineFires && v.CloseCancelsRead &&
		v.ThroughputMeasured && v.BoundedWrite
	return v
}

// writeReport puts exactly one JSON document on stdout. Nothing else in this
// program writes there.
func writeReport(rep report) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(rep); err != nil {
		fmt.Fprintln(os.Stderr, "spike-overlapped-stdio: could not write the report:", err)
		os.Exit(5)
	}
}

// emit writes one NDJSON progress line to stderr. The parent harness reads
// these to know which phase to drive; a real transport would never use stderr
// for control, and the harness README says so.
func emit(event string, fields map[string]any) {
	line := map[string]any{"event": event, "t": time.Now().UTC().Format(time.RFC3339Nano)}
	for k, val := range fields {
		line[k] = val
	}
	b, err := json.Marshal(line)
	if err != nil {
		return
	}
	fmt.Fprintln(os.Stderr, string(b))
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
