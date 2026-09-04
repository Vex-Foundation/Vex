// Command vex-mcp bridges an MCP client's stdio to the Vex Studio host over an
// endpoint the client cannot reach on its own: a unix socket on Linux and
// macOS, a named pipe on Windows.
//
// It reads nothing but its own flags and environment: the endpoint is
// re-derived from the platform convention, so there is no configuration file
// for a standalone binary to parse and no trust boundary it has to cross to
// learn where to connect. The frozen wire is
// `studio-mcp/bridge-endpoint-contract.md`.
//
// NO RETRY, anywhere. Every way this program can fail is TERMINAL for the
// attempt it was making. A refusal the host sent - `locked` above all, which
// the host answers as a typed handshake refusal while its listener stays up -
// is a decision that has already been made about this connection, and
// repeating the request repeats the answer. A local refusal is this program's
// own decision about the endpoint, and it does not change by being asked
// again. One attempt, one sentence, one distinct exit code; the client
// reconnects when its user acts, not when this process guesses.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"runtime"
	"syscall"

	"github.com/Vex-Foundation/vex/bridge/internal/configdir"
	"github.com/Vex-Foundation/vex/bridge/internal/endpoint"
	"github.com/Vex-Foundation/vex/bridge/internal/handshake"
	"github.com/Vex-Foundation/vex/bridge/internal/relay"
)

// Exit codes. One per FAILURE CLASS, tabled in the contract document, so a
// supervising client can tell "Vex is locked" from "that project is gone"
// without parsing English.
const (
	exitOK                  = 0
	exitUsage               = 1
	exitEndpointRefused     = 2
	exitDialFailed          = 3
	exitHandshakeFailed     = 4
	exitUnknownProject      = 5
	exitIncompatibleVersion = 6
	exitLocked              = 7
	exitAtCapacity          = 8
	exitMalformed           = 9
	exitRefusedUnknownCode  = 10
	exitRelayFailed         = 11
	exitSignal              = 12
)

// errHelpRequested marks the one "failure" that is not one: the user asked for
// the usage and got it.
var errHelpRequested = errors.New("help requested")

func main() {
	os.Exit(run())
}

func run() int {
	// REGISTERED FIRST, before endpoint resolution, the stale-endpoint probe and
	// the dial. Those steps are network and filesystem work with their own
	// deadlines, and until Notify is installed Go's DEFAULT SIGINT/SIGTERM
	// disposition applies: the process dies immediately. A user who hit ctrl-c
	// while the bridge was probing a wedged endpoint therefore got a kill rather
	// than this program's own bounded teardown, and the connection it may have
	// just opened was never closed by an owner. Registering here makes the whole
	// run, not merely the relay, cover the signal.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)

	projectID, err := resolveProjectID()
	if errors.Is(err, errHelpRequested) {
		return exitOK
	}
	if err != nil {
		return fail(exitUsage, err.Error())
	}

	plan, err := derivePlan()
	if err != nil {
		return fail(exitUsage, err.Error())
	}
	if plan.Kind == endpoint.KindRefused {
		return fail(exitEndpointRefused, fmt.Sprintf("%s: %s", plan.Code, plan.Message))
	}
	// WHERE THE WINDOWS CHECK MOVED (contract 1.6). The plan-time transport
	// gate stood here while the pipe's security descriptor was unmeasured. It
	// is measured now (the matrix on endpoint.WindowsTransportProven), and the
	// control that replaces it is stronger rather than weaker: dialEndpoint
	// opens the pipe with SECURITY_IDENTIFICATION SQOS and then authenticates
	// the SERVER - GetNamedPipeServerProcessId, its token's user SID against
	// ours - refusing locally before the handshake writes a byte. A constant
	// could only ever say "not yet"; that check looks at who is actually there.
	var directoryIdentity *endpoint.DirectoryChainIdentity
	if plan.Kind == endpoint.KindUnix {
		directoryIdentity, err = endpoint.CaptureDirectoryChain(plan.ParentDir)
		if err != nil {
			// AN ABSENT DIRECTORY IS NOT A SWAPPED ONE. Its sentence is
			// completed here rather than in the endpoint package, because only
			// this process knows whether its client forwarded the variable the
			// other derivation reads.
			var missing *endpoint.DirectoryMissingError
			if errors.As(err, &missing) {
				_, forwarded := os.LookupEnv("XDG_RUNTIME_DIR")
				return fail(exitEndpointRefused,
					endpoint.EndpointDirectoryMissingRefusal(missing.Path, forwarded))
			}
			return fail(exitEndpointRefused, err.Error())
		}
	}

	conn, err := dialEndpoint(plan)
	if err != nil {
		// A LOCAL REFUSAL IS NOT A DIAL FAILURE. Windows host authentication
		// runs after the pipe opened and before anything was written; the
		// endpoint was reachable and Vex declined it, which is exit 2's
		// meaning and not exit 3's.
		if refusal, ok := asLocalRefusal(err); ok {
			return fail(exitEndpointRefused, refusal.Error())
		}
		return fail(exitDialFailed, dialSentence(plan.Path, err))
	}
	if directoryIdentity != nil {
		if err := directoryIdentity.Verify(); err != nil {
			_ = conn.Close()
			return fail(exitEndpointRefused, err.Error())
		}
	}

	ack, remainder, err := handshake.Perform(conn, projectID, handshake.AckDeadline)
	if err != nil {
		_ = conn.Close()
		return fail(exitHandshakeFailed, handshake.Diagnostic(err.Error()))
	}
	if !ack.OK {
		_ = conn.Close()
		return refusalExit(ack)
	}

	result := relay.Run(relay.Options{
		In:            os.Stdin,
		Out:           relay.TypedStdout(os.Stdout),
		Conn:          conn,
		Prefix:        remainder,
		DrainDeadline: relay.DrainDeadline,
		Signals:       signals,
		CloseOut:      os.Stdout.Close,
	})
	return relayExit(result)
}

