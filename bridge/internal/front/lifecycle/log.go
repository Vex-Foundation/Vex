package lifecycle

import (
	"fmt"
	"io"
	"strings"
	"sync"
)

// Field is one structural fact: a NAME the front's own source spells out and a
// NUMBER. There is deliberately no string-valued field.
//
// The type is the enforcement. A logger that accepted `string` values would let
// a peer's bytes, a project id, a security descriptor or a pipe path reach
// stderr through one careless call site, and stderr is a plane main reads and a
// support bundle collects (protocol section 1). Numbers cannot carry any of
// those, and every code below is a compile-time constant in this repository.
type Field struct {
	Name  string
	Value uint64
}

// Num names a numeric structural fact.
func Num(name string, value uint64) Field { return Field{Name: name, Value: value} }

// Flag renders a boolean as 0 or 1 so the log stays one shape.
func Flag(name string, value bool) Field {
	if value {
		return Field{Name: name, Value: 1}
	}
	return Field{Name: name, Value: 0}
}

// Logger writes the front's structural log. It is safe for concurrent use: the
// accept loop, the plane readers and the supervisor all report through it, and
// a torn line would be worse than a lost one.
//
// The OWNER of the underlying writer is the caller that constructed the logger;
// Logger never closes it.
type Logger struct {
	mu  sync.Mutex
	out io.Writer
}

// NewLogger writes structural lines to out, normally os.Stderr.
func NewLogger(out io.Writer) *Logger { return &Logger{out: out} }

// Event records one structural line: `vex-pipe-front <code> name=value ...`.
//
// code is a constant from this repository's own vocabulary - a protocol reason
// (section 10), a named structural failure (section 12.3), or a front lifecycle
// step. A write failure on stderr is DISCARDED: the log is diagnostics, and a
// front that died because its log plane was full would be a worse outcome than
// a missing line.
func (l *Logger) Event(code string, fields ...Field) {
	var b strings.Builder
	b.WriteString("vex-pipe-front ")
	b.WriteString(code)
	for _, f := range fields {
		fmt.Fprintf(&b, " %s=%d", f.Name, f.Value)
	}
	b.WriteByte('\n')

	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = io.WriteString(l.out, b.String())
}
