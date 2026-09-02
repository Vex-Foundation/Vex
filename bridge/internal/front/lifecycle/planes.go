package lifecycle

import (
	"errors"
	"io"
	"os"
)

// Planes are the four framed streams of protocol section 1, already opened.
//
// Slots 0, 1 and 2 are NOT here. stdin carries nothing and is watched by
// WatchParent; stdout is never written; stderr is the structural log. Putting
// the handshake on plane 3 rather than on stdio is what makes a stray print or
// a panic banner unable to corrupt a framed stream.
type Planes struct {
	// ControlDown is slot 3, main -> front control. Its EOF is TERMINAL.
	ControlDown io.Reader
	// ControlUp is slot 4, front -> main control.
	ControlUp io.Writer
	// DataDown is slot 5, main -> front DATA and END.
	DataDown io.Reader
	// DataUp is slot 6, front -> main DATA and END.
	DataUp io.Writer

	// files are the handles this process owns and must release.
	files []*os.File
}

// ErrPlanesUnsupported is returned by the non-Windows build of Acquire.
var ErrPlanesUnsupported = errors.New("inherited overlapped stdio planes exist only on Windows")

// Close releases every handle Acquire opened, collecting failures instead of
// stopping at the first one (rule 05's teardown order).
func (p *Planes) Close() error {
	var failures []error
	for _, f := range p.files {
		if err := f.Close(); err != nil {
			failures = append(failures, err)
		}
	}
	p.files = nil
	return errors.Join(failures...)
}

// FromFiles builds Planes over four already-open files, in slot order 3, 4, 5,
// 6. It is the seam every platform-independent test uses: os.Pipe pairs stand
// in for the inherited handles, and the supervisor cannot tell the difference.
func FromFiles(controlDown, controlUp, dataDown, dataUp *os.File) *Planes {
	return &Planes{
		ControlDown: controlDown,
		ControlUp:   controlUp,
		DataDown:    dataDown,
		DataUp:      dataUp,
		files:       []*os.File{controlDown, controlUp, dataDown, dataUp},
	}
}
