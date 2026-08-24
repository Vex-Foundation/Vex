package endpoint_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Vex-Foundation/vex/bridge/internal/endpoint"
	"github.com/Vex-Foundation/vex/bridge/internal/vectors"
)

func load(t *testing.T) *vectors.File {
	t.Helper()
	file, err := vectors.Load()
	if err != nil {
		t.Fatalf("loading the golden vectors: %v", err)
	}
	if file.ContractVersion != 1 {
		t.Fatalf("the fixture is contract v%d; this bridge speaks v1", file.ContractVersion)
	}
	return file
}

func TestHashVectors(t *testing.T) {
	file := load(t)
	if file.Hash.Algorithm != "sha256" {
		t.Fatalf("hash algorithm: %q", file.Hash.Algorithm)
	}
	for _, testCase := range file.Hash.Cases {
		if got := endpoint.Hash(testCase.ConfigDirRealPath); got != testCase.Hash {
			t.Errorf("hash(%q) = %q, contract says %q", testCase.ConfigDirRealPath, got, testCase.Hash)
		}
		if got := endpoint.FileName(testCase.ConfigDirRealPath); got != testCase.FileName {
			t.Errorf("fileName(%q) = %q, contract says %q", testCase.ConfigDirRealPath, got, testCase.FileName)
		}
	}
}

// The frozen hash rules: the exact bytes, with no BOM, newline, case folding,
// Unicode normalisation, separator conversion or Clean applied by either side.
func TestHashRuleVectors(t *testing.T) {
	file := load(t)
	if len(file.HashRules.Cases) == 0 {
		t.Fatal("the fixture carries no hashRules cases")
	}
	for _, testCase := range file.HashRules.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			subject := testCase.Literal
			if testCase.HashOf == "resolved" {
				if testCase.Resolved == nil {
					t.Fatal(`hashOf is "resolved" but the case names no resolved path`)
				}
				subject = *testCase.Resolved
			}
			if got := endpoint.Hash(subject); got != testCase.Hash {
				t.Fatalf("hash(%q) = %q, contract says %q", subject, got, testCase.Hash)
			}
			// Each optional companion hash exists to make a NEGATIVE rule
			// executable: the forbidden transform must produce a different
			// endpoint, or the rule would be untestable prose.
			for label, pair := range map[string][2]string{
				"symlink resolution changes the endpoint": {testCase.LiteralHash, testCase.Hash},
				"Clean changes the endpoint":              {testCase.CleanedHash, testCase.Hash},
				"NFC normalisation changes the endpoint":  {testCase.NFCHash, testCase.Hash},
			} {
				if pair[0] == "" {
					continue
				}
				if pair[0] == pair[1] {
					t.Errorf("%s: the fixture claims %q for both forms", label, pair[0])
				}
			}
			if testCase.Cleaned != "" && endpoint.Hash(testCase.Cleaned) != testCase.CleanedHash {
				t.Errorf("the cleaned form's hash drifted from the fixture")
			}
			if testCase.NFCForm != "" && endpoint.Hash(testCase.NFCForm) != testCase.NFCHash {
				t.Errorf("the NFC form's hash drifted from the fixture")
			}
		})
	}
}

// HashInput's two branches, against the real filesystem. The literal branch is
// every first run, before the config directory exists.
func TestHashInputResolvesOrFallsBackToTheLiteral(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	if err := os.Mkdir(real, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("this filesystem does not support symlinks: %v", err)
	}
	resolvedReal, err := filepath.EvalSymlinks(real)
	if err != nil {
		t.Fatal(err)
	}
	if got := endpoint.HashInput(link); got != resolvedReal {
		t.Fatalf("a symlinked config directory resolved to %q, want %q", got, resolvedReal)
	}

	// Unresolvable: the ORIGINAL literal, with NO Clean. The dotted spelling
	// proves the "no Clean" half - a Clean would collapse it.
	missing := filepath.Join(dir, "absent", ".", "vex")
	if got := endpoint.HashInput(missing); got != missing {
		t.Fatalf("an unresolvable path became %q, want the literal %q", got, missing)
	}
}

func TestFallbackIsFrozenAsLiteral(t *testing.T) {
	if got := load(t).RealpathFallback; got != "literal" {
		t.Fatalf("realpathFallback is %q; this bridge implements the literal fallback", got)
	}
}

func TestBoundsMatchTheFixture(t *testing.T) {
	file := load(t)
	if file.Limits["sunPathMaxBytes"] != endpoint.SunPathMaxBytes {
		t.Errorf("sunPathMaxBytes: fixture %d, package %d",
			file.Limits["sunPathMaxBytes"], endpoint.SunPathMaxBytes)
	}
}

