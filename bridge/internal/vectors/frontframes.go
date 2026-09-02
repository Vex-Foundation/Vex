package vectors

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// FrontFramesPath is the pipe-front fixture's location, derived from this
// file's own compile-time path so a test's working directory cannot change the
// answer. Same rule as Path(): the fixture is a reviewed wire artifact that
// travels with the repository, so a missing file is a broken checkout and the
// loader says so rather than skipping.
func FrontFramesPath() (string, error) {
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("vectors: cannot locate this package's source")
	}
	// bridge/internal/vectors -> repository root.
	root := filepath.Join(filepath.Dir(self), "..", "..", "..")
	return filepath.Join(root, "src", "vex-agent", "tools", "tool-surface-spec",
		"studio-mcp", "pipe-front-vectors.json"), nil
}

// FrontExpect is one row's expectation: a decoded frame, or a malformed reason.
// Payload stays RAW so each type's own test builds its own value; a single
// flattened struct would either lose a field or invent one.
type FrontExpect struct {
	Kind       string                     `json:"kind"`
	Reason     string                     `json:"reason"`
	Type       string                     `json:"type"`
	Generation uint32                     `json:"generation"`
	Connection uint32                     `json:"connection"`
	Sequence   string                     `json:"sequence"`
	Payload    map[string]json.RawMessage `json:"payload"`
}

// FrontPrecedence is a multi-fault row's claim: the bytes violate BOTH named
// steps of the frozen validation order, and the expected reason is the EARLIER
// one. Reordering a check turns those rows red on both sides.
type FrontPrecedence struct {
	Earlier string `json:"earlier"`
	Later   string `json:"later"`
}

// FrontUnsatisfiablePair declares an adjacent pair of the validation order no
// frame can violate at once, and how the earlier step is pinned instead. A nil
// ProvenAgainst means the step leads no pair and is pinned as the LATER half of
// its own predecessor's pair.
type FrontUnsatisfiablePair struct {
	Earlier       string  `json:"earlier"`
	Later         string  `json:"later"`
	ProvenAgainst *string `json:"provenAgainst"`
	Why           string  `json:"why"`
}

// FrontFrameCase is one single-frame vector.
type FrontFrameCase struct {
	Name       string           `json:"name"`
	Note       string           `json:"note"`
	Precedence *FrontPrecedence `json:"precedence"`
	// Plane is 3, 4, 5 or 6.
	Plane uint8 `json:"plane"`
	// ExpectedGeneration is the decoder's generation, 0 while the bootstrap
	// pair is expected.
	ExpectedGeneration uint32 `json:"expectedGeneration"`
	// ExpectedSequence is a DECIMAL STRING because it is a u64 and the
	// TypeScript side reads it as a BigInt.
	ExpectedSequence string      `json:"expectedSequence"`
	Hex              string      `json:"hex"`
	Expect           FrontExpect `json:"expect"`
}

// FrontStreamCase is several frames concatenated on one plane, which is what
// split-boundary feeding is exercised against.
type FrontStreamCase struct {
	Name               string        `json:"name"`
	Note               string        `json:"note"`
	Plane              uint8         `json:"plane"`
	ExpectedGeneration uint32        `json:"expectedGeneration"`
	StartSequence      string        `json:"startSequence"`
	Hex                string        `json:"hex"`
	Frames             []FrontExpect `json:"frames"`
}

// FrontHeaderField is one header field's declared position.
type FrontHeaderField struct {
	Name   string `json:"name"`
	Offset int    `json:"offset"`
	Size   int    `json:"size"`
}

// FrontFramesFile is the whole pipe-front fixture.
type FrontFramesFile struct {
	ProtocolVersion int `json:"protocolVersion"`
	Header          struct {
		Bytes          int                `json:"bytes"`
		ByteOrder      string             `json:"byteOrder"`
		Magic          uint32             `json:"magic"`
		MagicWireBytes string             `json:"magicWireBytes"`
		MagicASCII     string             `json:"magicAscii"`
		Fields         []FrontHeaderField `json:"fields"`
	} `json:"header"`
	Planes map[string]uint8 `json:"planes"`
	Limits map[string]int   `json:"limits"`
	Types  struct {
		MainToFrontControl map[string]uint8 `json:"mainToFrontControl"`
		FrontToMainControl map[string]uint8 `json:"frontToMainControl"`
		Data               map[string]uint8 `json:"data"`
	} `json:"types"`
	ConnectionRule struct {
		MustBeZero    []string `json:"mustBeZero"`
		MustBeNonZero []string `json:"mustBeNonZero"`
	} `json:"connectionRule"`
	PeerClosedReasons map[string]uint8 `json:"peerClosedReasons"`
	BoundFlags        map[string]uint8 `json:"boundFlags"`
	// ErrorCodes is the front's CLOSED set of structural failure codes. Main
	// treats a code outside it as a malformed frame.
	ErrorCodes       map[string]uint16 `json:"errorCodes"`
	MalformedReasons []string          `json:"malformedReasons"`
	// ValidationOrder is protocol section 10.1's frozen order, as data. Each
	// step maps to the reasons it can produce through ValidationOrderReasons.
	ValidationOrder                   []string                 `json:"validationOrder"`
	ValidationOrderReasons            map[string][]string      `json:"validationOrderReasons"`
	ValidationOrderUnsatisfiablePairs []FrontUnsatisfiablePair `json:"validationOrderUnsatisfiablePairs"`
	Frames                            []FrontFrameCase         `json:"frames"`
	Streams                           []FrontStreamCase        `json:"streams"`
}

// LoadFrontFrames reads and decodes the pipe-front fixture. Unknown fields are
// permitted: the fixture carries prose keys ($comment, note, ...) that are
// documentation for the reviewer rather than data for either implementation.
func LoadFrontFrames() (*FrontFramesFile, error) {
	path, err := FrontFramesPath()
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("vectors: reading %s: %w", path, err)
	}
	var file FrontFramesFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("vectors: decoding %s: %w", path, err)
	}
	return &file, nil
}