// usageLine is the WHOLE usage, in one sentence, because this process owns
// exactly one stderr line per run.
const usageLine = "usage: vex-mcp [--project <uuid>]. The project id may also come from " +
	"$VEX_PROJECT_ID. Open Vex, select the project, and copy the MCP command it shows."

// resolveProjectID reads --project, falling back to VEX_PROJECT_ID.
//
// THE flag PACKAGE PRINTS NOTHING. Its output goes to io.Discard, not to
// stderr: on a parse failure `flag` writes its own error line AND a multi-line
// usage dump, which arrived BEFORE this program's own diagnostic and made a
// contract that promises one bounded line produce five unbounded ones. The
// FlagSet still reports the failure through its return value, which is where
// this function's single owned sentence comes from.
func resolveProjectID() (string, error) {
	flags := flag.NewFlagSet("vex-mcp", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	project := flags.String("project", "",
		"the Vex project id (UUID) this MCP session belongs to; defaults to $VEX_PROJECT_ID")
	if err := flags.Parse(os.Args[1:]); err != nil {
		// -h / --help is a request that was ANSWERED, not a failure. The
		// usage now comes from here rather than from `flag`, so it is one
		// line on stderr and the exit code is 0.
		if errors.Is(err, flag.ErrHelp) {
			warn(usageLine)
			return "", errHelpRequested
		}
		return "", errors.New("vex-mcp accepts --project <uuid> and nothing else. " + usageLine)
	}
	if flags.NArg() > 0 {
		return "", fmt.Errorf("vex-mcp takes no positional arguments; got %q", flags.Arg(0))
	}
	value := *project
	if value == "" {
		value = os.Getenv("VEX_PROJECT_ID")
	}
	if value == "" {
		return "", errors.New("no Vex project id: pass --project <uuid> or set VEX_PROJECT_ID. " +
			"Open Vex, select the project, and copy the MCP command it shows.")
	}
	if !handshake.ValidProjectID(value) {
		return "", errors.New("the Vex project id must be a UUID. Copy the MCP command " +
			"Vex shows for the project rather than typing the id by hand.")
	}
	return value, nil
}

// dialEndpoint opens the planned endpoint, on either transport.
//
// UNIX: an ordinary dial with the contract's connect bound.
//
// WINDOWS: `dialPipe`, in the build-tagged `dial_windows.go` - CreateFile with
// FILE_FLAG_OVERLAPPED and SECURITY_IDENTIFICATION SQOS, the server's user SID
// authenticated against ours, the handle handed to `os.NewFile`. It is REACHED
// at runtime since the section 1.6 transport gate opened; the second, local
// copy of that gate stood here and went with it, because with
// endpoint.WindowsTransportProven true it could refuse nothing.
//
// The connect bound does NOT apply on Windows. CreateFile has no timeout
// parameter and stdlib exposes no WaitNamedPipe, so a pipe that exists but is
// saturated blocks in the open rather than failing fast. That difference is
// named in the contract's Windows section rather than papered over with a
// goroutine that would leak a blocked open.
func dialEndpoint(plan endpoint.Plan) (handshake.Conn, error) {
	if plan.Kind == endpoint.KindPipe {
		// DEFENSIVE, at the dial site itself: a pipe plan must never be
		// opened on a unix target. planOverride refuses pipe syntax off
		// win32 by name, and this is the guard that holds even if a future
		// caller builds a Plan by hand.
		if runtime.GOOS != "windows" {
			return nil, fmt.Errorf("refusing to open the named pipe %s on %s: "+
				"named pipes exist on Windows only", plan.Path, runtime.GOOS)
		}
		return dialPipe(plan.Path)
	}
	conn, err := net.DialTimeout("unix", plan.Path, endpoint.DialTimeout)
	if err != nil {
		return nil, err
	}
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		_ = conn.Close()
		return nil, errors.New("the Vex Studio endpoint did not open as a unix socket")
	}
	return unixConn, nil
}

