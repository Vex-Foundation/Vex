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

// LinuxRuntimeDirRoot is the systemd per-user runtime root, PROBED rather than
// assumed, and PREFERRED over $XDG_RUNTIME_DIR.
//
// It is the rung that keeps this binary and the app from disagreeing, and the
// order is the half of that which was measured wrong first: probing the
// directory only AFTER the variable failed still lets the two sides diverge,
// because a private CUSTOM XDG_RUNTIME_DIR (WSLg's /mnt/wslg/runtime-dir on
// some distributions) is a directory the app can see and this process cannot.
// The app bound there while this bridge, spawned without the variable, found
// /run/user/<uid> private and dialled that. Same privacy gate, two endpoints,
// no rendezvous. The environment-INDEPENDENT fact is therefore consulted
// first, and the variable only decides where a system that has no
// /run/user/<uid> puts its runtime directory.
//
// THE RESIDUAL, NAMED RATHER THAN CLOSED (contract 1.2): a machine with no
// private /run/user/<uid> AND a custom private XDG_RUNTIME_DIR the launcher
// drops still diverges. No fact both processes read describes that directory,
// and the follow-up is a rendezvous file, not another environment rung.
//
// WHY THE VARIABLE CANNOT BE THE SHARED FACT. XDG_RUNTIME_DIR is an
// environment variable, and an MCP client is free to
// spawn this bridge with an environment that does not carry it. Codex CLI does
// exactly that, by design rather than by accident: create_env_for_mcp_server
// (codex-rs/rmcp-client/src/utils.rs:16) builds a stdio MCP server's
// environment from the DEFAULT_ENV_VARS ALLOWLIST (same file, :163 - HOME,
// LOGNAME, PATH, SHELL, USER, __CF_USER_TEXT_ENCODING, LANG, LC_ALL, TERM,
// TMPDIR, TZ, and no XDG_RUNTIME_DIR) plus that server's own config env map,
// and
// codex-rs/core/src/spawn.rs:83 env_clear()s before applying it. So the app
// derived /run/user/<uid> from the variable IT could see while this bridge
// fell through to <tmpdir>/vex-studio-<uid>, and the client saw a broken pipe.
//
// The derivation is therefore a pure function of (uid, config directory,
// XDG_RUNTIME_DIR, and the FILESYSTEM facts of /run/user/<uid>). That last
// term is the one both sides read identically whatever their environment says,
// and it is held to the SAME isPrivateDirectory gate as the variable's own
// directory: a directory, owned by this uid, with no group or other bits,
// which is the systemd guarantee that makes it a safe socket home.
//
// The Codex dialect could also carry `env = { XDG_RUNTIME_DIR = ... }` in the
// config Vex writes, and that is NOT the fix: it would freeze one login
// session's value into a file that outlives the session.
const LinuxRuntimeDirRoot = "/run/user"

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

	// RefuseEndpointDirectoryMissing is the BRIDGE-SIDE half of the ancestor
	// check, split out because the old code lied about the commonest case: a
	// client that reached CaptureDirectoryChain for a directory that was never
	// there was told the ancestor "changed before use". The host never emits
	// it - it CREATES its parent directory (contract 1.2) - so unlike the
	// changed-sentence it is this side's own vocabulary, exercised by
	// TestEndpointDirectoryMissingRefusal. Same failure class and therefore
	// the same exit code as every other local refusal.
	RefuseEndpointDirectoryMissing RefusalCode = "endpoint_directory_missing"

	// `windows_pending_platform_proof` was the section 1.6 runtime gate's
	// code and left this set when the gate opened: no path can produce it,
	// and it never crossed the wire - it was this process refusing its own
	// plan, printed to stderr as exit 2. An older bridge binary still emits
	// its own copy against a newer host, which changes nothing here, because
	// nothing on either side ever PARSED the code out of that line.
)

