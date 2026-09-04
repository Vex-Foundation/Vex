package main

import "errors"

// localRefusal is a decision THIS process made about the endpoint, as opposed
// to a transport failure the operating system reported.
//
// The distinction is an exit code, and it is load-bearing: a supervising
// client reads exit 3 as "the endpoint did not open, retrying later may work"
// and exit 2 as "Vex refused this endpoint, and the reason is in the message".
// Windows host authentication (hostauth_windows.go) is a refusal in that
// second sense - the pipe DID open, and the bridge chose not to use it - so
// it must not be reported as a dial failure.
//
// The message is the whole diagnostic, already prefixed with its refusal code
// exactly as endpoint's local refusals are, because a refusal that reaches
// the user without its code is a sentence a support transcript cannot match
// back to a rule.
type localRefusal struct {
	message string
}

func (refusal *localRefusal) Error() string {
	return refusal.message
}

// asLocalRefusal reports whether err is (or wraps) a local refusal.
func asLocalRefusal(err error) (*localRefusal, bool) {
	var refusal *localRefusal
	if errors.As(err, &refusal) {
		return refusal, true
	}
	return nil, false
}
