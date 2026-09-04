package lifecycle

import "io"

// ParentSignal is why the parent watch fired.
type ParentSignal uint8

const (
	// ParentEOF is the ordinary case: main exited or closed slot 0, so the read
	// returned io.EOF (protocol section 8, "stdin EOF ... exits the front").
	ParentEOF ParentSignal = 1
	// ParentReadFailed is any other read failure on slot 0. It is treated
	// exactly like EOF: a stdin the front can no longer observe is a parent it
	// can no longer observe, and admission never survives an ambiguity.
	ParentReadFailed ParentSignal = 2
	// ParentWroteBytes is slot 0 carrying data. Protocol section 1 says main
	// NEVER writes it after spawn, so a byte here means the process on the
	// other end is not the main this front was built for. Fail closed.
	ParentWroteBytes ParentSignal = 3
)

// WatchParent owns ONE goroutine that blocks on slot 0 - stdin - and reports
// the first thing that happens on it.
//
// WHY STDIN AND NOT A PID. A parent pid can be recycled by the operating system
// after main exits, and a watch on a recycled pid watches a stranger. The
// inherited stdin pipe cannot be recycled: its read end is this process and its
// write end is main's handle, so the read completes with EOF at exactly the
// moment the last writer handle closes. That is also the one signal this
// package can test on every platform, which is why the Windows build has no
// separate implementation.
//
// The returned channel carries exactly one value and is then closed. The
// goroutine's only owner is process exit: it is parked in a read that nothing
// but the parent's death completes, and there is no teardown that could join it
// (endpoint contract 3.5: "A goroutine left blocked on a read or write that no
// longer matters is abandoned deliberately").
func WatchParent(stdin io.Reader) <-chan ParentSignal {
	signal := make(chan ParentSignal, 1)
	go func() {
		defer close(signal)
		var one [1]byte
		n, err := stdin.Read(one[:])
		switch {
		case n > 0:
			signal <- ParentWroteBytes
		case err == io.EOF:
			signal <- ParentEOF
		default:
			signal <- ParentReadFailed
		}
	}()
	return signal
}