// WindowsTransportProven records that the Windows named-pipe transport is
// ADMITTED at runtime, on this side of the wire. It stays a constant rather
// than configuration for the reason it always was: no environment variable
// decides whether a wallet opens a transport.
//
// WHY TRUE. The eight-row proof matrix of contract section 1.6 was MEASURED on
// the required Windows CI jobs, not argued: rows 1, 2, 3, 7 and 8 on
// `bridge-windows` run 33646484002 (second-user duplex denial paired against a
// control pipe, a read-only cross-user connect denied with no instance
// consumed, rejectRemote confirmed by readback and the loopback redirector
// refused, a foreign user's first-server squat failing the front's bind closed
// and refused by TestHostAuthRefusesAForeignUsersServer, and impersonation
// level 1 - identification); row 4's host half on `vex-app-windows` run
// 33650332655; rows 5 and 6 on `bridge-windows` run 33663385959, which is where
// THIS side's overlapped duplex, deadlines and close cancellation were measured
// on a real pipe handle (cmd/vex-mcp/dial_windows_test.go).
//
// The libuv reasoning this gate was closed for describes a pipe Vex no longer
// creates: the host's vex-pipe-front child binds it under its own PROTECTED
// two-ACE descriptor and reports back only what Windows CONFIRMED on readback.
//
// IT STAYS OPEN MECHANICALLY, NOT EDITORIALLY. The host carries the identical
// flag (WINDOWS_TRANSPORT_PROVEN in vex-app/src/main/studio/mcp-host/
// endpoint.ts) and the two are ONE decision: a reviewer who sees either flag
// false while the other is true rejects the change, in that direction as much
// as in the other. Closing the transport again is a contract change (section 5)
// carrying both owners, never an edit to one constant.
const WindowsTransportProven = true

// UnprovenWindowsTransport stood here: the plan-time gate that refused a pipe
// plan while WindowsTransportProven was false. It went with the flip, because a
// branch that cannot fire is not a control - with the constant true its only
// statement was `return nil`, and its refusal code had no producer left.
//
// What guards the dial now is measured rather than assumed, and it runs on
// EVERY pipe dial rather than once at plan time: the SQOS client flags and the
// server-SID host authentication in dial_windows.go and hostauth_windows.go,
// with the front's readback-confirmed descriptor on the host's side.

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
// DERIVING the name is not permission to TRUST what answers on it: see
// cmd/vex-mcp/hostauth_windows.go and contract section 1.6.
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

	// Linux: THE FILESYSTEM FACT FIRST, THE ENVIRONMENT SECOND (contract 1.2).
	//
	// Both rungs are held to the same privacy gate; what the order decides is
	// which one wins when they name DIFFERENT directories, and only one of the
	// two is a fact both processes read identically. See LinuxRuntimeDirRoot
	// for why the variable cannot be that fact.
	if in.GOOS == "linux" {
		systemdRuntimeDir := configdir.JoinPosix(LinuxRuntimeDirRoot, fmt.Sprintf("%d", in.UID))
		if isPrivateDirectory(in.ProbeDirectory(systemdRuntimeDir), in.UID) {
			return planPrivateRuntimeDir(systemdRuntimeDir, name)
		}

		// NO /run/user/<uid>, SO THE VARIABLE IS THE ONLY PRIVATE RUNTIME
		// DIRECTORY THIS SYSTEM OFFERS. A distribution that puts one somewhere
		// else (WSLg's /mnt/wslg/runtime-dir) is served here rather than
		// pushed down to the tmpdir form. It is also the rung carrying the
		// residual divergence contract 1.2 names by hand: when a launcher
		// drops the variable AND there is no /run/user/<uid>, this side and
		// the other derive different endpoints, and no fact available to both
		// closes it.
		runtimeDir := in.Env["XDG_RUNTIME_DIR"]
		if runtimeDir != "" && strings.HasPrefix(runtimeDir, "/") &&
			isPrivateDirectory(in.ProbeDirectory(runtimeDir), in.UID) {
			return planPrivateRuntimeDir(runtimeDir, name)
		}
	}

	// macOS always, and Linux when neither runtime directory is private: no
	// /run/user/<uid>, and an XDG_RUNTIME_DIR that is unset, relative, not a
	// directory, not ours, or readable by anyone else.
	parent := configdir.JoinPosix(in.Tmpdir, fmt.Sprintf("vex-studio-%d", in.UID))
	candidate := configdir.JoinPosix(parent, name)
	if !withinSunPath(candidate) {
		return refuse(RefusePathTooLong, sunPathMessage(candidate))
	}
	return Plan{Kind: KindUnix, Path: candidate, ParentDir: parent, CreateParent: true}
}

// planPrivateRuntimeDir plans inside a system-owned private runtime directory.
// CreateParent stays false for both callers: the system created these and the
// planner only verified them.
func planPrivateRuntimeDir(runtimeDir string, name string) Plan {
	candidate := configdir.JoinPosix(runtimeDir, name)
	if !withinSunPath(candidate) {
		return refuse(RefusePathTooLong, sunPathMessage(candidate))
	}
	return Plan{Kind: KindUnix, Path: candidate, ParentDir: runtimeDir}
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
