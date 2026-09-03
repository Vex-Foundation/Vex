//go:build linux

package main

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Vex-Foundation/vex/bridge/internal/endpoint"
)

// THE DEFECT THIS FILE OWNS, MEASURED THROUGH A REAL PROCESS.
//
// Codex CLI spawns a stdio MCP server with a SCRUBBED environment: its
// create_env_for_mcp_server (codex-rs/rmcp-client/src/utils.rs:16) copies only
// the DEFAULT_ENV_VARS allowlist (same file, :163 - HOME, LOGNAME, PATH, SHELL,
// USER, __CF_USER_TEXT_ENCODING, LANG, LC_ALL, TERM, TMPDIR, TZ), and
// codex-rs/core/src/spawn.rs:83
// env_clear()s first. XDG_RUNTIME_DIR is not on that list. The app, launched
// from a desktop session, sees the variable and listens under /run/user/<uid>;
// the bridge saw nothing and derived <tmpdir>/vex-studio-<uid>. The built
// binary exited 2 before answering initialize and the client reported a broken
// pipe.
//
// A vector test cannot catch this: both sides matched the fixture. What catches
// it is a REAL PROCESS given a REAL scrubbed environment, dialling a REAL
// listener at the path the APP's derivation names.
//
// The two arms are the two machines this can run on, and exactly one applies:
// with a private /run/user/<uid> (a systemd session) the scrubbed environment
// must still reach it; without one, the derivation falls through to the tmpdir
// form and the ABSENT directory must be reported as absent rather than as an
// ancestor that changed.
func TestScrubbedEnvironmentDialsTheEndpointTheAppBinds(t *testing.T) {
	binary := buildBridge(t)
	configDir := t.TempDir()
	name := endpoint.FileName(endpoint.HashInput(configDir))
	systemdRuntimeDir := fmt.Sprintf("%s/%d", endpoint.LinuxRuntimeDirRoot, os.Getuid())

	if !privateRuntimeDir(systemdRuntimeDir) {
		t.Run("no systemd runtime directory: the absent tmpdir form is named as absent",
			func(t *testing.T) {
				tmpRoot := t.TempDir()
				exit, stderr := runBridge(t, binary, []string{
					"HOME=" + os.Getenv("HOME"),
					"PATH=" + os.Getenv("PATH"),
					"TMPDIR=" + tmpRoot,
					"VEX_CONFIG_DIR=" + configDir,
					"VEX_PROJECT_ID=" + fakeProjectID,
				})
				if exit != 2 {
					t.Fatalf("exit %d, want 2 (a local refusal); stderr: %s", exit, stderr)
				}
				want := endpoint.EndpointDirectoryMissingRefusal(
					filepath.Join(tmpRoot, fmt.Sprintf("vex-studio-%d", os.Getuid())), false)
				if !strings.Contains(stderr, want) {
					t.Fatalf("stderr %q does not carry %q", stderr, want)
				}
			})
		return
	}

	// The listener stands where the APP would bind it: /run/user/<uid>, which
	// is what the app derives from the XDG_RUNTIME_DIR its own session gives
	// it. Nothing below tells the bridge that path.
	socket := filepath.Join(systemdRuntimeDir, name)
	stopHost := listenAsHost(t, socket)
	defer stopHost()

	base := []string{
		"HOME=" + os.Getenv("HOME"),
		"PATH=" + os.Getenv("PATH"),
		"VEX_CONFIG_DIR=" + configDir,
		"VEX_PROJECT_ID=" + fakeProjectID,
	}
	for _, row := range []struct {
		name string
		env  []string
	}{
		// The regression itself: HOME and PATH only, as Codex spawns it.
		{"a scrubbed environment", base},
		// The control: the same run with the variable a desktop client
		// forwards. Both must reach the SAME socket, which is the property
		// that was broken.
		{"the variable forwarded", append(append([]string{}, base...),
			"XDG_RUNTIME_DIR="+systemdRuntimeDir)},
	} {
		t.Run(row.name, func(t *testing.T) {
			exit, stderr := runBridge(t, binary, row.env)
			if exit != 0 {
				t.Fatalf("exit %d, want 0; stderr: %s", exit, stderr)
			}
		})
	}
}

