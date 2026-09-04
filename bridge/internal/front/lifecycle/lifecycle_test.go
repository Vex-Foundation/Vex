package lifecycle

import (
	"errors"
	"io"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// The structural log carries CODES AND COUNTS and cannot carry anything else.
// The type is the enforcement; this test is the proof that the rendering keeps
// the promise the type makes.
func TestLogEventRendersCodesAndNumbersOnly(t *testing.T) {
	var out strings.Builder
	log := NewLogger(&out)
	log.Event("malformed_main_frame:bad_magic",
		Num("plane", 5), Num("type", 0x81), Num("sequence", 42), Num("length", 32768))
	log.Event("locked", Num("epoch", 7), Flag("admitted", false))

	want := "vex-pipe-front malformed_main_frame:bad_magic plane=5 type=129 sequence=42 length=32768\n" +
		"vex-pipe-front locked epoch=7 admitted=0\n"
	if out.String() != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out.String(), want)
	}
}

func TestLogIsSafeForConcurrentReporters(t *testing.T) {
	var out lockedBuffer
	log := NewLogger(&out)
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 32 {
				log.Event("accepted", Num("connection", 1), Num("live", 2))
			}
		}()
	}
	wg.Wait()
	lines := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	if len(lines) != 8*32 {
		t.Fatalf("expected %d lines, got %d", 8*32, len(lines))
	}
	for _, line := range lines {
		if line != "vex-pipe-front accepted connection=1 live=2" {
			t.Fatalf("a torn line: %q", line)
		}
	}
}

type lockedBuffer struct {
	mu  sync.Mutex
	out strings.Builder
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.out.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.out.String()
}

// A log write that fails is DISCARDED. A front that died because its
// diagnostics plane was full would be a worse outcome than a missing line.
func TestLogSurvivesAFailingWriter(t *testing.T) {
	log := NewLogger(failingWriter{})
	log.Event("plane_write_failed", Num("plane", 4))
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

// STDIN EOF IS THE PARENT-DEATH SIGNAL. The watch fires on the read completing,
// which is exactly the moment main's last handle to the pipe closes.
func TestWatchParentFiresOnStdinEOF(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	defer r.Close()
	signal := WatchParent(r)
	select {
	case <-signal:
		t.Fatal("the watch must not fire while the parent holds the write end")
	case <-time.After(50 * time.Millisecond):
	}
	if err := w.Close(); err != nil {
		t.Fatalf("closing the write end: %v", err)
	}
	select {
	case got := <-signal:
		if got != ParentEOF {
			t.Fatalf("got signal %d, want ParentEOF", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the watch must fire when the parent's handle closes")
	}
}

// PROTOCOL SECTION 1: main NEVER writes stdin after spawn. A byte there means
// the process on the other end is not the main this front was built for, and
// the front fails closed rather than serving it.
func TestWatchParentFiresOnUnexpectedStdinBytes(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	defer r.Close()
	defer w.Close()
	signal := WatchParent(r)
	if _, err := w.Write([]byte("x")); err != nil {
		t.Fatalf("writing to stdin: %v", err)
	}
	select {
	case got := <-signal:
		if got != ParentWroteBytes {
			t.Fatalf("got signal %d, want ParentWroteBytes", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the watch must fire on an unexpected byte")
	}
}

// Acquire has no meaning off Windows and says so rather than pretending. On
// Windows it is exercised by the front itself, which is spawned with the seven
// stdio slots this test process does not have.
func TestAcquireIsWindowsOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the Windows build reads the real CRT reserved block")
	}
	planes, err := Acquire()
	if err == nil || planes != nil {
		t.Fatalf("expected ErrPlanesUnsupported, got planes=%v err=%v", planes, err)
	}
	if !errors.Is(err, ErrPlanesUnsupported) {
		t.Fatalf("got %v, want ErrPlanesUnsupported", err)
	}
}

func TestFromFilesWiresEveryPlaneAndClosesThemAll(t *testing.T) {
	files := make([]*os.File, 0, 4)
	for range 4 {
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatalf("os.Pipe: %v", err)
		}
		defer w.Close()
		files = append(files, r)
	}
	planes := FromFiles(files[0], files[1], files[2], files[3])
	if planes.ControlDown != files[0] || planes.DataDown != files[2] {
		t.Fatal("the readable planes are slots 3 and 5, in that order")
	}
	if planes.ControlUp != files[1] || planes.DataUp != files[3] {
		t.Fatal("the writable planes are slots 4 and 6, in that order")
	}
	if err := planes.Close(); err != nil {
		t.Fatalf("closing the planes: %v", err)
	}
	// Close is idempotent: a partly-acquired front closes what it has, and a
	// second close must not report a failure it caused itself.
	if err := planes.Close(); err != nil {
		t.Fatalf("a second close must be a no-op, got %v", err)
	}
}
