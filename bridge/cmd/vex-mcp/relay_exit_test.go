package main

import (
	"os"
	"strings"
	"testing"

	"github.com/Vex-Foundation/vex/bridge/internal/relay"
)

// captureStderr runs f with os.Stderr replaced by a pipe and returns what was
// written. `warn` writes to os.Stderr directly, which is the contract's own
// requirement (3.5: the drain bound "is REPORTED on stderr rather than
// presented as a clean close"), so the only honest way to test the mapping is
// to read the bytes that actually go there.
func captureStderr(t *testing.T, f func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	saved := os.Stderr
	os.Stderr = w
	defer func() { os.Stderr = saved }()

	done := make(chan string, 1)
	go func() {
		var b strings.Builder
		buf := make([]byte, 4096)
		for {
			n, readErr := r.Read(buf)
			b.Write(buf[:n])
			if readErr != nil {
				break
			}
		}
		done <- b.String()
	}()

	f()
	_ = w.Close()
	out := <-done
	_ = r.Close()
	return out
}

// THE WINDOWS ARM OF CONTRACT 3.5, PROVED ON LINUX.
//
// A pipe has no FIN, so on stdin EOF the bridge cannot tell the host anything:
// the drain runs to its 5000 ms bound and the connection is then closed fully.
// That is a CLEAN EXIT 0 - collapsing it into exit 11 is what a client would
// see as "the relay failed" for a session that finished - AND it is REPORTED,
// because the contract's bounds table says the drain bound "is REPORTED on
// stderr rather than presented as a clean close".
//
// `HalfClosed` is the only thing that separates the two sentences, so both are
// pinned here. Nothing in this table needs a named pipe, which is the point:
// the conformance arm on the Windows lane then has to prove only the TRANSPORT.
func TestRelayExitMapsTheDrainBoundToACleanExitWithAnHonestLine(t *testing.T) {
	for _, row := range []struct {
		name     string
		result   relay.Result
		wantCode int
		wantLine string
	}{
		{
			name:     "a pipe: no half-close, the bound is the only thing that ends it",
			result:   relay.Result{Outcome: relay.OutcomeDrainDeadline, HalfClosed: false},
			wantCode: exitOK,
			wantLine: "a named pipe has no half-close",
		},
		{
			name:     "a unix socket: half-closed, and the host still held its side",
			result:   relay.Result{Outcome: relay.OutcomeDrainDeadline, HalfClosed: true},
			wantCode: exitOK,
			wantLine: "had not closed its side",
		},
		{
			name:     "a unix socket: the drain finished, so there is nothing to report",
			result:   relay.Result{Outcome: relay.OutcomeClientEOF, HalfClosed: true},
			wantCode: exitOK,
			wantLine: "",
		},
		{
			name:     "the host closed first, which is equally clean and equally silent",
			result:   relay.Result{Outcome: relay.OutcomePeerEOF},
			wantCode: exitOK,
			wantLine: "",
		},
	} {
		t.Run(row.name, func(t *testing.T) {
			var code int
			stderr := captureStderr(t, func() { code = relayExit(row.result) })
			if code != row.wantCode {
				t.Fatalf("exit %d, want %d", code, row.wantCode)
			}
			if row.wantLine == "" {
				if stderr != "" {
					t.Fatalf("a clean drain must say nothing, got %q", stderr)
				}
				return
			}
			if !strings.Contains(stderr, row.wantLine) {
				t.Fatalf("stderr %q does not name %q", stderr, row.wantLine)
			}
			// ONE LINE. The contract's stderr rule is one owned line per exit,
			// and a client parsing the bridge's stderr sees exactly that.
			if got := len(strings.Split(strings.TrimRight(stderr, "\n"), "\n")); got != 1 {
				t.Fatalf("the bridge wrote %d stderr lines: %q", got, stderr)
			}
			if !strings.HasPrefix(stderr, "vex-mcp: ") {
				t.Fatalf("the owned line must carry the bridge's prefix, got %q", stderr)
			}
		})
	}
}
