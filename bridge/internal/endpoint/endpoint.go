// Package endpoint derives WHERE the bridge dials, and whether it is allowed
// to dial at all.
//
// It is the Go re-implementation of `vex-app/src/main/studio/mcp-host/
// endpoint.ts`, written independently against the same frozen contract
// (`studio-mcp/bridge-endpoint-contract.md`) and held to it by the same golden
// vectors. Nothing here performs I/O: directory facts arrive through a Probe,
// so one function answers a real filesystem, a golden vector and a
// hostile-permissions case identically.
package endpoint

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Vex-Foundation/vex/bridge/internal/configdir"
)

// PATH OPERATIONS IN THIS FILE ARE TARGET-FLAVOURED, NEVER HOST-FLAVOURED.
//
// `path/filepath` follows the machine the code runs on: on a Windows builder
// it joins with `\` and Cleans a posix path into `\run\user\1000\...`.
// Derive answers for a TARGET goos that is a parameter, and the `bridge-
// windows` CI job runs the linux and darwin vectors on a Windows runner, so a
// host-flavoured join there is a red job and, worse, a bridge that dials a
// path the app never bound.
//
// Every join and dirname below therefore goes through the Node-matching
// lexical helpers in internal/configdir, which are the same functions the
// config-directory resolver uses and the same semantics the host's
// `path.posix` / `path.win32` selection produces. The unix sites use the POSIX
// flavour unconditionally and may: a windows target returns its pipe before
// any of them is reached, and a pipe is not a filesystem path.
//
// The only host-flavoured call that remains is filepath.EvalSymlinks in
// HashInput, which is real I/O against the real local filesystem and is host
// business by definition.

// SunPathMaxBytes is ~104 bytes INCLUDING the terminator on Linux and macOS.
const SunPathMaxBytes = 103

// OverrideEnv names the environment variable that replaces the derived
// endpoint. Validated before any dial; never silently ignored.
const OverrideEnv = "VEX_STUDIO_SOCKET"

// DialTimeout bounds the connect attempt to the endpoint this package planned.
//
// Short on purpose: the socket is local, so anything slower than this is a
// host that is not answering, and the user gets a sentence instead of a hang.
// It lives with the endpoint rather than in cmd/vex-mcp so the fixture's
// `bridgeDialTimeoutMs` can be compared against the CONSTANT the program uses,
// not against a literal restated in a test.
const DialTimeout = 2 * time.Second

// RefusalCode is the closed set of local refusals. Each one maps to a distinct
// process exit code in cmd/vex-mcp.
type RefusalCode string

const (
	RefuseOverrideNotAbsolute     RefusalCode = "override_not_absolute"
	RefuseOverrideInvalidPipe     RefusalCode = "override_invalid_pipe"
	RefuseOverridePipeOnUnix      RefusalCode = "override_pipe_on_unix"
	RefuseOverrideParentMissing   RefusalCode = "override_parent_missing"
	RefuseOverrideParentNotDir    RefusalCode = "override_parent_not_directory"
	RefuseOverrideParentNotOwned  RefusalCode = "override_parent_not_owned"
	RefuseOverrideParentMode      RefusalCode = "override_parent_mode"
	RefusePathTooLong             RefusalCode = "path_too_long"
	RefuseEndpointAncestorChanged RefusalCode = "endpoint_ancestor_changed"

	// RefuseWindowsPendingPlatformProof is the RUNTIME gate of section 1.6,
	// not a planning outcome: Derive still plans the pipe, and the vectors
	// still pin its name and syntax. See WindowsTransportProven.
	RefuseWindowsPendingPlatformProof RefusalCode = "windows_pending_platform_proof"
)

