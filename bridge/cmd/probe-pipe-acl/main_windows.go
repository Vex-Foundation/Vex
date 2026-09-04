//go:build windows

package main

import (
	"errors"
	"flag"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"

	"github.com/Vex-Foundation/vex/bridge/internal/front/frames"
	"github.com/Vex-Foundation/vex/bridge/internal/front/listener"
)

// pipeBufferBytes mirrors the front's per-instance buffer size. The CONTROL
// listener sets it too, so that the only difference between the two serve modes
// is the one under measurement - the security descriptor - and not a second
// variable a reader would have to rule out. A buffer size cannot influence an
// access check, which is exactly why leaving it different would be sloppy
// rather than dangerous.
const pipeBufferBytes = 65536

// busyDialBudget bounds the retry below. It is the same 2 seconds go-winio's
// own DialPipe defaults to (pipe.go:237-243).
const busyDialBudget = 2 * time.Second

// busyDialInterval is go-winio's own wait between attempts when the pipe has no
// free instance (tryDialPipe, pipe.go:227-229).
const busyDialInterval = 10 * time.Millisecond

func main() {
	if len(os.Args) < 2 {
		os.Exit(emitBroken(os.Stdout, reasonUsage))
	}
	switch os.Args[1] {
	case "serve":
		os.Exit(runServe(os.Args[2:]))
	case "dial":
		os.Exit(runDial(os.Args[2:]))
	default:
		os.Exit(emitBroken(os.Stdout, reasonUsage))
	}
}

// runServe creates the pipe and answers connections until stdin closes.
//
// STDIN EOF IS THE SHUTDOWN SIGNAL, not a signal handler and not a timeout: the
// harness that started this process holds the write end, so closing it is a
// shutdown the parent can perform deterministically and cannot forget, and a
// crashed parent produces the same EOF. It is the shape a supervised child
// should have and it needs no wall-clock anywhere in the measurement.
func runServe(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(io.Discard) // flag's own errors would echo the pipe name.
	name := fs.String("name", "", "the pipe path to serve")
	ready := fs.String("ready", "", "file to write the ready report to, atomically")
	descriptor := fs.String("descriptor", descriptorFront,
		"front | winio-default | open; the last two are TEST ONLY arms of the measurement")
	if err := fs.Parse(args); err != nil || *name == "" || *ready == "" {
		return emitBroken(os.Stdout, reasonUsage)
	}
	switch *descriptor {
	case descriptorFront, descriptorWinioDefault, descriptorOpen:
	default:
		return emitBroken(os.Stdout, reasonUsage)
	}

	l, report, code := bindForServe(*name, *descriptor)
	if code != exitOK {
		return code
	}
	defer l.Close()

	if err := writeReadyFile(*ready, report); err != nil {
		return emitBroken(os.Stdout, reasonReadyWriteFail)
	}

	raw := &listener.RawHandles{}
	sink := &recorder{out: os.Stdout, raw: raw}
	served := make(chan struct{})
	go func() {
		defer close(served)
		listener.Serve(l, raw, sink)
	}()

	// The parent closing stdin ends the run. Discarding is deliberate: nothing
	// this instrument does is driven by what arrives, only by the close.
	_, _ = io.Copy(io.Discard, os.Stdin)
	_ = l.Close()
	<-served

	accepted, overflow := sink.totals()
	_ = emit(os.Stdout, serveDoneReport{Event: "serve_done", Accepted: accepted, Overflow: overflow})
	return exitOK
}