func derivePlan() (endpoint.Plan, error) {
	dir, err := configdir.Current()
	if err != nil {
		return endpoint.Plan{}, fmt.Errorf("cannot determine the Vex config directory: %w", err)
	}
	env := map[string]string{}
	for _, name := range []string{endpoint.OverrideEnv, "XDG_RUNTIME_DIR"} {
		if value, ok := os.LookupEnv(name); ok {
			env[name] = value
		}
	}
	return endpoint.Derive(endpoint.Input{
		GOOS:               runtime.GOOS,
		ConfigDirHashInput: endpoint.HashInput(dir),
		Env:                env,
		Tmpdir:             os.TempDir(),
		UID:                os.Getuid(),
		ProbeDirectory:     endpoint.ProbeFilesystem,
	}), nil
}

// dialSentence names the two dial failures a user can act on, and keeps the
// rest honest rather than guessing.
func dialSentence(path string, err error) string {
	switch {
	// NEITHER OF THESE MEANS "LOCKED". A locked Vex keeps its listener up and
	// answers the handshake with the typed `locked` refusal, which leaves this
	// program at exit 7 with the host's own sentence. Attributing a lock here
	// would send the user to unlock an app that is not running.
	case errors.Is(err, syscall.ENOENT):
		return fmt.Sprintf("no Vex Studio host is listening at %s: the endpoint does not exist. "+
			"Vex is not running, or it is running for a different configuration directory. "+
			"Start Vex and connect again.", path)
	case errors.Is(err, syscall.ECONNREFUSED):
		return fmt.Sprintf("the Vex Studio endpoint at %s exists but is not accepting "+
			"connections. Vex is starting up or shutting down.", path)
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM):
		return fmt.Sprintf("permission denied connecting to %s. The endpoint belongs to "+
			"another user's Vex.", path)
	case errors.Is(err, os.ErrDeadlineExceeded):
		return fmt.Sprintf("the Vex Studio host at %s did not accept a connection within %s.",
			path, endpoint.DialTimeout)
	default:
		return fmt.Sprintf("cannot connect to the Vex Studio host at %s: %s",
			path, handshake.Diagnostic(err.Error()))
	}
}

// refusalExit maps an ack refusal to one sentence and one exit code.
//
// An UNKNOWN code is not a crash: the contract lists a new refusal code as an
// additive change, and the required v1 behaviour is to print the host's
// message and exit non-zero.
func refusalExit(ack handshake.Ack) int {
	message := handshake.Diagnostic(ack.Message)
	if message == "" {
		message = "the Vex Studio host refused the connection and sent no explanation."
	}
	switch ack.Code {
	case handshake.RefuseUnknownProject:
		return fail(exitUnknownProject, message)
	case handshake.RefuseIncompatibleVersion:
		return fail(exitIncompatibleVersion, message)
	case handshake.RefuseLocked:
		return fail(exitLocked, message)
	case handshake.RefuseAtCapacity:
		return fail(exitAtCapacity, message)
	case handshake.RefuseMalformed:
		return fail(exitMalformed, message)
	default:
		return fail(exitRefusedUnknownCode, fmt.Sprintf("%s: %s",
			handshake.Diagnostic(string(ack.Code)), message))
	}
}

func relayExit(result relay.Result) int {
	switch result.Outcome {
	case relay.OutcomeClientEOF, relay.OutcomePeerEOF:
		return exitOK
	case relay.OutcomeDrainDeadline:
		// A bound that was reached is REPORTED, on a clean exit: the client
		// closed its own input, so nothing it asked for is being abandoned
		// silently, but the fact that the host still had the connection open
		// belongs on the record. The two reasons it can happen are different
		// facts and get different sentences.
		if result.HalfClosed {
			warn(fmt.Sprintf("the Vex Studio host had not closed its side %s after the "+
				"client's input ended; the bridge stopped draining.", relay.DrainDeadline))
		} else {
			warn(fmt.Sprintf("the client's input ended; a named pipe has no half-close, so "+
				"the bridge drained the host's remaining output for %s and then closed the "+
				"connection.", relay.DrainDeadline))
		}
		return exitOK
	case relay.OutcomeStdoutFailed:
		return fail(exitRelayFailed, "the MCP client stopped reading the bridge's output: "+
			handshake.Diagnostic(errText(result.Err)))
	case relay.OutcomeSocketFailed:
		return fail(exitRelayFailed, "the Vex Studio connection failed mid-session: "+
			handshake.Diagnostic(errText(result.Err)))
	case relay.OutcomeSignal:
		return fail(exitSignal, fmt.Sprintf("the Vex Studio bridge stopped on %v.", result.Signal))
	default:
		return fail(exitRelayFailed, "the Vex Studio bridge ended in an unrecognised state.")
	}
}

func errText(err error) string {
	if err == nil {
		return "no further detail"
	}
	return err.Error()
}

// fail writes ONE diagnostic line and returns the exit code. stdout carries
// MCP framing only, so every diagnostic goes to stderr.
func fail(code int, message string) int {
	warn(message)
	return code
}

// warn writes the one owned stderr line. The COMPLETE line - the `vex-mcp: `
// prefix, the sanitized body and the newline - is assembled and bounded by
// handshake.StderrLine, so the contract's 512-byte bound covers what actually
// reaches the pipe rather than only the part this program formats.
func warn(message string) {
	_, _ = io.WriteString(os.Stderr, handshake.StderrLine(message))
}