const fakeProjectID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"

// privateRuntimeDir asks the planner's own question about a directory, through
// the planner's own probe, so this test's branch cannot drift from the rule it
// is predicting.
func privateRuntimeDir(dir string) bool {
	facts := endpoint.ProbeFilesystem(dir)
	return facts != nil && facts.IsDirectory && facts.UID == os.Getuid() && facts.Mode&0o077 == 0
}

// buildBridge builds THIS package into the test's temporary directory. The
// subject is the shipped program's behaviour under an environment, which only
// a real binary can carry: run() reads os.Environ through configdir and
// endpoint, and an in-process call would inherit the test runner's own.
func buildBridge(t *testing.T) string {
	t.Helper()
	goTool := filepath.Join(runtime.GOROOT(), "bin", "go")
	if _, err := os.Stat(goTool); err != nil {
		resolved, lookErr := exec.LookPath("go")
		if lookErr != nil {
			t.Fatalf("no Go toolchain to build the bridge with: %v / %v", err, lookErr)
		}
		goTool = resolved
	}
	binary := filepath.Join(t.TempDir(), "vex-mcp")
	// -buildvcs=false: this binary is evidence, not a release artifact, and
	// stamping would make the proof fail wherever the checkout is not a git
	// repository this user owns.
	build := exec.Command(goTool, "build", "-buildvcs=false", "-o", binary, ".")
	build.Env = append(os.Environ(), "GOTOOLCHAIN=local")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("building the bridge: %v\n%s", err, output)
	}
	return binary
}

// listenAsHost is the app's half: accept, answer the handshake with the
// accepted ack, then close when the bridge half-closes. It speaks the wire
// rather than importing the host, because the host is TypeScript and this is
// the client's own binary talking to whatever answers.
func listenAsHost(t *testing.T, socket string) func() {
	t.Helper()
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatalf("binding the fake host at %s: %v", socket, err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
				reader := bufio.NewReader(conn)
				if _, readErr := reader.ReadString('\n'); readErr != nil {
					return
				}
				if _, writeErr := conn.Write([]byte(`{"ok":true}` + "\n")); writeErr != nil {
					return
				}
				// Read to EOF: the bridge half-closes when its client's stdin
				// ends, and closing here is what lets it exit 0 without
				// waiting out the drain bound.
				buffer := make([]byte, 4096)
				for {
					if _, readErr := conn.Read(buffer); readErr != nil {
						return
					}
				}
			}()
		}
	}()
	return func() {
		_ = listener.Close()
		<-done
		if err := os.Remove(socket); err != nil && !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("removing the fake host's socket %s: %v", socket, err)
		}
	}
}

// runBridge runs the built binary with EXACTLY the given environment - no
// inheritance, which is the whole subject - and stdin already at EOF.
func runBridge(t *testing.T, binary string, env []string) (int, string) {
	t.Helper()
	command := exec.Command(binary)
	command.Env = env
	command.Stdin = strings.NewReader("")
	var stderr strings.Builder
	command.Stderr = &stderr
	command.Stdout = &strings.Builder{}

	if err := command.Start(); err != nil {
		t.Fatalf("starting the bridge: %v", err)
	}
	finished := make(chan error, 1)
	go func() { finished <- command.Wait() }()
	select {
	case err := <-finished:
		var exitErr *exec.ExitError
		if err != nil && !errors.As(err, &exitErr) {
			t.Fatalf("waiting for the bridge: %v", err)
		}
		return command.ProcessState.ExitCode(), stderr.String()
	case <-time.After(30 * time.Second):
		_ = command.Process.Kill()
		t.Fatalf("the bridge did not exit within 30s; stderr: %s", stderr.String())
		return -1, ""
	}
}
