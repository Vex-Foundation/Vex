package credit

import (
	"errors"
	"testing"
)

func violationName(t *testing.T, err error) string {
	t.Helper()
	var v *Violation
	if !errors.As(err, &v) {
		t.Fatalf("expected a *Violation, got %v", err)
	}
	return v.Name
}

func TestGrantSpendsExactlyWhatWasGranted(t *testing.T) {
	var g Grant
	if g.Outstanding() != 0 || g.ReadBudget() != 0 {
		t.Fatalf("a fresh connection starts with no credit, got %d", g.Outstanding())
	}
	if err := g.Add(WindowBytes); err != nil {
		t.Fatalf("a full window is a legal grant: %v", err)
	}
	if got := g.ReadBudget(); got != ChunkBytes {
		t.Fatalf("the read budget is capped at one chunk, got %d", got)
	}
	if err := g.Spend(ChunkBytes); err != nil {
		t.Fatalf("spending inside the window: %v", err)
	}
	if err := g.Spend(ChunkBytes); err != nil {
		t.Fatalf("spending the rest of the window: %v", err)
	}
	if g.Outstanding() != 0 {
		t.Fatalf("the window is spent, got %d outstanding", g.Outstanding())
	}
	// AT THE CREDIT BOUND THE FRONT STOPS READING. The read budget IS the gate;
	// there is no buffer standing between it and the operating system.
	if got := g.ReadBudget(); got != 0 {
		t.Fatalf("a spent window must close the read gate, got budget %d", got)
	}
}

func TestGrantRefusesOverrunAndDuplicateCredit(t *testing.T) {
	tests := []struct {
		name string
		run  func(g *Grant) error
		want string
	}{
		{
			name: "one byte past the granted credit is credit_overrun",
			run: func(g *Grant) error {
				if err := g.Add(10); err != nil {
					return err
				}
				return g.Spend(11)
			},
			want: NameCreditOverrun,
		},
		{
			name: "a DATA frame of no bytes spends nothing and is refused",
			run:  func(g *Grant) error { return g.Spend(0) },
			want: NameCreditOverrun,
		},
		{
			name: "a grant past the 64 KiB window is duplicate_credit",
			run: func(g *Grant) error {
				if err := g.Add(WindowBytes); err != nil {
					return err
				}
				return g.Add(1)
			},
			want: NameDuplicateCredit,
		},
		{
			name: "a single grant wider than the window is duplicate_credit",
			run:  func(g *Grant) error { return g.Add(WindowBytes + 1) },
			want: NameDuplicateCredit,
		},
		{
			name: "a grant of zero bytes is refused",
			run:  func(g *Grant) error { return g.Add(0) },
			want: NameDuplicateCredit,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var g Grant
			err := tc.run(&g)
			if err == nil {
				t.Fatalf("expected %s", tc.want)
			}
			if got := violationName(t, err); got != tc.want {
				t.Fatalf("got %s, want %s", got, tc.want)
			}
		})
	}
}

// A grant may be replenished after it is spent: the window bounds what is
// OUTSTANDING, not what a connection may transfer over its life.
func TestGrantReplenishesAfterSpending(t *testing.T) {
	var g Grant
	for range 4 {
		if err := g.Add(WindowBytes); err != nil {
			t.Fatalf("replenishing a spent window: %v", err)
		}
		for range 2 {
			if err := g.Spend(ChunkBytes); err != nil {
				t.Fatalf("spending a replenished window: %v", err)
			}
		}
	}
}

func TestWindowIsAHardPerConnectionBoundIncludingInsideOneWrite(t *testing.T) {
	var w Window
	// A 4 MiB logical write is 128 chunks. Only two of them fit in the window
	// at once, which is the whole correction section 6.4 records: one
	// acknowledgement per logical write would have left all 128 outstanding.
	if err := w.Reserve(1, ChunkBytes); err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	if err := w.Reserve(2, ChunkBytes); err != nil {
		t.Fatalf("second chunk: %v", err)
	}
	if w.Outstanding() != WindowBytes {
		t.Fatalf("two chunks fill the window, got %d", w.Outstanding())
	}
	err := w.Reserve(3, 1)
	if err == nil {
		t.Fatal("a third chunk crosses the window and must be refused")
	}
	if got := violationName(t, err); got != NameWriteWindowExceeded {
		t.Fatalf("got %s, want %s", got, NameWriteWindowExceeded)
	}
}

