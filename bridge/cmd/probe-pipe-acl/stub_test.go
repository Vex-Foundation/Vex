//go:build !windows

package main

import (
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// THE STUB IS TESTED THROUGH THE BUILT BINARY, not by calling a function.
//
// What it promises is an EXIT CODE and a sentence on stderr, and neither is
// observable from inside the process that would call main(). So the test builds
// the command and runs it, which is the same reason cmd/vex-pipe-front's import
// gate shells out to `go list` rather than reasoning about the graph.
//
// The property matters because the CI job will run this binary on a Windows
// runner: if a step ever runs it on the linux job by mistake, the distinct exit
// code 2 is what tells the reader "wrong platform" instead of letting a
// missing measurement look like a passing one.
func TestNonWindowsBuildRefusesToMeasureAndSaysWhy(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "probe-pipe-acl")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Env = append(build.Environ(), "GOTOOLCHAIN=local")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("building the probe: %v\n%s", err, out)
	}

	run := exec.Command(binary, "dial", "--name", "whatever", "--expect", "denied")
	stderr := &strings.Builder{}
	stdout := &strings.Builder{}
	run.Stderr = stderr
	run.Stdout = stdout

	err := run.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("the stub must exit non-zero, got %v", err)
	}
	if exit.ExitCode() != exitUnsupported {
		t.Errorf("exit code %d, want %d (unsupported platform)", exit.ExitCode(), exitUnsupported)
	}
	if stdout.String() != "" {
		t.Errorf("the stub must print no measurement on stdout, got %q", stdout.String())
	}
	message := stderr.String()
	if !strings.Contains(message, "only on Windows") {
		t.Errorf("the stub must say why it cannot run: %q", message)
	}
	if strings.Count(strings.TrimSuffix(message, "\n"), "\n") != 0 {
		t.Errorf("one sentence, one line: %q", message)
	}
}
