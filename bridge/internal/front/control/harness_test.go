package control

import (
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Vex-Foundation/vex/bridge/internal/front/frames"
	"github.com/Vex-Foundation/vex/bridge/internal/front/lifecycle"
	"github.com/Vex-Foundation/vex/bridge/internal/front/listener"
)

// THE SCRIPTED MAIN.
//
// The front is driven end to end here: the REAL supervisor, the REAL relay, the
// REAL codec, the real accept loop, over four real os.Pipe planes and a real
// unix-socket listener standing in for the named pipe. The only substitutions
// are the two things a Linux runner cannot have - the Windows pipe itself, and
// a five-second wall clock - and both are seams the production build wires to
// the real thing.
//
// Timers are FAKE and never slept on, which is the same discipline VS Code's
// protocol suite uses for its acknowledgement and keepalive tests: the frozen
// 5000 ms handshake deadline is FIRED, not waited for, so the test proves the
// deadline's behaviour rather than the clock's.

const (
	testPipeName     = `\\.\pipe\vex-studio-test`
	testRefusalLine  = "{\"ok\":false,\"code\":\"malformed\",\"message\":\"No handshake line arrived within the deadline.\"}\n"
	testFrontVersion = "1.2.3"
	testBuildHash    = "abcdef"
	testPid          = uint32(4242)
	testGeneration   = uint32(0x51ABCDEF)
)

type fakeClock struct {
	mu     sync.Mutex
	timers map[int]*fakeTimer
	next   int
}

type fakeTimer struct {
	clock   *fakeClock
	id      int
	d       time.Duration
	fire    func()
	stopped bool
}

func (t *fakeTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	if t.stopped {
		return false
	}
	t.stopped = true
	delete(t.clock.timers, t.id)
	return true
}

func newFakeClock() *fakeClock { return &fakeClock{timers: map[int]*fakeTimer{}} }

func (c *fakeClock) AfterFunc(d time.Duration, f func()) StopTimer {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.next++
	timer := &fakeTimer{clock: c, id: c.next, d: d, fire: f}
	c.timers[timer.id] = timer
	return timer
}

// fireAll fires every live timer scheduled for exactly this duration and
// reports how many fired.
func (c *fakeClock) fireAll(d time.Duration) int {
	c.mu.Lock()
	var due []*fakeTimer
	for id, timer := range c.timers {
		if timer.d == d {
			due = append(due, timer)
			timer.stopped = true
			delete(c.timers, id)
		}
	}
	c.mu.Unlock()
	for _, timer := range due {
		timer.fire()
	}
	return len(due)
}

func (c *fakeClock) live(d time.Duration) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	count := 0
	for _, timer := range c.timers {
		if timer.d == d {
			count++
		}
	}
	return count
}

type harness struct {
	t *testing.T

	// The MAIN side of the four planes.
	controlDown *os.File
	controlUp   *os.File
	dataDown    *os.File
	dataUp      *os.File

	seqControlDown uint64
	seqDataDown    uint64

	generation uint32
	up         chan frames.Frame
	upData     chan frames.Frame
	upFailed   chan error

	sockPath string
	clock    *fakeClock
	parent   chan lifecycle.ParentSignal
	exit     chan int
	logs     *lockedBuffer

	bindErr error
	flags   uint8
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	return len(p), nil
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}

// newHarness builds the front without starting it, so a test can adjust the
// bind outcome or the flags before the bootstrap runs.
func newHarness(t *testing.T) *harness {
	t.Helper()
	return &harness{
		t:              t,
		seqControlDown: 1,
		seqDataDown:    1,
		up:             make(chan frames.Frame, 256),
		upData:         make(chan frames.Frame, 256),
		upFailed:       make(chan error, 4),
		clock:          newFakeClock(),
		parent:         make(chan lifecycle.ParentSignal, 1),
		exit:           make(chan int, 1),
		logs:           &lockedBuffer{},
		flags:          frames.BoundFlagRejectRemote | frames.BoundFlagFirstInstance | frames.BoundFlagMessageMode,
	}
}

