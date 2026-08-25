package endpoint_test

import (
	"os"
	"strings"
	"testing"

	"github.com/Vex-Foundation/vex/bridge/internal/configdir"
	"github.com/Vex-Foundation/vex/bridge/internal/endpoint"
	"github.com/Vex-Foundation/vex/bridge/internal/vectors"
)

// THE DEFECT THIS FILE CLOSES.
//
// Derive answers for a TARGET goos that arrives as a parameter, but it used to
// build its paths with `filepath.Join` and `filepath.Dir`, which follow the
// HOST. On Linux the two coincide, so every test was green; on the required
// `bridge-windows` job the same linux and darwin vectors run on a Windows
// runner, where `filepath.Join("/run/user/1000", name)` is
// `\run\user\1000\...` and `filepath.Dir("/srv/sockets/x.sock")` is
// `\srv\sockets`. That is a red job, and in a shipped Windows-hosted build it
// would be a bridge dialling a path the app never bound.
//
// These tests are the host-independent proof, and they are worth running from
// Linux precisely BECAUSE they do not depend on the host: the first is a
// static gate over the source, and the rest exercise both target directions
// through pure lexical functions whose output is a function of the target
// alone.

// The static gate. A host-flavoured path call in endpoint derivation is the
// defect itself, so it is refused by name rather than left to a runner on
// another operating system to discover.
//
// filepath.EvalSymlinks is exempt and named: it is real I/O against the real
// local filesystem in HashInput, which is host business by definition.
func TestEndpointDerivationUsesNoHostFlavouredPathCalls(t *testing.T) {
	source, err := os.ReadFile("endpoint.go")
	if err != nil {
		t.Fatalf("reading endpoint.go: %v", err)
	}
	for _, forbidden := range []string{"filepath.Join(", "filepath.Dir(", "filepath.Clean(", "filepath.Base(", "filepath.IsAbs("} {
		if strings.Contains(string(source), forbidden) {
			t.Errorf("endpoint.go calls %s: it is HOST-flavoured, and this package "+
				"plans for a TARGET goos. Use the configdir lexical helpers.", forbidden)
		}
	}
	if !strings.Contains(string(source), "filepath.EvalSymlinks(") {
		t.Error("the exemption comment names filepath.EvalSymlinks, but the call is gone; " +
			"update the comment above with the real remaining host call, or drop the import")
	}
}

