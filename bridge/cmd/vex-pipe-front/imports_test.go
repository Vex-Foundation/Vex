package main

import (
	"os/exec"
	"strings"
	"testing"
)

// THE DEPENDENCY GATE.
//
// This module carried NO third-party dependency at all until the front needed
// go-winio for the named pipe's security descriptor, its message mode and its
// first-instance protection. The claim that replaced "no dependencies" is
// narrower and it is a BINARY-level one:
//
//	cmd/vex-mcp links no third-party package. cmd/vex-pipe-front links
//	go-winio and golang.org/x/sys, and nothing else.
//
// That is the property that matters, and prose cannot hold it: an import added
// three packages deep inside internal/ would put go-winio into the bridge
// binary that ships to end users, and nobody would notice from a diff. So it is
// a test, and it runs the linker's own view of the graph - `go list -deps` -
// for EVERY release GOOS, because a build-tagged file is invisible to the host
// target's graph and the Windows arm is exactly where the risk lives.
//
// x/sys is TRANSITIVE and unavoidable: go-winio's own pipe, security-descriptor
// and SID code is written against it. It is allowed here for that reason and
// for no other, and it is named rather than tolerated.

const modulePrefix = "github.com/Vex-Foundation/vex/bridge/"

// releaseTargets are the operating systems the packaging chain builds. A
// per-GOOS graph is the only way to see a build-tagged import.
var releaseTargets = []string{"linux", "darwin", "windows"}

// allowedByPipeFront is the closed set of third-party modules the front may
// link. Adding to it is a dependency decision, which is what a diff here makes
// visible.
var allowedByPipeFront = map[string]bool{
	"github.com/Microsoft/go-winio": true,
	"golang.org/x/sys":              true,
}

func nonStandardDeps(t *testing.T, goos, pkg string) []string {
	t.Helper()
	cmd := exec.Command("go", "list", "-deps",
		"-f", "{{if not .Standard}}{{.ImportPath}}{{end}}", pkg)
	cmd.Env = append(cmd.Environ(), "GOOS="+goos, "GOTOOLCHAIN=local")
	// STDOUT ONLY. `go list` writes progress such as "go: downloading
	// github.com/Microsoft/go-winio v0.6.2" to STDERR on a cold module cache
	// (every CI runner), and a combined capture read those lines as import
	// paths outside the allowed set. Stderr is kept for the failure message.
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("go list -deps for %s on %s: %v\n%s", pkg, goos, err, stderr.String())
	}
	var deps []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line != "" {
			deps = append(deps, line)
		}
	}
	return deps
}

// modulePathOf reduces an import path to the module it plausibly belongs to, so
// `github.com/Microsoft/go-winio/pkg/guid` is judged as go-winio.
func modulePathOf(importPath string) string {
	for module := range allowedByPipeFront {
		if importPath == module || strings.HasPrefix(importPath, module+"/") {
			return module
		}
	}
	return importPath
}

// THE BRIDGE STAYS PURE. vex-mcp is the binary that ships inside the signed
// bundle and runs on an end user's machine; it links the standard library and
// this module and nothing else, on every target.
func TestVexMCPLinksNoThirdPartyPackage(t *testing.T) {
	for _, goos := range releaseTargets {
		t.Run(goos, func(t *testing.T) {
			for _, dep := range nonStandardDeps(t, goos, "../vex-mcp") {
				if !strings.HasPrefix(dep, modulePrefix) {
					t.Errorf("cmd/vex-mcp on %s links %s; it must link only the standard "+
						"library and %s", goos, dep, modulePrefix)
				}
			}
		})
	}
}

// THE FRONT'S DEPENDENCIES ARE A CLOSED SET, and the same graph proves that
// nothing else in this module has quietly grown one.
func TestPipeFrontLinksOnlyTheAllowedThirdPartyModules(t *testing.T) {
	for _, goos := range releaseTargets {
		t.Run(goos, func(t *testing.T) {
			seen := map[string]bool{}
			for _, dep := range nonStandardDeps(t, goos, ".") {
				if strings.HasPrefix(dep, modulePrefix) {
					continue
				}
				module := modulePathOf(dep)
				if !allowedByPipeFront[module] {
					t.Errorf("cmd/vex-pipe-front on %s links %s, which is not in the "+
						"allowed set", goos, dep)
					continue
				}
				seen[module] = true
			}
			if goos == "windows" && !seen["github.com/Microsoft/go-winio"] {
				t.Error("the Windows front must link go-winio; if it no longer does, " +
					"the dependency and this gate should both go")
			}
			if goos != "windows" && len(seen) != 0 {
				t.Errorf("the non-Windows front is a stub and must link nothing "+
					"third-party, got %v", seen)
			}
		})
	}
}
