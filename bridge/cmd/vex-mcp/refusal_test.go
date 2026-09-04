package main

import (
	"errors"
	"fmt"
	"testing"
)

// A LOCAL REFUSAL MUST NOT BE READ AS A DIAL FAILURE. run() picks exit 2 over
// exit 3 from this classification alone, so the classification is the test:
// an unwrapped refusal, a wrapped one, and everything else.
func TestAsLocalRefusalClassifiesOnlyRefusals(t *testing.T) {
	refusal := &localRefusal{message: "windows_host_not_current_user: nope."}

	if got, ok := asLocalRefusal(refusal); !ok || got != refusal {
		t.Fatalf("a bare local refusal was not classified as one: %v, %v", got, ok)
	}
	wrapped := fmt.Errorf("dial: %w", refusal)
	got, ok := asLocalRefusal(wrapped)
	if !ok || got != refusal {
		t.Fatalf("a wrapped local refusal was not classified as one: %v, %v", got, ok)
	}
	if got.Error() != refusal.message {
		t.Fatalf("the refusal message changed: %q", got.Error())
	}
	if _, ok := asLocalRefusal(errors.New("connection refused")); ok {
		t.Fatal("an ordinary transport error was classified as a local refusal; it would " +
			"report exit 2 for a failure the user should see as exit 3")
	}
	if _, ok := asLocalRefusal(nil); ok {
		t.Fatal("nil was classified as a local refusal")
	}
}