// WindowsTransportProven is the one flag that admits the Windows named-pipe
// transport at RUNTIME, on this side of the wire. It is false, and it is a
// constant rather than configuration because no environment variable may open
// a transport whose security descriptor has never been measured.
//
// WHY FALSE. libuv - which is what Node's `server.listen` reaches on win32 -
// creates the pipe with a NULL security descriptor and WITHOUT
// PIPE_REJECT_REMOTE_CLIENTS. The resulting default SD grants Everyone, and
// the anonymous logon, READ access. Duplex is denied to a second user, so the
// handshake still cannot be driven; a READ-ONLY connect is not, and on a
// self-custodial wallet that is a cross-user handshake-slot exhaustion vector
// plus an unmeasured remote-client posture. Rule 90 fails closed until a
// Windows runner measures it.
//
// FLIPPING IT IS MECHANICAL, NOT EDITORIAL: the proof matrix in contract
// section 1.6 runs on the REQUIRED `bridge-windows` CI job. Extending that job
// with the matrix is the only way this constant may become true, on either
// side of the wire.
const WindowsTransportProven = false

// UnprovenWindowsTransport is the gate both the dial site and the host's
// listen site apply to a planned pipe. It returns the refusal, or nil when the
// plan may proceed.
//
// It is deliberately separate from Derive: the derivation, the pipe name and
// the override syntax stay vector-tested exactly as they were, and only the
// act of touching the transport is refused.
func UnprovenWindowsTransport(plan Plan) *Plan {
	if plan.Kind != KindPipe || WindowsTransportProven {
		return nil
	}
	refusal := refuse(RefuseWindowsPendingPlatformProof,
		"The Vex Studio Windows named-pipe transport is not enabled: its pipe "+
			"security descriptor has not been measured on a Windows runner, and "+
			"Vex will not open a wallet transport whose cross-user access is "+
			"unproven. Use Vex Studio on Linux or macOS. The Vex Studio bridge "+
			"did not start.")
	return &refusal
}

// DirFacts is one directory as the planner sees it. Mode carries permission
// bits only (stat.Mode().Perm()).
type DirFacts struct {
	IsDirectory bool
	UID         int
	Mode        uint32
}

// Probe answers for one directory, or nil when it does not exist.
type Probe func(dir string) *DirFacts

// Input is every fact the plan needs. Nothing is read from the process.
type Input struct {
	// GOOS uses Go's vocabulary ("linux", "darwin", "windows", ...).
	GOOS string
	// ConfigDirHashInput is the string the discriminator is hashed over: the
	// resolved config directory (see HashInput).
	ConfigDirHashInput string
	Env                map[string]string
	Tmpdir             string
	UID                int
	ProbeDirectory     Probe
}

// Kind discriminates the three plan outcomes.
type Kind string

const (
	KindUnix    Kind = "unix"
	KindPipe    Kind = "pipe"
	KindRefused Kind = "refused"
)

// Plan is where the bridge will dial, or the named reason it will not.
type Plan struct {
	Kind Kind
	Path string
	// ParentDir and CreateParent describe the host's obligations, not the
	// bridge's. The bridge never creates a directory; the fields are carried
	// so the two implementations run the same vectors.
	ParentDir    string
	CreateParent bool
	Code         RefusalCode
	Message      string
}

// Hash is the endpoint discriminator: the first 12 lowercase hex characters of
// SHA-256 over the EXACT UTF-8 bytes of the resolved config directory.
//
// No BOM, no trailing newline, no case folding, no Unicode normalisation, no
// separator conversion and no Clean. Every one of those would be a rule one
// side could invent and the other could not guess.
func Hash(configDir string) string {
	sum := sha256.Sum256([]byte(configDir))
	return hex.EncodeToString(sum[:])[:12]
}

// FileName is the socket file name for one config directory.
func FileName(configDir string) string {
	return fmt.Sprintf("vex-studio-%s.sock", Hash(configDir))
}

// PipeName is the Windows named pipe for one config directory.
//
// Same discriminator, same input, different transport: Windows has no
// filesystem socket, so the endpoint is a pipe in the machine's pipe
// namespace. The name is PREDICTABLE by design, exactly as VS Code's
// `createStaticIPCHandle` derives its main IPC pipe from a hash of the user
// data directory; the security boundary is the pipe's default security
// descriptor plus this wire's handshake, not a secret name.
//
// DERIVING the name is not permission to OPEN it: see UnprovenWindowsTransport
// and contract section 1.6.
func PipeName(configDir string) string {
	return fmt.Sprintf(`\\.\pipe\vex-studio-%s`, Hash(configDir))
}

