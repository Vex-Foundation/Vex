package listener

import (
	"errors"
	"net"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// A unix socket stands in for the named pipe. The accept loop and the raw
// handle count are the same code on every platform, and this is the bound whose
// two failure modes - counting from OPEN, and releasing before the physical
// close - are invisible in a test that does not fill it.
func testListener(t *testing.T) (net.Listener, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "front.sock")
	l, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listening: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l, path
}

// recordingSink is a Sink that keeps the handles it is given, so the test can
// hold exactly as many as the bound allows and then ask for one more.
type recordingSink struct {
	mu        sync.Mutex
	accepted  []net.Conn
	overflows []int
	failures  int
	serving   bool
	changed   chan struct{}
}

func newSink() *recordingSink {
	return &recordingSink{serving: true, changed: make(chan struct{}, 64)}
}

func (s *recordingSink) Accepted(conn net.Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.serving {
		return false
	}
	s.accepted = append(s.accepted, conn)
	s.notify()
	return true
}

func (s *recordingSink) Overflow(count int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.overflows = append(s.overflows, count)
	s.notify()
}

func (s *recordingSink) AcceptFailed(error) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failures++
	s.notify()
	return true
}

func (s *recordingSink) notify() {
	select {
	case s.changed <- struct{}{}:
	default:
	}
}

func (s *recordingSink) counts() (accepted, overflows int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.accepted), len(s.overflows)
}

// waitFor polls the sink's counters against a predicate under a bounded
// deadline. It is not a sleep: the loop makes progress only when the accept
// goroutine does, and it fails loudly when it does not.
func (s *recordingSink) waitFor(t *testing.T, want func(accepted, overflows int) bool) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		if accepted, overflows := s.counts(); want(accepted, overflows) {
			return
		}
		select {
		case <-s.changed:
		case <-deadline:
			accepted, overflows := s.counts()
			t.Fatalf("timed out with accepted=%d overflows=%d", accepted, overflows)
		}
	}
}

// THE 21ST IS SERVED AND THE 22ND IS CLOSED IMMEDIATELY: no OPEN, no read, no
// write, not one byte in either direction, never queued and never remembered.
// THE ACCEPT LOOP STAYS ARMED throughout.
func TestTwentySecondConnectionIsClosedSilentlyAndTheLoopStaysArmed(t *testing.T) {
	l, path := testListener(t)
	sink := newSink()
	var raw RawHandles
	go Serve(l, &raw, sink)

	peers := make([]net.Conn, 0, MaxRawHandles)
	for i := range MaxRawHandles {
		conn, err := net.Dial("unix", path)
		if err != nil {
			t.Fatalf("dialling connection %d: %v", i+1, err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		peers = append(peers, conn)
	}
	sink.waitFor(t, func(accepted, _ int) bool { return accepted == MaxRawHandles })
	if raw.Live() != MaxRawHandles {
		t.Fatalf("the raw count brackets every accepted handle, got %d", raw.Live())
	}

	overflow, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("the 22nd must still be ACCEPTED, not left pending: %v", err)
	}
	t.Cleanup(func() { _ = overflow.Close() })
	sink.waitFor(t, func(_, overflows int) bool { return overflows == 1 })

	if accepted, _ := sink.counts(); accepted != MaxRawHandles {
		t.Fatalf("the 22nd must never be registered, got %d registered handles", accepted)
	}
	// It got not one byte: the read below sees the close and nothing else.
	_ = overflow.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 16)
	n, err := overflow.Read(buf)
	if n != 0 {
		t.Fatalf("the 22nd received %d bytes; it must receive none", n)
	}
	if err == nil {
		t.Fatal("the 22nd must be closed, not left open")
	}
	if errors.Is(err, net.ErrClosed) {
		t.Fatal("the LOCAL end was closed; the front must close the REMOTE one")
	}

	// The loop is still armed: a handle released by a physical close makes room
	// for the next connection, and it is served rather than refused.
	if err := peers[0].Close(); err != nil {
		t.Fatalf("closing a peer: %v", err)
	}
	raw.Release()
	replacement, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("the accept loop must never disarm: %v", err)
	}
	t.Cleanup(func() { _ = replacement.Close() })
	sink.waitFor(t, func(accepted, _ int) bool { return accepted == MaxRawHandles+1 })
	if _, overflows := sink.counts(); overflows != 1 {
		t.Fatalf("the replacement must not be refused, overflows=%d", overflows)
	}
}

func TestRawHandlesBracketTheHandleAndNotTheConversation(t *testing.T) {
	var raw RawHandles
	for i := 1; i <= MaxRawHandles; i++ {
		count, admitted := raw.Acquire()
		if count != i || !admitted {
			t.Fatalf("handle %d: count=%d admitted=%v", i, count, admitted)
		}
	}
	count, admitted := raw.Acquire()
	if admitted {
		t.Fatalf("handle %d is past the bound and must not be admitted", count)
	}
	if count != MaxRawHandles+1 {
		t.Fatalf("the count rises on ACCEPT even for the refused handle, got %d", count)
	}
	// The refused handle's slot is released by the caller that closed it.
	raw.Release()
	if raw.Live() != MaxRawHandles {
		t.Fatalf("live=%d after releasing the refused handle", raw.Live())
	}
	if raw.Peak() != MaxRawHandles+1 {
		t.Fatalf("the peak records the moment the bound was crossed, got %d", raw.Peak())
	}
	raw.Release()
	if _, admitted := raw.Acquire(); !admitted {
		t.Fatal("a physically closed handle makes room for a replacement")
	}
}

func TestServeStopsWhenTheListenerCloses(t *testing.T) {
	l, _ := testListener(t)
	sink := newSink()
	var raw RawHandles
	stopped := make(chan struct{})
	go func() {
		Serve(l, &raw, sink)
		close(stopped)
	}()
	if err := l.Close(); err != nil {
		t.Fatalf("closing the listener: %v", err)
	}
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Serve must return when its listener is closed")
	}
}