// bindForServe creates the listener for whichever arm is being run and builds
// the report that describes it.
func bindForServe(name string, descriptor string) (net.Listener, readyReport, int) {
	if descriptor != descriptorFront {
		// An EMPTY SecurityDescriptor is what go-winio turns into the DEFAULT
		// named pipe ACL (RtlDefaultNpAcl, pipe.go:356-370) - the descriptor a
		// process that asks for nothing gets, and the one endpoint contract 1.6
		// describes as granting Everyone read access. `open` instead names an
		// explicit everyone-full descriptor, the squatter's choice.
		//
		// NEITHER ARM RUNS THE FRONT'S READBACK, and neither could: the front's
		// readback is designed to REFUSE exactly these descriptors
		// (listener.TestVerifyDescriptorRejectsTheDefaultPipeDescriptor). They
		// report their flags as absent rather than as false.
		sddl := ""
		if descriptor == descriptorOpen {
			sddl = openDescriptorSDDL
		}
		l, err := winio.ListenPipe(name, &winio.PipeConfig{
			SecurityDescriptor: sddl,
			MessageMode:        true,
			InputBufferSize:    pipeBufferBytes,
			OutputBufferSize:   pipeBufferBytes,
		})
		if err != nil {
			return nil, readyReport{}, emitBroken(os.Stdout, reasonBindFailed)
		}
		return l, readyReport{
			Event:      "ready",
			Descriptor: descriptor,
			Pid:        os.Getpid(),
		}, exitOK
	}

	// THE REAL FRONT PATH, called and not re-implemented: listener.Bind
	// compiles in the descriptor, applies it, and reads it back off the live
	// handle. A probe that built its own descriptor would measure the probe.
	binding, err := listener.Bind(name)
	if err != nil {
		var readback *listener.ReadbackError
		if errors.As(err, &readback) {
			return nil, readyReport{}, emitBroken(os.Stdout, reasonReadbackFailed)
		}
		return nil, readyReport{}, emitBroken(os.Stdout, reasonBindFailed)
	}
	flags := binding.FlagsApplied
	rejectRemote := flags&frames.BoundFlagRejectRemote != 0
	firstInstance := flags&frames.BoundFlagFirstInstance != 0
	messageMode := flags&frames.BoundFlagMessageMode != 0
	return binding.Listener, readyReport{
		Event:         "ready",
		Descriptor:    descriptorFront,
		Pid:           os.Getpid(),
		FlagsApplied:  &flags,
		RejectRemote:  &rejectRemote,
		FirstInstance: &firstInstance,
		MessageMode:   &messageMode,
	}, exitOK
}

// writeReadyFile publishes the report ATOMICALLY: a temporary file in the same
// directory, then a rename. The harness polls for this path, and a poll that
// caught a half-written file would parse garbage and fail a measurement that
// had actually succeeded.
func writeReadyFile(path string, report readyReport) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".ready-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if err := emit(tmp, report); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return nil
}

// recorder is the serve loop's sink: it reports every accepted connection and
// closes it immediately.
//
// IT RELEASES THE RAW SLOT ITSELF, because listener.Serve hands ownership of
// both the handle and the slot to a sink whose Accepted returns true
// (accept.go:121-132). The front's real sink releases when the handle is
// PHYSICALLY closed; this one closes the handle here, so it releases here. A
// sink that forgot would exhaust MaxRawHandles after 21 measurements.
type recorder struct {
	out io.Writer
	raw *listener.RawHandles

	mu       sync.Mutex
	accepted int
	overflow int
}

func (r *recorder) Accepted(conn net.Conn) bool {
	handle, hasHandle := pipeHandle(conn)
	pid, known := clientProcessID(handle, hasHandle)
	level, levelMeasured := measureImpersonationLevel(handle, hasHandle)
	_ = conn.Close()
	r.raw.Release()

	r.mu.Lock()
	r.accepted++
	count := r.accepted
	r.mu.Unlock()

	report := acceptedReport{
		Event:                  "accepted",
		Count:                  count,
		ClientPid:              pid,
		ClientPidKnown:         known,
		ImpersonationLevelName: impersonationUnmeasured,
	}
	if levelMeasured {
		report.ImpersonationLevel = &level
		report.ImpersonationLevelName = impersonationLevelName(level)
	}
	_ = emit(r.out, report)
	return true
}

func (r *recorder) Overflow(int) {
	r.mu.Lock()
	r.overflow++
	r.mu.Unlock()
}

// AcceptFailed stops the loop and prints NOTHING about the error: a Windows
// error on a listener carries the pipe path, and this instrument never prints
// the path. The serve_done line is the report.
func (r *recorder) AcceptFailed(error) bool { return false }

func (r *recorder) totals() (accepted int, overflow int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.accepted, r.overflow
}

var (
	// GetNamedPipeClientProcessId (kernel32, Vista and later) is declared
	// locally because golang.org/x/sys v0.10.0 - the version go-winio v0.6.2
	// requires - does not export it. Same declaration, same reason, as
	// internal/front/listener/bind_windows.go. Signature: BOOL (HANDLE Pipe,
	// PULONG ClientProcessId), r1 == 0 on failure.
	modkernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procGetNamedPipeClientProcessID = modkernel32.NewProc("GetNamedPipeClientProcessId")

	// ImpersonateNamedPipeClient (advapi32) is declared locally for the same
	// reason: x/sys v0.10.0 exports OpenThreadToken, RevertToSelf,
	// GetTokenInformation, GetCurrentThread and the TokenImpersonationLevel
	// class, but not this one. Signature: BOOL (HANDLE NamedPipe), r1 == 0 on
	// failure
	// (learn.microsoft.com/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient).
	modadvapi32                    = syscall.NewLazyDLL("advapi32.dll")
	procImpersonateNamedPipeClient = modadvapi32.NewProc("ImpersonateNamedPipeClient")
)