// start wires the planes and the listener and runs the supervisor. It returns
// without completing the bootstrap; bootstrap() does that.
func (h *harness) start() {
	h.t.Helper()
	controlDownR, controlDownW := h.pipe()
	controlUpR, controlUpW := h.pipe()
	dataDownR, dataDownW := h.pipe()
	dataUpR, dataUpW := h.pipe()
	h.controlDown, h.controlUp, h.dataDown, h.dataUp = controlDownW, controlUpR, dataDownW, dataUpR

	h.sockPath = filepath.Join(h.t.TempDir(), "front.sock")
	l, err := net.Listen("unix", h.sockPath)
	if err != nil {
		h.t.Fatalf("listening: %v", err)
	}

	planes := lifecycle.FromFiles(controlDownR, controlUpW, dataDownR, dataUpW)
	supervisor := New(Options{
		Planes: planes,
		Log:    lifecycle.NewLogger(h.logs),
		Bind: func(name string) (*listener.Binding, error) {
			if h.bindErr != nil {
				_ = l.Close()
				return nil, h.bindErr
			}
			if name != testPipeName {
				h.t.Errorf("the front must serve the name HELLO carried, got %q", name)
			}
			return &listener.Binding{Listener: l, FlagsApplied: h.flags}, nil
		},
		Parent:       h.parent,
		FrontVersion: testFrontVersion,
		BuildHash:    testBuildHash,
		Pid:          testPid,
		Generation:   func() uint32 { return testGeneration },
		AfterFunc:    h.clock.AfterFunc,
	})
	go func() { h.exit <- supervisor.Run() }()
	go h.readPlane(frames.PlaneControlUp, h.controlUp, frames.NewDecoder(frames.PlaneControlUp, 0, 0), h.up)
}

func (h *harness) pipe() (*os.File, *os.File) {
	h.t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		h.t.Fatalf("os.Pipe: %v", err)
	}
	h.t.Cleanup(func() {
		_ = r.Close()
		_ = w.Close()
	})
	return r, w
}

