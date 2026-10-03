package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
)

// Serve mode: one long-lived helper answering many requests.
//
// Framing is newline-delimited JSON. Each input line is one envelope
//
//	{"id":"<request id>","request":{ ...exactly the one-shot request... }}
//
// and each answer is ONE output line: the one-shot response document with the
// request id added as its first member,
//
//	{"id":"<request id>","ok":true,...} or {"id":"<request id>","ok":false,"errorCode":...,"error":...}
//
// The inner request goes through the SAME readRequest and executeRequest as
// one-shot mode, so validation, refusals and signed outputs are identical; only
// the framing differs.
//
// Requests are answered strictly in order and one at a time. The helper never
// does work it was not asked for, so a response line for an id is proof that
// the helper has finished with that request.
//
// Lifecycle:
//   - end of input (the parent closed the pipe or died) ends the loop with 0;
//   - a panic while handling a request is answered with errorCode "panic" for
//     that id and then the helper EXITS 1: a runtime that panicked while
//     holding a key is not trusted with the next one;
//   - an input line longer than maxServeLineBytes loses the framing, so it is
//     answered with an empty id and the helper exits 1;
//   - a response that cannot be written means the parent is gone: exit 1.

// maxServeLineBytes bounds one envelope line: the one-shot request bound plus
// room for the envelope itself.
const maxServeLineBytes = maxInputBytes + 1024

var serveRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

var errServeLineTooLong = errors.New("serve request line too long")

type serveEnvelope struct {
	ID      string          `json:"id"`
	Request json.RawMessage `json:"request"`
}

// serveResponse is the one-shot response with the request id in front. The
// embedded struct is flattened by encoding/json, so every member a one-shot
// caller reads is at the same place.
type serveResponse struct {
	ID string `json:"id"`
	signerResponse
}

// serveLineReader reads newline-terminated lines into ONE fixed buffer that it
// owns, so the bytes of a request (which carry a private key) can be wiped
// after use instead of lingering in a reader's internal buffer until some
// later request happens to overwrite them.
type serveLineReader struct {
	input io.Reader
	buf   []byte
	start int
	end   int
}

func newServeLineReader(input io.Reader) *serveLineReader {
	return &serveLineReader{input: input, buf: make([]byte, maxServeLineBytes+1)}
}

// next returns the next line without its newline. The returned slice aliases
// the reader's buffer and is valid until the following call; the caller wipes
// it when done.
func (reader *serveLineReader) next() ([]byte, error) {
	for {
		if index := bytes.IndexByte(reader.buf[reader.start:reader.end], '\n'); index >= 0 {
			line := reader.buf[reader.start : reader.start+index]
			// The newline itself carries nothing; the line is wiped by the caller.
			reader.start += index + 1
			return line, nil
		}
		if reader.start > 0 {
			remaining := copy(reader.buf, reader.buf[reader.start:reader.end])
			wipe(reader.buf[remaining:reader.end])
			reader.end = remaining
			reader.start = 0
		}
		if reader.end == len(reader.buf) {
			wipe(reader.buf)
			reader.end = 0
			return nil, errServeLineTooLong
		}
		read, err := reader.input.Read(reader.buf[reader.end:])
		reader.end += read
		if err != nil {
			if read > 0 {
				continue
			}
			// A trailing fragment without a newline is never executed.
			wipe(reader.buf)
			reader.start, reader.end = 0, 0
			return nil, err
		}
	}
}

func wipe(data []byte) {
	for index := range data {
		data[index] = 0
	}
}

// serveExecute is the executor serve mode calls; a variable only so a test can
// make it panic. Production never reassigns it.
var serveExecute = executeRequest

// serve runs the request loop and returns the process exit code.
func serve(input io.Reader, output io.Writer) int {
	return serveLines(newServeLineReader(input), output)
}

func serveLines(reader *serveLineReader, output io.Writer) int {
	for {
		line, err := reader.next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return 0
			}
			if errors.Is(err, errServeLineTooLong) {
				_ = writeResponse(output, serveResponse{signerResponse: failureResponse("invalid_input", "serve request line too long")})
			}
			return 1
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		response, keepServing := handleServeLine(line)
		wipe(line)
		if err := writeResponse(output, response); err != nil {
			return 1
		}
		if !keepServing {
			return 1
		}
	}
}

// handleServeLine answers one envelope. keepServing is false only after a
// panic.
func handleServeLine(line []byte) (response serveResponse, keepServing bool) {
	envelope, err := decodeServeEnvelope(line)
	defer wipe(envelope.Request)
	if err != nil {
		return serveResponse{ID: envelope.ID, signerResponse: failureResponse("invalid_input", err.Error())}, true
	}
	response.ID = envelope.ID
	defer func() {
		if recovered := recover(); recovered != nil {
			response = serveResponse{ID: envelope.ID, signerResponse: failureResponse("panic", panicMessage)}
			keepServing = false
		}
	}()
	request, err := readRequest(bytes.NewReader(envelope.Request))
	if err != nil {
		response.signerResponse = failureResponse("invalid_input", err.Error())
		return response, true
	}
	result, err := serveExecute(request)
	if err != nil {
		response.signerResponse = failureResponse("signing_failed", signingFailedMessage)
		return response, true
	}
	response.signerResponse = result
	return response, true
}

func decodeServeEnvelope(line []byte) (serveEnvelope, error) {
	var envelope serveEnvelope
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return serveEnvelope{}, fmt.Errorf("invalid serve request envelope")
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return serveEnvelope{ID: "", Request: envelope.Request}, fmt.Errorf("invalid serve request envelope")
	}
	if !serveRequestIDPattern.MatchString(envelope.ID) {
		return serveEnvelope{ID: "", Request: envelope.Request}, fmt.Errorf("invalid serve request id")
	}
	if len(envelope.Request) == 0 {
		return envelope, fmt.Errorf("missing serve request")
	}
	return envelope, nil
}
