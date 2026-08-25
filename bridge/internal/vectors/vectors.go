// Package vectors loads the golden contract fixture both sides of the Vex
// Studio wire run as a table test.
//
// The fixture is `src/vex-agent/tools/tool-surface-spec/studio-mcp/
// bridge-endpoint-vectors.json`, reached by a RELATIVE path from this
// package's source directory: the bridge is built from inside the repository
// and the fixture is a reviewed wire artifact that travels with it, so a
// missing file is a broken checkout and the loader says so rather than
// skipping. Test-only; nothing in cmd/ imports it.
package vectors

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Path is the fixture's location, derived from this file's own compile-time
// path so a test's working directory cannot change the answer.
func Path() (string, error) {
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("vectors: cannot locate this package's source")
	}
	// bridge/internal/vectors -> repository root.
	root := filepath.Join(filepath.Dir(self), "..", "..", "..")
	return filepath.Join(root, "src", "vex-agent", "tools", "tool-surface-spec",
		"studio-mcp", "bridge-endpoint-vectors.json"), nil
}

// DirFacts is one directory as the endpoint planner sees it. Modes are DECIMAL
// permission bits in the fixture (448 = 0o700), because JSON has no octal
// literal.
type DirFacts struct {
	IsDirectory bool `json:"isDirectory"`
	UID         int  `json:"uid"`
	Mode        int  `json:"mode"`
}

// PlanCase drives both the derivation and the override tables.
type PlanCase struct {
	Name              string              `json:"name"`
	Platform          string              `json:"platform"`
	UID               int                 `json:"uid"`
	Tmpdir            string              `json:"tmpdir"`
	ConfigDirRealPath string              `json:"configDirRealPath"`
	Env               map[string]string   `json:"env"`
	Directories       map[string]DirFacts `json:"directories"`
	Expect            PlanExpect          `json:"expect"`
}

// PlanExpect is the subset of a plan the fixture pins. A field the fixture
// omits is not asserted.
type PlanExpect struct {
	Kind         string  `json:"kind"`
	Path         *string `json:"path"`
	ParentDir    *string `json:"parentDir"`
	CreateParent *bool   `json:"createParent"`
	Code         *string `json:"code"`
}

// ConfigDirCase is one row of the config-directory resolver matrix.
type ConfigDirCase struct {
	Name     string            `json:"name"`
	Platform string            `json:"platform"`
	Homedir  string            `json:"homedir"`
	Env      map[string]string `json:"env"`
	Expect   string            `json:"expect"`
}

// HashCase pins one hash input and its first-12-hex discriminator.
type HashCase struct {
	ConfigDirRealPath string `json:"configDirRealPath"`
	Hash              string `json:"hash"`
	FileName          string `json:"fileName"`
}

// HashRuleCase pins the symlink-evaluation and no-normalisation rules.
type HashRuleCase struct {
	Name        string  `json:"name"`
	Literal     string  `json:"literal"`
	Resolved    *string `json:"resolved"`
	HashOf      string  `json:"hashOf"`
	Hash        string  `json:"hash"`
	LiteralHash string  `json:"literalHash"`
	Cleaned     string  `json:"cleaned"`
	CleanedHash string  `json:"cleanedHash"`
	NFCForm     string  `json:"nfcForm"`
	NFCHash     string  `json:"nfcHash"`
}

// HandshakeCase drives the handshake request-parsing table.
type HandshakeCase struct {
	Name   string `json:"name"`
	Line   string `json:"line"`
	Expect struct {
		Kind      string `json:"kind"`
		ProjectID string `json:"projectId"`
		Remainder string `json:"remainder"`
		Code      string `json:"code"`
	} `json:"expect"`
}

// File is the whole fixture.
type File struct {
	ContractVersion          int            `json:"contractVersion"`
	RealpathFallback         string         `json:"realpathFallback"`
	Limits                   map[string]int `json:"limits"`
	EndpointAncestorIdentity struct {
		Changed struct {
			Code    string `json:"code"`
			Path    string `json:"path"`
			Message string `json:"message"`
		} `json:"changed"`
	} `json:"endpointAncestorIdentity"`
	Hash struct {
		Algorithm        string     `json:"algorithm"`
		Encoding         string     `json:"encoding"`
		FileNameTemplate string     `json:"fileNameTemplate"`
		Cases            []HashCase `json:"cases"`
	} `json:"hash"`
	ConfigDir struct {
		AppName string          `json:"appName"`
		Cases   []ConfigDirCase `json:"cases"`
	} `json:"configDir"`
	HashRules struct {
		Algorithm string         `json:"algorithm"`
		Cases     []HashRuleCase `json:"cases"`
	} `json:"hashRules"`
	Derivation []PlanCase `json:"derivation"`
	Override   []PlanCase `json:"override"`
	Handshake  struct {
		Acks struct {
			Accepted     string   `json:"accepted"`
			RefusalCodes []string `json:"refusalCodes"`
		} `json:"acks"`
		Cases []HandshakeCase `json:"cases"`
	} `json:"handshake"`
}

// Load reads and decodes the fixture. Unknown fields are permitted: the
// fixture carries prose keys ($comment, rules, ...) that are documentation for
// the reviewer rather than data for either implementation.
func Load() (*File, error) {
	path, err := Path()
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("vectors: reading %s: %w", path, err)
	}
	var file File
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("vectors: decoding %s: %w", path, err)
	}
	return &file, nil
}

// GOOS maps the fixture's Node platform vocabulary to Go's.
func GOOS(nodePlatform string) string {
	if nodePlatform == "win32" {
		return "windows"
	}
	return nodePlatform
}