func (h *harness) readPlane(plane frames.Plane, r *os.File, dec *frames.Decoder, sink chan<- frames.Frame) {
	buf := make([]byte, 64*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			decoded, decodeErr := dec.Push(buf[:n])
			for _, f := range decoded {
				sink <- f
			}
			if decodeErr != nil {
				h.upFailed <- decodeErr
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// bootstrap performs main's half of protocol section 4 and section 8's bind.
func (h *harness) bootstrap() {
	h.t.Helper()
	h.start()
	h.sendControl(0, frames.Hello{
		ProtocolVersion:       frames.ProtocolVersion,
		SDDLKind:              frames.SDDLKind,
		MaxRaw:                uint16(listener.MaxRawHandles),
		CreditBytes:           expectedCreditBytes,
		ChunkBytes:            expectedChunkBytes,
		HandshakeDeadlineMs:   expectedHandshakeDeadlineMs,
		InitialAdmissionEpoch: 7,
		PipeName:              testPipeName,
		TimeoutRefusalBytes:   testRefusalLine,
	})
	ack := h.expectUp()
	helloAck, ok := ack.Payload.(frames.HelloAck)
	if !ok {
		h.t.Fatalf("expected HELLO_ACK, got %s", ack.Type().Name())
	}
	if ack.Generation != 0 {
		h.t.Fatalf("HELLO_ACK's HEADER generation stays the bootstrap 0, got %d", ack.Generation)
	}
	if helloAck.AnnouncedGeneration == 0 {
		h.t.Fatal("HELLO_ACK must announce a fresh NON-ZERO generation")
	}
	if helloAck.Pid != testPid || helloAck.FrontVersion != testFrontVersion || helloAck.BuildHash != testBuildHash {
		h.t.Fatalf("HELLO_ACK identity: pid=%d version=%q hash=%q",
			helloAck.Pid, helloAck.FrontVersion, helloAck.BuildHash)
	}
	h.generation = helloAck.AnnouncedGeneration
	go h.readPlane(frames.PlaneDataUp, h.dataUp, frames.NewDecoder(frames.PlaneDataUp, h.generation, 0), h.upData)

	bound := h.expectUp()
	if _, ok := bound.Payload.(frames.Bound); !ok {
		h.t.Fatalf("expected BOUND, got %s", bound.Type().Name())
	}
}

// sendControl writes one frame on plane 3 with the next contiguous sequence.
func (h *harness) sendControl(connection uint32, payload frames.Payload) uint64 {
	h.t.Helper()
	return h.sendOn(frames.PlaneControlDown, h.controlDown, &h.seqControlDown, connection, payload)
}

// sendData writes one frame on plane 5 and returns the sequence it used, which
// is what WRITE_DONE acknowledges through.
func (h *harness) sendData(connection uint32, payload frames.Payload) uint64 {
	h.t.Helper()
	return h.sendOn(frames.PlaneDataDown, h.dataDown, &h.seqDataDown, connection, payload)
}

// trySendData is sendData for a burst that is EXPECTED to outlive the front: a
// front that has gone terminal stops draining plane 5, and main's write then
// fails rather than blocking forever.
func (h *harness) trySendData(connection uint32, payload frames.Payload) error {
	encoded, err := frames.Encode(frames.Frame{
		Plane:      frames.PlaneDataDown,
		Generation: h.generation,
		Connection: connection,
		Sequence:   h.seqDataDown,
		Payload:    payload,
	})
	if err != nil {
		return err
	}
	if _, err := h.dataDown.Write(encoded); err != nil {
		return err
	}
	h.seqDataDown++
	return nil
}

func (h *harness) sendOn(plane frames.Plane, w *os.File, sequence *uint64, connection uint32, payload frames.Payload) uint64 {
	h.t.Helper()
	generation := h.generation
	if _, bootstrap := payload.(frames.Hello); bootstrap {
		generation = 0
	}
	encoded, err := frames.Encode(frames.Frame{
		Plane:      plane,
		Generation: generation,
		Connection: connection,
		Sequence:   *sequence,
		Payload:    payload,
	})
	if err != nil {
		h.t.Fatalf("encoding %T: %v", payload, err)
	}
	if _, err := w.Write(encoded); err != nil {
		h.t.Fatalf("writing plane %d: %v", plane, err)
	}
	used := *sequence
	*sequence++
	return used
}

// sendRaw writes bytes main would never write, for the malformed-frame paths.
func (h *harness) sendRaw(plane frames.Plane, raw []byte) {
	h.t.Helper()
	w := h.controlDown
	if plane == frames.PlaneDataDown {
		w = h.dataDown
	}
	if _, err := w.Write(raw); err != nil {
		h.t.Fatalf("writing plane %d: %v", plane, err)
	}
}

const waitBudget = 5 * time.Second

func (h *harness) expectUp() frames.Frame {
	h.t.Helper()
	select {
	case f := <-h.up:
		return f
	case err := <-h.upFailed:
		h.t.Fatalf("plane 4 stopped decoding: %v", err)
	case <-time.After(waitBudget):
		h.t.Fatalf("timed out waiting for a plane 4 frame\n%s", h.logs.String())
	}
	return frames.Frame{}
}

func (h *harness) expectUpData() frames.Frame {
	h.t.Helper()
	select {
	case f := <-h.upData:
		return f
	case <-time.After(waitBudget):
		h.t.Fatalf("timed out waiting for a plane 6 frame\n%s", h.logs.String())
	}
	return frames.Frame{}
}

// expectUpType waits for the next plane 4 frame of one type, failing on any
// other. It is deliberately strict: an unexpected frame in this position is
// exactly the kind of ordering defect the suite exists to catch.
func expectUpType[T frames.Payload](h *harness) (frames.Frame, T) {
	h.t.Helper()
	frame := h.expectUp()
	payload, ok := frame.Payload.(T)
	if !ok {
		var want T
		h.t.Fatalf("expected %T, got %s", want, frame.Type().Name())
	}
	return frame, payload
}

// dialPeer connects an external peer to the front's listener.
func (h *harness) dialPeer() *net.UnixConn {
	h.t.Helper()
	conn, err := net.Dial("unix", h.sockPath)
	if err != nil {
		h.t.Fatalf("dialling the front: %v", err)
	}
	h.t.Cleanup(func() { _ = conn.Close() })
	return conn.(*net.UnixConn)
}

// openConnection dials a peer and takes the OPEN the front announces for it.
func (h *harness) openConnection() (*net.UnixConn, uint32) {
	h.t.Helper()
	peer := h.dialPeer()
	frame, _ := expectUpType[frames.Open](h)
	return peer, frame.Connection
}

// admit sends ADMIT at the given epoch plus a full credit window, which is what
// main does the moment it decides to read a connection.
func (h *harness) admit(id uint32, epoch uint32) {
	h.t.Helper()
	h.sendControl(id, frames.Admit{AdmissionEpoch: epoch})
	h.sendControl(id, frames.Credit{Bytes: expectedCreditBytes})
}

func (h *harness) expectExit(want int) {
	h.t.Helper()
	select {
	case got := <-h.exit:
		if got != want {
			h.t.Fatalf("exit code %d, want %d\n%s", got, want, h.logs.String())
		}
	case <-time.After(waitBudget):
		h.t.Fatalf("the front did not exit\n%s", h.logs.String())
	}
}

// expectPeerClosed reads from a peer until the front closes it, and returns
// every byte the peer received on the way.
func (h *harness) expectPeerClosed(peer net.Conn) []byte {
	h.t.Helper()
	_ = peer.SetReadDeadline(time.Now().Add(waitBudget))
	var received []byte
	buf := make([]byte, 4096)
	for {
		n, err := peer.Read(buf)
		received = append(received, buf[:n]...)
		if err != nil {
			return received
		}
	}
}