func TestDerivationAndOverrideVectors(t *testing.T) {
	file := load(t)
	for _, table := range []struct {
		label string
		cases []vectors.PlanCase
	}{
		{"derivation", file.Derivation},
		{"override", file.Override},
	} {
		if len(table.cases) == 0 {
			t.Fatalf("the fixture carries no %s cases", table.label)
		}
		for _, testCase := range table.cases {
			t.Run(table.label+" - "+testCase.Name, func(t *testing.T) {
				assertPlan(t, testCase)
			})
		}
	}
}

func assertPlan(t *testing.T, testCase vectors.PlanCase) {
	t.Helper()
	plan := endpoint.Derive(endpoint.Input{
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

	if string(plan.Kind) != testCase.Expect.Kind {
		t.Fatalf("kind %q, contract says %q (%s)", plan.Kind, testCase.Expect.Kind, plan.Message)
	}
	if want := testCase.Expect.Path; want != nil && plan.Path != *want {
		t.Errorf("path %q, contract says %q", plan.Path, *want)
	}
	if want := testCase.Expect.ParentDir; want != nil && plan.ParentDir != *want {
		t.Errorf("parentDir %q, contract says %q", plan.ParentDir, *want)
	}
	if want := testCase.Expect.CreateParent; want != nil && plan.CreateParent != *want {
		t.Errorf("createParent %v, contract says %v", plan.CreateParent, *want)
	}
	if want := testCase.Expect.Code; want != nil && string(plan.Code) != *want {
		t.Errorf("code %q, contract says %q", plan.Code, *want)
	}
	if plan.Kind == endpoint.KindRefused && len(plan.Message) < 40 {
		t.Errorf("a refusal must carry a sentence that names the remedy; got %q", plan.Message)
	}
}

// Windows DERIVES a named pipe, from the same hash input as the unix socket.
//
// This replaces the `windows_probe_pending` refusal (owner decision, plan
// revision-log item 47). The pattern is VS Code's, verified in the reference
// checkout: `createStaticIPCHandle` serves the main IPC on win32 as a named
// pipe with a hash-derived predictable name through plain `createServer().
// listen`, and `src/vs/base` plus `src/vs/platform` contain zero
// security-descriptor handling. The security model is the documented Windows
// default pipe SD plus protocol-level validation, and Vex adds the
// unlock-bound listener, the handshake ack and approval gating on top.
//
// WHAT THIS TEST CAN PROVE FROM LINUX: derivation, syntax and the plan shape.
// The second-user duplex-denial test and a native pipe round trip run on a
// WINDOWS RUNNER and are the merge gate before any Windows host ships.
func TestWindowsDerivesANamedPipe(t *testing.T) {
	derive := func(env map[string]string) endpoint.Plan {
		return endpoint.Derive(endpoint.Input{
			GOOS:               "windows",
			ConfigDirHashInput: `C:\Users\alice\AppData\Roaming\vex`,
			Env:                env,
			Tmpdir:             `C:\Temp`,
			UID:                -1,
			ProbeDirectory:     func(string) *endpoint.DirFacts { return nil },
		})
	}
	plan := derive(nil)
	if plan.Kind != endpoint.KindPipe {
		t.Fatalf("windows without an override: %+v", plan)
	}
	want := `\\.\pipe\vex-studio-` + endpoint.Hash(`C:\Users\alice\AppData\Roaming\vex`)
	if plan.Path != want {
		t.Fatalf("pipe name %q, want %q", plan.Path, want)
	}
	// The derived name must satisfy the SAME syntax rule an override is held
	// to, or the host and the bridge would disagree about their own endpoint.
	if !endpoint.IsWindowsPipePath(plan.Path) {
		t.Fatalf("the derived pipe name is not a valid pipe path: %q", plan.Path)
	}
	// A pipe is not a filesystem object: no parent directory, and nothing for
	// the host to create or verify.
	if plan.ParentDir != "" || plan.CreateParent {
		t.Fatalf("a pipe plan carries filesystem obligations: %+v", plan)
	}

	// An override still wins, and is still validated structurally.
	plan = derive(map[string]string{endpoint.OverrideEnv: `\\.\pipe\vex-studio`})
	if plan.Kind != endpoint.KindPipe || plan.Path != `\\.\pipe\vex-studio` {
		t.Fatalf("a valid pipe override: %+v", plan)
	}
	plan = derive(map[string]string{endpoint.OverrideEnv: `\\.\pipe\a\b`})
	if plan.Code != endpoint.RefuseOverrideInvalidPipe {
		t.Fatalf("a malformed pipe override: %+v", plan)
	}
}

// The discriminator is transport-independent: the pipe and the socket name the
// SAME config directory, so a user who moves between platforms cannot end up
// with two endpoints for one Vex.
func TestPipeNameAndFileNameShareTheDiscriminator(t *testing.T) {
	const dir = `C:\Users\alice\AppData\Roaming\vex`
	hash := endpoint.Hash(dir)
	if got := endpoint.PipeName(dir); got != `\\.\pipe\vex-studio-`+hash {
		t.Fatalf("PipeName(%q) = %q", dir, got)
	}
	if got := endpoint.FileName(dir); got != "vex-studio-"+hash+".sock" {
		t.Fatalf("FileName(%q) = %q", dir, got)
	}
}

func TestWindowsPipeSyntax(t *testing.T) {
	for value, want := range map[string]bool{
		`\\.\pipe\vex-studio`: true,
		`\\?\pipe\vex-studio`: true,
		`\\.\pipe\`:           false,
		`\\.\pipe\a\b`:        false,
		`\\.\pipe\a/b`:        false,
		`\\.\notpipe\x`:       false,
		"/tmp/vex.sock":       false,
	} {
		if got := endpoint.IsWindowsPipePath(value); got != want {
			t.Errorf("IsWindowsPipePath(%q) = %v, want %v", value, got, want)
		}
	}
}

// ProbeFilesystem uses LSTAT, and this is the test that proves it: a symlink
// pointing at a real 0700 directory this user owns must NOT be reported as a
// private directory.
//
// The defect this closes is not theoretical. `os.Stat` follows the link and
// reports the TARGET's ownership and mode, so any other local user who could
// create `/tmp/vex-studio-<uid>` first - or plant a link at an override's
// parent - would have handed the bridge a "verified private" directory it
// never verified. The host has used `lstatSync` since stage A4a; this is the
// bridge side of the same rule (contract section 1.5).
func TestProbeFilesystemDoesNotFollowASymlink(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "real")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatalf("creating the target directory: %v", err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("this filesystem does not support symlinks: %v", err)
	}

	// The control: the real directory IS a private directory.
	direct := endpoint.ProbeFilesystem(target)
	if direct == nil || !direct.IsDirectory {
		t.Fatalf("the target itself did not probe as a directory: %+v", direct)
	}
	if direct.Mode&0o777 != 0o700 {
		t.Fatalf("the target's mode is 0%o, not 0700", direct.Mode&0o777)
	}

	facts := endpoint.ProbeFilesystem(link)
	if facts == nil {
		t.Fatal("the symlink probed as absent; it exists and must be REPORTED, not skipped")
	}
	if facts.IsDirectory {
		t.Fatal("the symlink probed as a DIRECTORY: the probe followed it, which is the " +
			"os.Stat behaviour this test exists to forbid")
	}
}

// The refusal the symlink probe produces, through the planner rather than the
// probe alone: a symlinked XDG_RUNTIME_DIR is not private, so the plan falls
// through to the tmpdir form instead of binding inside the link.
func TestSymlinkedRuntimeDirIsNotPrivate(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "run")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatalf("creating the runtime directory: %v", err)
	}
	link := filepath.Join(root, "run-link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("this filesystem does not support symlinks: %v", err)
	}

	plan := endpoint.Derive(endpoint.Input{
		GOOS:               "linux",
		ConfigDirHashInput: "/home/alice/.config/vex",
		Env:                map[string]string{"XDG_RUNTIME_DIR": link},
		Tmpdir:             "/tmp",
		UID:                os.Getuid(),
		ProbeDirectory:     endpoint.ProbeFilesystem,
	})
	if plan.Kind != endpoint.KindUnix {
		t.Fatalf("plan kind %q (%s)", plan.Kind, plan.Code)
	}
	if plan.ParentDir == link {
		t.Fatal("the plan bound inside the SYMLINK; a link is not a private runtime directory")
	}
	if !plan.CreateParent {
		t.Fatal("the plan did not fall through to the host-owned tmpdir form")
	}
}

// The same rule at the OVERRIDE's parent, where the refusal is named rather
// than a fall-through: an override's parent that is a symlink is not a
// directory, so the plan says so instead of validating the link's target.
func TestSymlinkedOverrideParentIsRefusedByName(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "real")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatalf("creating the target directory: %v", err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("this filesystem does not support symlinks: %v", err)
	}

	plan := endpoint.Derive(endpoint.Input{
		GOOS:               "linux",
		ConfigDirHashInput: "/home/alice/.config/vex",
		Env:                map[string]string{endpoint.OverrideEnv: filepath.Join(link, "s.sock")},
		Tmpdir:             "/tmp",
		UID:                os.Getuid(),
		ProbeDirectory:     endpoint.ProbeFilesystem,
	})
	if plan.Kind != endpoint.KindRefused {
		t.Fatalf("the plan accepted a symlinked override parent: %+v", plan)
	}
	if plan.Code != endpoint.RefuseOverrideParentNotDir {
		t.Fatalf("refusal code %q, want %q", plan.Code, endpoint.RefuseOverrideParentNotDir)
	}
}

// THE WINDOWS TRANSPORT IS PLANNED BUT NOT OPENED (contract 1.6).
//
// The two halves are asserted together on purpose: the derivation, the pipe
// name and the override syntax must keep working exactly as the vectors pin
// them, AND the transport must be refused by name. A change that disabled
// Windows by breaking the plan would pass one half and fail this test.
func TestWindowsTransportIsGatedUntilProven(t *testing.T) {
	if endpoint.WindowsTransportProven {
		t.Fatal("WindowsTransportProven is true; it may only be flipped by extending " +
			"the required bridge-windows CI job with the contract 1.6 proof matrix")
	}

	plan := endpoint.Derive(endpoint.Input{
		GOOS:               "windows",
		ConfigDirHashInput: `C:\Users\alice\AppData\Roaming\vex`,
		Env:                map[string]string{},
		Tmpdir:             `C:\Temp`,
		UID:                -1,
		ProbeDirectory:     func(string) *endpoint.DirFacts { return nil },
	})
	// The PATTERN survives the gate: still a pipe, still the derived name.
	if plan.Kind != endpoint.KindPipe {
		t.Fatalf("the windows plan is %+v; derivation must be unchanged", plan)
	}

	gated := endpoint.UnprovenWindowsTransport(plan)
	if gated == nil {
		t.Fatal("a pipe plan must be refused while the transport is unproven")
	}
	if gated.Kind != endpoint.KindRefused {
		t.Fatalf("the gate returned kind %q", gated.Kind)
	}
	if gated.Code != endpoint.RefuseWindowsPendingPlatformProof {
		t.Fatalf("the gate refused with %q, want %q",
			gated.Code, endpoint.RefuseWindowsPendingPlatformProof)
	}
	if len(gated.Message) < 40 {
		t.Fatalf("the refusal must carry a sentence naming the remedy; got %q", gated.Message)
	}

	// A UNIX plan is untouched by the gate: this refuses one transport, not
	// every plan that reaches it.
	unix := endpoint.Derive(endpoint.Input{
		GOOS:               "linux",
		ConfigDirHashInput: "/home/alice/.config/vex",
		Env:                map[string]string{},
		Tmpdir:             "/tmp",
		UID:                1000,
		ProbeDirectory:     func(string) *endpoint.DirFacts { return nil },
	})
	if unix.Kind != endpoint.KindUnix {
		t.Fatalf("the linux plan is %+v", unix)
	}
	if endpoint.UnprovenWindowsTransport(unix) != nil {
		t.Fatal("the windows gate refused a unix plan")
	}
}

// PIPE SYNTAX IS A WINDOWS-TARGET STATEMENT. The vectors pin the refusal code
// for the three shapes; this pins the rule itself across both unix targets and
// both pipe prefixes, and pins that win32 still ACCEPTS the same values.
func TestPipeOverrideIsRefusedOnEveryUnixTarget(t *testing.T) {
	for _, goos := range []string{"linux", "darwin"} {
		for _, value := range []string{
			`\\.\pipe\vex-studio-abc`,
			`\\?\pipe\vex-studio-abc`,
			`\\.\pipe\`,
			`\\server\share\studio.sock`,
		} {
			plan := endpoint.Derive(endpoint.Input{
				GOOS:               goos,
				ConfigDirHashInput: "/home/alice/.config/vex",
				Env:                map[string]string{endpoint.OverrideEnv: value},
				Tmpdir:             "/tmp",
				UID:                1000,
				ProbeDirectory:     func(string) *endpoint.DirFacts { return nil },
			})
			if plan.Kind != endpoint.KindRefused {
				t.Fatalf("%s + %q planned %+v; a pipe override off win32 must refuse",
					goos, value, plan)
			}
			if plan.Code != endpoint.RefuseOverridePipeOnUnix {
				t.Errorf("%s + %q refused with %q, want %q",
					goos, value, plan.Code, endpoint.RefuseOverridePipeOnUnix)
			}
		}
	}

	// The same value on a win32 TARGET is still the accepted pipe override.
	win := endpoint.Derive(endpoint.Input{
		GOOS:               "windows",
		ConfigDirHashInput: `C:\Users\alice\AppData\Roaming\vex`,
		Env:                map[string]string{endpoint.OverrideEnv: `\\.\pipe\vex-studio-abc`},
		Tmpdir:             `C:\Temp`,
		UID:                -1,
		ProbeDirectory:     func(string) *endpoint.DirFacts { return nil },
	})
	if win.Kind != endpoint.KindPipe || win.Path != `\\.\pipe\vex-studio-abc` {
		t.Fatalf("win32 pipe override planned %+v", win)
	}
}
