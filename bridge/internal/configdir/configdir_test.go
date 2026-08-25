package configdir_test

import (
	"testing"

	"github.com/Vex-Foundation/vex/bridge/internal/configdir"
	"github.com/Vex-Foundation/vex/bridge/internal/vectors"
)

// The config-directory resolver is the highest-divergence seam on this wire:
// the endpoint hash is taken over its result, so a difference of one separator
// between this package and the two Node owners is a bridge that dials a path
// the app never bound. The three run the SAME table.
func TestResolveMatchesGoldenVectors(t *testing.T) {
	file, err := vectors.Load()
	if err != nil {
		t.Fatalf("loading the golden vectors: %v", err)
	}
	if len(file.ConfigDir.Cases) == 0 {
		t.Fatal("the fixture carries no configDir cases; the resolver would be unpinned")
	}
	if file.ConfigDir.AppName != configdir.AppName {
		t.Fatalf("app name: fixture %q, package %q", file.ConfigDir.AppName, configdir.AppName)
	}

	for _, testCase := range file.ConfigDir.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			got := configdir.Resolve(
				vectors.GOOS(testCase.Platform),
				testCase.Homedir,
				configdir.Env(testCase.Env),
			)
			if got != testCase.Expect {
				t.Fatalf("resolved %q, the contract says %q", got, testCase.Expect)
			}
		})
	}
}

// The specific defect the hardening closed: an empty XDG_CONFIG_HOME used to
// join into the RELATIVE path "vex", putting the config directory in whatever
// working directory the launcher happened to have.
func TestEmptyEnvNeverProducesARelativeDirectory(t *testing.T) {
	for name, env := range map[string]configdir.Env{
		"empty XDG_CONFIG_HOME":  {"XDG_CONFIG_HOME": ""},
		"empty VEX_CONFIG_DIR":   {"VEX_CONFIG_DIR": ""},
		"blank-ish XDG relative": {"XDG_CONFIG_HOME": "config"},
	} {
		t.Run(name, func(t *testing.T) {
			got := configdir.Resolve("linux", "/home/alice", env)
			if got != "/home/alice/.config/vex" {
				t.Fatalf("got %q, want the home fallback", got)
			}
		})
	}
	got := configdir.Resolve("windows", `C:\Users\alice`, configdir.Env{"APPDATA": ""})
	if got != `C:\Users\alice\AppData\Roaming\vex` {
		t.Fatalf("windows empty APPDATA gave %q", got)
	}
}

// An accepted VEX_CONFIG_DIR is returned VERBATIM. A trailing separator is a
// different string, therefore a different hash, therefore a different endpoint,
// and the resolver must not tidy it away on one side of the wire only.
func TestAcceptedOverrideIsVerbatim(t *testing.T) {
	for _, value := range []string{"/srv/vexstate", "/srv/vexstate/", "/srv//vexstate/./"} {
		got := configdir.Resolve("linux", "/home/alice", configdir.Env{"VEX_CONFIG_DIR": value})
		if got != value {
			t.Fatalf("override %q came back as %q", value, got)
		}
	}
}