// HashInput resolves the config directory to the string that gets hashed.
//
// On SUCCESS the resolved path is used: filepath.EvalSymlinks cleans a
// successful result and Node's realpathSync returns a canonical path, so both
// sides land on the same string, and a symlinked config directory cannot make
// the app and the bridge derive two different endpoints.
//
// On FAILURE the ORIGINAL literal is used with NO Clean. Failure is every
// first run, before the directory exists; the contract freezes the fallback as
// `literal` (vector `realpathFallback`) precisely so neither side invents a
// cleanup the other does not perform. It is not a trust decision: the
// endpoint's own directory ownership and mode are verified regardless.
func HashInput(configDir string) string {
	resolved, err := filepath.EvalSymlinks(configDir)
	if err != nil {
		return configDir
	}
	return resolved
}

// IsWindowsPipePath checks named-pipe syntax structurally: `\\.\pipe\<name>`
// or `\\?\pipe\<name>`, with a non-empty name carrying no separator.
func IsWindowsPipePath(value string) bool {
	const prefixLen = 4 // `\\.\` or `\\?\`
	if len(value) <= prefixLen {
		return false
	}
	if value[0] != '\\' || value[1] != '\\' || (value[2] != '.' && value[2] != '?') || value[3] != '\\' {
		return false
	}
	rest := value[prefixLen:]
	if !strings.HasPrefix(rest, "pipe\\") {
		return false
	}
	name := rest[len("pipe\\"):]
	return name != "" && !strings.ContainsAny(name, "\\/")
}

// Derive plans the endpoint.
func Derive(in Input) Plan {
	if override, ok := in.Env[OverrideEnv]; ok && override != "" {
		return planOverride(override, in)
	}

	// WINDOWS: a named pipe, derived from the SAME hash input as the unix
	// socket. No directory to probe, no ownership or mode to verify, and no
	// sun_path bound: a pipe is not a filesystem object. The host binds this
	// exact name (contract section 1.2).
	if in.GOOS == "windows" {
		return Plan{Kind: KindPipe, Path: PipeName(in.ConfigDirHashInput)}
	}

	name := FileName(in.ConfigDirHashInput)

	// Linux: the XDG runtime directory, but only when the system actually gave
	// us a private one. Those are the four ways it stops being private.
	if in.GOOS == "linux" {
		runtimeDir := in.Env["XDG_RUNTIME_DIR"]
		if runtimeDir != "" && strings.HasPrefix(runtimeDir, "/") &&
			isPrivateDirectory(in.ProbeDirectory(runtimeDir), in.UID) {
			candidate := configdir.JoinPosix(runtimeDir, name)
			if !withinSunPath(candidate) {
				return refuse(RefusePathTooLong, sunPathMessage(candidate))
			}
			return Plan{Kind: KindUnix, Path: candidate, ParentDir: runtimeDir}
		}
	}

	// macOS always, and Linux when XDG_RUNTIME_DIR is unset, relative, not a
	// directory, not ours, or readable by anyone else.
	parent := configdir.JoinPosix(in.Tmpdir, fmt.Sprintf("vex-studio-%d", in.UID))
	candidate := configdir.JoinPosix(parent, name)
	if !withinSunPath(candidate) {
		return refuse(RefusePathTooLong, sunPathMessage(candidate))
	}
	return Plan{Kind: KindUnix, Path: candidate, ParentDir: parent, CreateParent: true}
}

