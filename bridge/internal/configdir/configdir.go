// Package configdir re-derives the Vex config directory from the same facts
// the desktop app uses, with no shared code and no configuration file to read.
//
// The Studio endpoint discriminator is a hash over this directory, so a drift
// between this package and the two Node owners
// (`vex-app/src/main/paths/config-dir.ts`, `src/config/paths.ts`) is a bridge
// that dials a path the app never bound. The three are held together by the
// golden vectors in `studio-mcp/bridge-endpoint-vectors.json`, section
// `configDir`, which all three run as a table test.
package configdir

import (
	"os"
	"runtime"
	"strings"
)

// AppName is the directory leaf. Lowercase on every platform, deliberately:
// the two Node owners pin the same spelling, and a capitalised variant would
// split user state across two directories.
const AppName = "vex"

// Env is the environment as the resolver sees it. A missing name and a name
// bound to the empty string are the same thing here (see usableDirEnv).
type Env map[string]string

// Resolve returns the config directory for a TARGET goos.
//
// goos uses Go's vocabulary ("linux", "darwin", "windows", ...), not Node's.
// The target is a parameter rather than runtime.GOOS so one binary's tests can
// execute the windows vectors: path flavour follows the target, exactly as the
// Node resolvers select path.win32 or path.posix from their input.
func Resolve(goos string, home string, env Env) string {
	windows := goos == "windows"

	// VEX_CONFIG_DIR wins over every platform default, and an accepted value
	// is returned VERBATIM: no join, no clean, no trailing-separator
	// normalisation. The endpoint hash is taken over exactly these bytes, and
	// a cleanup rule invented on one side is a different endpoint.
	if override, ok := usableDirEnv(env["VEX_CONFIG_DIR"], windows); ok {
		return override
	}

	if windows {
		appData, ok := usableDirEnv(env["APPDATA"], true)
		if !ok {
			appData = JoinWindows(home, "AppData", "Roaming")
		}
		return JoinWindows(appData, AppName)
	}

	if goos == "darwin" {
		// macOS follows the platform convention, NOT XDG.
		return JoinPosix(home, "Library", "Application Support", AppName)
	}

	xdg, ok := usableDirEnv(env["XDG_CONFIG_HOME"], false)
	if !ok {
		xdg = JoinPosix(home, ".config")
	}
	return JoinPosix(xdg, AppName)
}

// Current resolves the config directory for the process actually running.
func Current() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	env := Env{}
	for _, name := range []string{"VEX_CONFIG_DIR", "XDG_CONFIG_HOME", "APPDATA"} {
		if value, ok := os.LookupEnv(name); ok {
			env[name] = value
		}
	}
	return Resolve(runtime.GOOS, home, env), nil
}

// usableDirEnv accepts a directory environment variable only when it is
// non-empty AND absolute for the target platform.
//
// Empty counts as unset because the XDG Base Directory specification requires
// it, and because the Node owners' `??` previously let an empty
// XDG_CONFIG_HOME produce the RELATIVE path "vex". Relative is rejected so a
// typo cannot put privileged state in the launcher's working directory.
func usableDirEnv(value string, windows bool) (string, bool) {
	if value == "" {
		return "", false
	}
	if windows {
		if !isAbsWindows(value) {
			return "", false
		}
		return value, true
	}
	if !strings.HasPrefix(value, "/") {
		return "", false
	}
	return value, true
}

// isAbsWindows mirrors Node's path.win32.isAbsolute: a leading separator, or a
// drive-letter root followed by one.
func isAbsWindows(value string) bool {
	if len(value) == 0 {
		return false
	}
	if isWinSep(value[0]) {
		return true
	}
	return len(value) > 2 && isDriveLetter(value[0]) && value[1] == ':' && isWinSep(value[2])
}