// BOTH DIRECTIONS, from one host. Every derivation and override vector is
// replayed and its separators are asserted against the TARGET's flavour, not
// the host's. On this Linux machine the unix rows would pass even with the
// old host-flavoured code; the assertion that closes the gap is that they are
// checked against a target-derived expectation, so the identical assertions
// hold byte for byte when the same table runs on the Windows runner.
func TestPlansCarryTheTargetFlavourNotTheHostFlavour(t *testing.T) {
	file := load(t)
	seen := map[string]int{}
	for _, table := range [][]vectors.PlanCase{file.Derivation, file.Override} {
		for _, testCase := range table {
			testCase := testCase
			t.Run(testCase.Name, func(t *testing.T) {
				plan := derivePlan(testCase)
				seen[testCase.Platform]++
				switch plan.Kind {
				case endpoint.KindUnix:
					// A unix-target plan is posix all the way through: no
					// backslash may appear anywhere in the path or its parent,
					// whatever the host's separator is.
					if strings.Contains(plan.Path, `\`) {
						t.Errorf("unix path %q carries a backslash: this is a host separator leak", plan.Path)
					}
					if strings.Contains(plan.ParentDir, `\`) {
						t.Errorf("unix parentDir %q carries a backslash", plan.ParentDir)
					}
					if !strings.HasPrefix(plan.Path, "/") {
						t.Errorf("unix path %q is not rooted at /", plan.Path)
					}
				case endpoint.KindPipe:
					// A pipe name is win32 vocabulary and must never acquire a
					// forward slash from a posix host.
					if strings.Contains(plan.Path, "/") {
						t.Errorf("pipe name %q carries a forward slash", plan.Path)
					}
					if !endpoint.IsWindowsPipePath(plan.Path) {
						t.Errorf("pipe name %q fails the package's own syntax rule", plan.Path)
					}
				}
			})
		}
	}
	// The table is only a two-direction proof if it actually carries both
	// directions. A future edit that drops the win32 rows would silently turn
	// this into a posix-only test.
	if seen["win32"] == 0 {
		t.Error("no win32 vector rows: this test proves only one direction")
	}
	if seen["linux"] == 0 && seen["darwin"] == 0 {
		t.Error("no unix vector rows: this test proves only one direction")
	}
}

// The unix derivation sites, asserted against the TARGET-flavoured join
// directly. This is the assertion that a Windows host cannot change: both
// sides of the comparison are pure functions of the target.
func TestUnixDerivationMatchesThePosixJoin(t *testing.T) {
	const configDir = "/home/alice/.config/vex"
	name := endpoint.FileName(configDir)

	runtimeDir := "/run/user/1000"
	plan := endpoint.Derive(endpoint.Input{
		GOOS:               "linux",
		ConfigDirHashInput: configDir,
		Env:                map[string]string{"XDG_RUNTIME_DIR": runtimeDir},
		Tmpdir:             "/tmp",
		UID:                1000,
		ProbeDirectory: func(dir string) *endpoint.DirFacts {
			if dir != runtimeDir {
				return nil
			}
			return &endpoint.DirFacts{IsDirectory: true, UID: 1000, Mode: 0o700}
		},
	})
	if want := configdir.JoinPosix(runtimeDir, name); plan.Path != want {
		t.Errorf("XDG path %q, posix join gives %q", plan.Path, want)
	}

	fallback := endpoint.Derive(endpoint.Input{
		GOOS:               "darwin",
		ConfigDirHashInput: configDir,
		Env:                map[string]string{},
		Tmpdir:             "/var/folders/ab/T",
		UID:                501,
		ProbeDirectory:     func(string) *endpoint.DirFacts { return nil },
	})
	wantParent := configdir.JoinPosix("/var/folders/ab/T", "vex-studio-501")
	if fallback.ParentDir != wantParent {
		t.Errorf("tmpdir parent %q, posix join gives %q", fallback.ParentDir, wantParent)
	}
	if want := configdir.JoinPosix(wantParent, name); fallback.Path != want {
		t.Errorf("tmpdir path %q, posix join gives %q", fallback.Path, want)
	}
}

// The override parent, which is `path.posix.dirname` on the host side and must
// be the same bytes here. Go's `path.Dir` would Clean the doubled separator
// away and the two sides would report different directories for the same
// operator literal; `filepath.Dir` on Windows would additionally return
// `\srv\sockets`.
func TestOverrideParentIsThePosixDirname(t *testing.T) {
	for _, testCase := range []struct {
		override string
		parent   string
	}{
		{"/srv/sockets/vex.sock", "/srv/sockets"},
		{"/srv//sockets/vex.sock", "/srv//sockets"},
		{"/vex.sock", "/"},
	} {
		plan := endpoint.Derive(endpoint.Input{
			GOOS:               "linux",
			ConfigDirHashInput: "/home/alice/.config/vex",
			Env:                map[string]string{endpoint.OverrideEnv: testCase.override},
			Tmpdir:             "/tmp",
			UID:                1000,
			ProbeDirectory: func(dir string) *endpoint.DirFacts {
				if dir != testCase.parent {
					return nil
				}
				return &endpoint.DirFacts{IsDirectory: true, UID: 1000, Mode: 0o700}
			},
		})
		if plan.Kind != endpoint.KindUnix {
			t.Errorf("override %q: kind %q (%s); the probe answers only for the "+
				"posix dirname %q, so any other spelling refuses",
				testCase.override, plan.Kind, plan.Message, testCase.parent)
			continue
		}
		if plan.ParentDir != testCase.parent {
			t.Errorf("override %q: parentDir %q, posix dirname is %q",
				testCase.override, plan.ParentDir, testCase.parent)
		}
		if got := configdir.DirnamePosix(testCase.override); got != testCase.parent {
			t.Errorf("DirnamePosix(%q) = %q, want %q", testCase.override, got, testCase.parent)
		}
	}
}

func derivePlan(testCase vectors.PlanCase) endpoint.Plan {
	return endpoint.Derive(endpoint.Input{
		GOOS:               vectors.GOOS(testCase.Platform),
		ConfigDirHashInput: testCase.ConfigDirRealPath,
		Env:                testCase.Env,
		Tmpdir:             testCase.Tmpdir,
		UID:                testCase.UID,
		ProbeDirectory: func(dir string) *endpoint.DirFacts {
			facts, present := testCase.Directories[dir]
			if !present {
				return nil
			}
			return &endpoint.DirFacts{
				IsDirectory: facts.IsDirectory,
				UID:         facts.UID,
				Mode:        uint32(facts.Mode),
			}
		},
	})
}