// The acknowledgement is CUMULATIVE: it names the greatest completed sequence
// and releases every window byte through it.
func TestWindowAcknowledgementIsCumulative(t *testing.T) {
	var w Window
	for sequence := uint64(1); sequence <= 4; sequence++ {
		if err := w.Reserve(sequence, 16384); err != nil {
			t.Fatalf("reserving chunk %d: %v", sequence, err)
		}
	}
	if w.Outstanding() != WindowBytes {
		t.Fatalf("four 16 KiB chunks fill the window, got %d", w.Outstanding())
	}
	if err := w.Complete(1); err != nil {
		t.Fatalf("completing chunk 1: %v", err)
	}
	if w.AckThrough() != 1 || w.Outstanding() != 49152 {
		t.Fatalf("after one completion: ack=%d outstanding=%d", w.AckThrough(), w.Outstanding())
	}
	if err := w.Complete(2); err != nil {
		t.Fatalf("completing chunk 2: %v", err)
	}
	if err := w.Complete(3); err != nil {
		t.Fatalf("completing chunk 3: %v", err)
	}
	// One acknowledgement naming 3 releases 1, 2 and 3 together: the front MAY
	// coalesce, and main releases every chunk through the sequence it names.
	if w.AckThrough() != 3 {
		t.Fatalf("the acknowledgement names the greatest completed sequence, got %d", w.AckThrough())
	}
	if w.Outstanding() != 16384 {
		t.Fatalf("only chunk 4 is still outstanding, got %d", w.Outstanding())
	}
	if w.Pending() != 1 {
		t.Fatalf("one chunk still reserved, got %d", w.Pending())
	}
}

func TestWindowRefusesAckRegression(t *testing.T) {
	tests := []struct {
		name string
		run  func(w *Window) error
	}{
		{
			name: "a completion with nothing outstanding",
			run:  func(w *Window) error { return w.Complete(1) },
		},
		{
			name: "a completion out of the order the chunks were written in",
			run: func(w *Window) error {
				if err := w.Reserve(1, 100); err != nil {
					return err
				}
				if err := w.Reserve(2, 100); err != nil {
					return err
				}
				return w.Complete(2)
			},
		},
		{
			name: "a second completion of a sequence already acknowledged",
			run: func(w *Window) error {
				if err := w.Reserve(1, 100); err != nil {
					return err
				}
				if err := w.Complete(1); err != nil {
					return err
				}
				if err := w.Reserve(1, 100); err != nil {
					return err
				}
				return w.Complete(1)
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var w Window
			err := tc.run(&w)
			if err == nil {
				t.Fatal("expected ack_regression")
			}
			if got := violationName(t, err); got != NameAckRegression {
				t.Fatalf("got %s, want %s", got, NameAckRegression)
			}
		})
	}
}

// TWO FLOODING CONNECTIONS AND ONE HEALTHY ONE. The window is PER CONNECTION,
// so a connection that has filled it blocks only itself; the third keeps its
// full window and its full read budget.
func TestWindowsAreIndependentPerConnection(t *testing.T) {
	var flooding [2]Window
	var healthy Window
	for i := range flooding {
		if err := flooding[i].Reserve(1, ChunkBytes); err != nil {
			t.Fatalf("connection %d first chunk: %v", i, err)
		}
		if err := flooding[i].Reserve(2, ChunkBytes); err != nil {
			t.Fatalf("connection %d second chunk: %v", i, err)
		}
		if err := flooding[i].Reserve(3, 1); err == nil {
			t.Fatalf("connection %d must be stopped at its own window", i)
		}
	}
	if err := healthy.Reserve(1, ChunkBytes); err != nil {
		t.Fatalf("the healthy connection keeps flowing: %v", err)
	}
	if healthy.Outstanding() != ChunkBytes {
		t.Fatalf("the healthy connection's window is its own, got %d", healthy.Outstanding())
	}

	var floodingGrants [2]Grant
	var healthyGrant Grant
	for i := range floodingGrants {
		if err := floodingGrants[i].Add(WindowBytes); err != nil {
			t.Fatalf("granting connection %d: %v", i, err)
		}
		if err := floodingGrants[i].Spend(ChunkBytes); err != nil {
			t.Fatalf("connection %d first chunk: %v", i, err)
		}
		if err := floodingGrants[i].Spend(ChunkBytes); err != nil {
			t.Fatalf("connection %d second chunk: %v", i, err)
		}
		if floodingGrants[i].ReadBudget() != 0 {
			t.Fatalf("connection %d must stop reading at its credit bound", i)
		}
	}
	if err := healthyGrant.Add(WindowBytes); err != nil {
		t.Fatalf("granting the healthy connection: %v", err)
	}
	if healthyGrant.ReadBudget() != ChunkBytes {
		t.Fatal("the healthy connection keeps its full read budget while two others flood")
	}
}
