package main

import (
	"context"
	"errors"
)

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

// dialTimeout is THIS PROCESS giving up on a dial it bounded, as opposed to
// the operating system reporting that the endpoint is not there.
//
// It is not a localRefusal, and the difference is the exit code. A local
// refusal is a decision about the endpoint itself - "that pipe is served by
// another user" - which asking again cannot change, and it exits 2. A busy
// pipe is the endpoint being REACHABLE AND OCCUPIED, which is exit 3's
// documented meaning ("the endpoint did not open, retrying later may work").
// The sentence still carries its own code, exactly as a local refusal's does,
// so a support transcript can match it back to the rule that produced it.
//
// NOTHING WAS WRITTEN when this error is returned: the failure happens inside
// the open, before there is a handle a project id could travel over.
type dialTimeout struct {
	message string
}

func (timeout *dialTimeout) Error() string {
	return timeout.message
}

// asDialTimeout reports whether err is (or wraps) a bounded dial giving up.
func asDialTimeout(err error) (*dialTimeout, bool) {
	var timeout *dialTimeout
	if errors.As(err, &timeout) {
		return timeout, true
	}
	return nil, false
}

// dialInterruptedRefusalCode names the interruption in the sentence, so a
// support transcript can match the message back to this rule.
const dialInterruptedRefusalCode = "windows_pipe_dial_interrupted"

// dialInterrupted is the dial giving up because THIS PROCESS was asked to
// stop, as opposed to the endpoint being busy or absent.
//
// It is not a dialTimeout and it is not a localRefusal: nothing was learned
// about the endpoint at all. A client that supervises this process sees the
// same exit 3 a dial failure gets, and the sentence says which of the two it
// was. It unwraps to context.Canceled so a caller can ask the question in the
// standard vocabulary.
//
// NOTHING WAS WRITTEN when this error is returned: the wait happens inside the
// open, before there is a handle a project id could travel over.
type dialInterrupted struct {
	message string
}

func (interrupted *dialInterrupted) Error() string {
	return interrupted.message
}

func (interrupted *dialInterrupted) Unwrap() error {
	return context.Canceled
}

// asDialInterrupted reports whether err is (or wraps) an interrupted dial.
func asDialInterrupted(err error) (*dialInterrupted, bool) {
	var interrupted *dialInterrupted
	if errors.As(err, &interrupted) {
		return interrupted, true
	}
	return nil, false
}