// pipeHandle reaches the kernel handle behind an accepted connection.
//
// go-winio's pipe connection promotes win32File.Fd (file.go), which is the only
// way to get at it, and it is the same access internal/front/listener's own
// readback uses.
func pipeHandle(conn net.Conn) (windows.Handle, bool) {
	handled, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return 0, false
	}
	return windows.Handle(handled.Fd()), true
}

// clientProcessID asks the kernel which process is on the other end of an
// accepted instance. Find before Call: LazyProc.Addr PANICS when the procedure
// is missing, and a missing procedure is a reported absence, not a crash.
func clientProcessID(handle windows.Handle, hasHandle bool) (uint32, bool) {
	if !hasHandle {
		return 0, false
	}
	if err := procGetNamedPipeClientProcessID.Find(); err != nil {
		return 0, false
	}
	var pid uint32
	r1, _, _ := procGetNamedPipeClientProcessID.Call(uintptr(handle), uintptr(unsafe.Pointer(&pid)))
	if r1 == 0 {
		return 0, false
	}
	return pid, true
}

// measureImpersonationLevel answers contract 1.6 item 8 from the SERVER'S SIDE:
// it impersonates the client on this pipe instance and reads back the level the
// operating system actually granted.
//
// WHY IT IS THE ONLY HONEST WAY TO ASK. The client's SQOS flags are a REQUEST
// the client makes; item 8 asks what the SERVER RECEIVES, and only a server can
// observe that. A test that re-read the client's own flags would be reading its
// own input.
//
// THE THREAD IS THE UNIT OF IMPERSONATION, so this runs on its own goroutine
// with runtime.LockOSThread: impersonation is thread state, and leaving it on a
// goroutine that Go may reschedule elsewhere would put a foreign identity on an
// arbitrary worker thread.
//
// THE THREAD IS UNLOCKED ONLY AFTER RevertToSelf SUCCEEDS. If the revert fails,
// the goroutine returns while still locked, which retires the operating-system
// thread with it (runtime.LockOSThread's documented behaviour) rather than
// returning a thread that still carries the client's identity to the pool.
func measureImpersonationLevel(handle windows.Handle, hasHandle bool) (uint32, bool) {
	if !hasHandle {
		return 0, false
	}
	if err := procImpersonateNamedPipeClient.Find(); err != nil {
		return 0, false
	}

	type measurement struct {
		level    uint32
		measured bool
	}
	done := make(chan measurement, 1)
	go func() {
		runtime.LockOSThread()
		result := measurement{}
		r1, _, _ := procImpersonateNamedPipeClient.Call(uintptr(handle))
		if r1 == 0 {
			done <- result
			runtime.UnlockOSThread()
			return
		}
		result.level, result.measured = readThreadImpersonationLevel()
		if err := windows.RevertToSelf(); err != nil {
			// The thread keeps the client's identity. It is not going back to
			// the pool: the goroutine exits locked, and the runtime retires it.
			done <- result
			return
		}
		done <- result
		runtime.UnlockOSThread()
	}()
	got := <-done
	return got.level, got.measured
}

// readThreadImpersonationLevel reads TokenImpersonationLevel off the impersonation
// token this thread is currently carrying.
//
// OpenThreadToken with openAsSelf = true performs the access check against the
// PROCESS token rather than the impersonation token, which is what lets a
// thread impersonating a lesser-privileged client still open its own token.
// The information class is x/sys's TokenImpersonationLevel and the value is the
// 4-byte SECURITY_IMPERSONATION_LEVEL enum.
func readThreadImpersonationLevel() (uint32, bool) {
	thread, err := windows.GetCurrentThread()
	if err != nil {
		return 0, false
	}
	var token windows.Token
	if err := windows.OpenThreadToken(thread, windows.TOKEN_QUERY, true, &token); err != nil {
		return 0, false
	}
	defer token.Close()

	var (
		level    uint32
		returned uint32
	)
	if err := windows.GetTokenInformation(token, windows.TokenImpersonationLevel,
		(*byte)(unsafe.Pointer(&level)), uint32(unsafe.Sizeof(level)), &returned); err != nil {
		return 0, false
	}
	if returned != uint32(unsafe.Sizeof(level)) {
		return 0, false
	}
	return level, true
}