func planOverride(value string, in Input) Plan {
	// PIPE SYNTAX IS A WINDOWS-TARGET STATEMENT, and only that.
	//
	// It used to be accepted whenever the VALUE started with `\\`, on every
	// platform. On Linux that skipped the 0700/ownership/lstat validation this
	// function exists for and handed a relative-looking path straight to
	// listen, where the host bound a FILE named `\\.\pipe\...` in its working
	// directory and the bridge ENOENTed. A pipe override on a unix target is
	// now refused BY NAME.
	if in.GOOS != "windows" && strings.HasPrefix(value, `\\`) {
		return refuse(RefuseOverridePipeOnUnix,
			OverrideEnv+` looks like a Windows named pipe (\\.\pipe\<name>), but `+
				"this is not Windows. A pipe name is not a unix socket path and "+
				"would not be validated as one. Set an absolute path in a "+
				"directory you own with mode 0700. The Vex Studio bridge did not "+
				"start.")
	}
	if in.GOOS == "windows" {
		if !IsWindowsPipePath(value) {
			return refuse(RefuseOverrideInvalidPipe,
				OverrideEnv+` is not a valid named pipe. Use \\.\pipe\<name> with no `+
					"separators in <name>. The Vex Studio bridge did not start.")
		}
		return Plan{Kind: KindPipe, Path: value}
	}

	if !strings.HasPrefix(value, "/") {
		return refuse(RefuseOverrideNotAbsolute,
			OverrideEnv+" must be an absolute path. A relative value would point the "+
				"bridge wherever it happened to be launched from. The Vex Studio "+
				"bridge did not start.")
	}
	if !withinSunPath(value) {
		return refuse(RefusePathTooLong, sunPathMessage(value))
	}

	parent := configdir.DirnamePosix(value)
	facts := in.ProbeDirectory(parent)
	if facts == nil {
		return refuse(RefuseOverrideParentMissing,
			fmt.Sprintf("%s points into %s, which does not exist. Vex does not create "+
				"an override's directory: the operator owns it. The Vex Studio bridge "+
				"did not start.", OverrideEnv, parent))
	}
	if !facts.IsDirectory {
		return refuse(RefuseOverrideParentNotDir,
			fmt.Sprintf("%s points into %s, which is not a directory. The Vex Studio "+
				"bridge did not start.", OverrideEnv, parent))
	}
	if facts.UID != in.UID {
		return refuse(RefuseOverrideParentNotOwned,
			fmt.Sprintf("%s points into %s, which is owned by another user. The Vex "+
				"Studio bridge did not start.", OverrideEnv, parent))
	}
	// EXACTLY 0700 for an override, not "0700 or tighter": an override is an
	// operator statement about a directory Vex did not create, and a mode that
	// is not the one the contract names is worth refusing rather than
	// interpreting.
	if facts.Mode&0o777 != 0o700 {
		return refuse(RefuseOverrideParentMode,
			fmt.Sprintf("%s points into %s, whose mode is 0%o rather than 0700. "+
				"Another user could reach the socket. The Vex Studio bridge did not "+
				"start.", OverrideEnv, parent, facts.Mode&0o777))
	}
	return Plan{Kind: KindUnix, Path: value, ParentDir: parent}
}

func isPrivateDirectory(facts *DirFacts, uid int) bool {
	if facts == nil || !facts.IsDirectory {
		return false
	}
	if facts.UID != uid {
		return false
	}
	// No group and no other bits. 0700 or tighter.
	return facts.Mode&0o077 == 0
}

func withinSunPath(candidate string) bool {
	return len(candidate) <= SunPathMaxBytes
}

func sunPathMessage(candidate string) string {
	return fmt.Sprintf("The Vex Studio socket path is %d bytes, over the %d-byte "+
		"sun_path limit. Set %s to a shorter absolute path in a directory you own "+
		"with mode 0700. The Vex Studio bridge did not start.",
		len(candidate), SunPathMaxBytes, OverrideEnv)
}

func refuse(code RefusalCode, message string) Plan {
	return Plan{Kind: KindRefused, Code: code, Message: message}
}

// ProbeFilesystem is the real probe: the one place this package touches the
// filesystem, and only through the caller's explicit choice to pass it.
//
// LSTAT, NEVER STAT, matching the host's `lstatSync` exactly (contract section
// 1.5). A symlink must be seen AS A SYMLINK rather than as whatever it points
// at: os.Stat would report the ownership and mode of the TARGET, so another
// user could point a link at a directory that happens to be 0700 and this
// probe would call the endpoint's parent private. Lstat reports the link
// itself, which is not a directory, so the plan refuses by name.
func ProbeFilesystem(dir string) *DirFacts {
	info, err := os.Lstat(dir)
	if err != nil {
		return nil
	}
	facts := DirFacts{IsDirectory: info.IsDir(), Mode: uint32(info.Mode().Perm())}
	facts.UID = ownerUID(info)
	return &facts
}