// runDial performs ONE connect attempt and classifies it.
func runDial(args []string) int {
	fs := flag.NewFlagSet("dial", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	name := fs.String("name", "", "the pipe path to dial; a full path, so `\\\\localhost\\pipe\\x` is allowed")
	expect := fs.String("expect", "", "connected | denied; OMIT to record the outcome without asserting one")
	access := fs.String("access", accessDuplex, "duplex | read")
	if err := fs.Parse(args); err != nil || *name == "" {
		return emitBroken(os.Stdout, reasonUsage)
	}
	want, assert, valid := requiredOutcome(*expect)
	if !valid {
		return emitBroken(os.Stdout, reasonUsage)
	}
	mask, ok := accessMask(*access)
	if !ok {
		return emitBroken(os.Stdout, reasonUsage)
	}

	result, retries, err := dialOnce(*name, mask)
	if err != nil {
		return emitBroken(os.Stdout, reasonPipeNameInvalid)
	}
	report := dialReport{
		Event:        "dial",
		Access:       *access,
		Expect:       *expect,
		Outcome:      result.outcome,
		WindowsError: result.code,
		BusyRetries:  retries,
	}
	if assert {
		matched := result.outcome == want
		report.Match = &matched
	}
	_ = emit(os.Stdout, report)
	if assert && !*report.Match {
		return exitMismatch
	}
	return exitOK
}

// accessMask maps the --access word to the CreateFile access mask.
//
// `duplex` is what the shipped bridge asks for (cmd/vex-mcp/dial_windows.go:
// GENERIC_READ|GENERIC_WRITE), which is the open the handshake needs. `read` is
// the open the DEFAULT descriptor is documented to allow a second user, and
// therefore the one that decides whether a foreign account can consume a pipe
// instance without ever being able to talk.
func accessMask(access string) (uint32, bool) {
	switch access {
	case accessDuplex:
		return syscall.GENERIC_READ | syscall.GENERIC_WRITE, true
	case accessRead:
		return syscall.GENERIC_READ, true
	default:
		return 0, false
	}
}

// Impersonation-level flags for CreateFile, absent from stdlib `syscall`.
// Values and spelling MIRROR cmd/vex-mcp/dial_windows.go, which cites
// golang.org/x/sys/windows types_windows.go (SECURITY_SQOS_PRESENT = 0x100000,
// SECURITY_IDENTIFICATION = SecurityIdentification << 16 = 0x10000) and
// WinBase.h.
//
// MIRRORED, NOT REUSED, and that is a deliberate cost. The shipped dial lives
// in `package main` of cmd/vex-mcp, so it cannot be imported; extracting it
// into a shared package would change the binary whose dependency graph is
// gated by cmd/vex-pipe-front/imports_test.go, for the benefit of an
// instrument. The duplication is two constants and one CreateFile call, and
// the flags are pinned by the comment above on both sides.
const (
	securitySQOSPresent    = 0x00100000 // SECURITY_SQOS_PRESENT
	securityIdentification = 0x00010000 // SECURITY_IDENTIFICATION
)

type dialResult struct {
	outcome outcome
	code    uint32
}

// dialOnce opens the pipe with the SAME flags the shipped bridge uses and
// classifies what came back.
//
// WHAT IT DELIBERATELY DOES NOT DO: the host authentication of
// cmd/vex-mcp/hostauth_windows.go. This instrument measures the ACCESS CHECK -
// whether the operating system lets this account open the handle at all - and
// that decision is made by CreateFile before any Vex code could have an
// opinion. Adding the identity comparison here would measure two controls at
// once and could pass a denial off as a refusal.
//
// THE BUSY RETRY. go-winio's listener creates a connectable instance only while
// an Accept is outstanding (pipe.go:456-475), so a dial that lands between two
// accepts is answered with ERROR_PIPE_BUSY, which is a property of the SERVER'S
// TIMING and not of the descriptor. Retrying it - within go-winio's own budget
// and interval, and only for that one code - is what keeps a security
// measurement from being a coin flip. Every other code, denial included, is
// returned on the first attempt. The retry count is reported.
func dialOnce(path string, mask uint32) (dialResult, int, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return dialResult{}, 0, err
	}
	deadline := time.Now().Add(busyDialBudget)
	retries := 0
	for {
		handle, err := syscall.CreateFile(
			name,
			mask,
			0,   // no sharing: this is a client handle to one pipe instance
			nil, // default security attributes; the handle is not inherited
			syscall.OPEN_EXISTING,
			syscall.FILE_FLAG_OVERLAPPED|securitySQOSPresent|securityIdentification,
			0,
		)
		if err == nil {
			// The instrument never speaks on the connection: it measures the
			// open and gives the instance straight back.
			_ = syscall.CloseHandle(handle)
			return dialResult{outcome: outcomeConnected, code: 0}, retries, nil
		}
		code := errorCode(err)
		if code == errorPipeBusy && time.Now().Before(deadline) {
			retries++
			time.Sleep(busyDialInterval)
			continue
		}
		return dialResult{outcome: classifyDialError(code), code: code}, retries, nil
	}
}

// errorCode extracts the Win32 code from what CreateFile returned. Anything
// that is not an Errno has no code, and 0 with outcome `other` is how that is
// reported - never as a success.
func errorCode(err error) uint32 {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return uint32(errno)
	}
	return 0
}
