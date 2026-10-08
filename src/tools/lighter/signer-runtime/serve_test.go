package main

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

const serveTestPrivateKey = "11111111111111111111111111111111111111111111111111111111111111111111111111111111"

const serveTestCreateOrder = `{"operation":"signCreateOrder","privateKey":"` + serveTestPrivateKey + `","chainId":466324,"accountIndex":"42","apiKeyIndex":7,"nonce":"0","order":{"marketIndex":0,"clientOrderIndex":"5","baseAmount":"1000","price":"300000","isAsk":1,"orderType":0,"timeInForce":0,"reduceOnly":0,"triggerPrice":"0","orderExpiry":"0"}}`

const serveTestAccountAuth = `{"operation":"createAccountAuth","privateKey":"` + serveTestPrivateKey + `","chainId":466324,"accountIndex":"42","apiKeyIndex":7,"deadlineUnixSeconds":"1893456600"}`

const serveTestDerive = `{"operation":"derivePublicKey","privateKey":"` + serveTestPrivateKey + `"}`

func runOneShotString(t *testing.T, request string) (map[string]any, int) {
	t.Helper()
	var output bytes.Buffer
	code := runOneShot(strings.NewReader(request), &output)
	return decodeOneLine(t, output.String()), code
}

func decodeOneLine(t *testing.T, raw string) map[string]any {
	t.Helper()
	if !strings.HasSuffix(raw, "\n") || strings.Count(raw, "\n") != 1 {
		t.Fatalf("expected exactly one newline-terminated document, got %q", raw)
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("output is not JSON: %v", err)
	}
	return document
}

func envelope(id string, request string) string {
	return `{"id":"` + id + `","request":` + request + "}\n"
}

func runServeString(t *testing.T, input string) ([]map[string]any, int) {
	t.Helper()
	var output bytes.Buffer
	code := serve(strings.NewReader(input), &output)
	var documents []map[string]any
	for _, line := range strings.Split(strings.TrimSuffix(output.String(), "\n"), "\n") {
		if line == "" {
			continue
		}
		var document map[string]any
		if err := json.Unmarshal([]byte(line), &document); err != nil {
			t.Fatalf("serve output line is not JSON: %v", err)
		}
		documents = append(documents, document)
	}
	return documents, code
}

func withoutID(document map[string]any) map[string]any {
	copied := make(map[string]any, len(document))
	for key, value := range document {
		if key != "id" {
			copied[key] = value
		}
	}
	return copied
}

func assertSameDocument(t *testing.T, label string, got map[string]any, want map[string]any) {
	t.Helper()
	gotJSON, _ := json.Marshal(got)
	wantJSON, _ := json.Marshal(want)
	if !bytes.Equal(gotJSON, wantJSON) {
		t.Fatalf("%s: serve output differs from one-shot output\nserve:    %s\none-shot: %s", label, gotJSON, wantJSON)
	}
}

// withoutRandomness removes the members that legitimately differ between two
// runs of the SAME request in the SAME mode: the Schnorr signature is
// randomized, the SDK defaults ExpiredAt to "now plus its window", and the tx
// hash and auth token cover those. Everything else must be identical.
func withoutRandomness(t *testing.T, document map[string]any) map[string]any {
	t.Helper()
	normalized := withoutID(document)
	if raw, ok := normalized["txInfo"].(string); ok {
		var txInfo map[string]any
		if err := json.Unmarshal([]byte(raw), &txInfo); err != nil {
			t.Fatalf("txInfo is not JSON: %v", err)
		}
		if _, ok := txInfo["Sig"].(string); !ok {
			t.Fatalf("txInfo carries no signature")
		}
		delete(txInfo, "Sig")
		delete(txInfo, "ExpiredAt")
		normalized["txInfo"] = txInfo
		if hash, ok := normalized["txHash"].(string); !ok || hash == "" {
			t.Fatalf("signed response carries no tx hash")
		}
		delete(normalized, "txHash")
	}
	if token, ok := normalized["authToken"].(string); ok {
		parts := strings.Split(token, ":")
		if len(parts) != 4 || parts[3] == "" {
			t.Fatalf("auth token has an unexpected shape")
		}
		normalized["authToken"] = strings.Join(parts[:3], ":")
	}
	return normalized
}

func TestOneShotSigningDiffersBetweenRunsOnlyInItsRandomizedMembers(t *testing.T) {
	first, firstCode := runOneShotString(t, serveTestCreateOrder)
	second, secondCode := runOneShotString(t, serveTestCreateOrder)
	if firstCode != 0 || secondCode != 0 || first["ok"] != true {
		t.Fatalf("one-shot signing failed: %v", first)
	}
	assertSameDocument(t, "one-shot repeat", withoutRandomness(t, second), withoutRandomness(t, first))
}

func TestServeAnswersEachRequestInOrderWithTheOneShotDocument(t *testing.T) {
	requests := []string{serveTestCreateOrder, serveTestAccountAuth, serveTestDerive, `{"operation":"generateApiKey"}`}
	var input strings.Builder
	for index, request := range requests {
		input.WriteString(envelope("r"+string(rune('0'+index)), request))
	}
	documents, code := runServeString(t, input.String())
	if code != 0 {
		t.Fatalf("serve exit code = %d, want 0 at end of input", code)
	}
	if len(documents) != len(requests) {
		t.Fatalf("serve answered %d requests, want %d", len(documents), len(requests))
	}
	for index, request := range requests {
		if documents[index]["id"] != "r"+string(rune('0'+index)) {
			t.Fatalf("response %d carries id %v", index, documents[index]["id"])
		}
		if documents[index]["ok"] != true {
			t.Fatalf("response %d failed: %v", index, documents[index])
		}
		if strings.Contains(request, "generateApiKey") {
			// A fresh random keypair per call: compare the shape, not the bytes.
			if _, ok := documents[index]["privateKey"].(string); !ok {
				t.Fatalf("generated key response lacks a private key")
			}
			continue
		}
		oneShot, oneShotCode := runOneShotString(t, request)
		if oneShotCode != 0 {
			t.Fatalf("one-shot reference failed: %v", oneShot)
		}
		assertSameDocument(t, request[:40], withoutRandomness(t, documents[index]), withoutRandomness(t, oneShot))
	}
}

func TestServeRefusesInvalidRequestsExactlyAsOneShotAndKeepsServing(t *testing.T) {
	invalid := []string{
		`{"operation":"signCreateOrder","privateKey":"zz"}`,
		`{"operation":"nope"}`,
		`{"operation":"generateApiKey","privateKey":"` + serveTestPrivateKey + `"}`,
		`{"operation":"generateApiKey","surprise":1}`,
		strings.Replace(serveTestCreateOrder, `"apiKeyIndex":7`, `"apiKeyIndex":2`, 1),
		strings.Replace(serveTestCreateOrder, `"orderExpiry":"0"`, `"orderExpiry":"5"`, 1),
		`null`,
	}
	var input strings.Builder
	for index, request := range invalid {
		input.WriteString(envelope("bad"+string(rune('a'+index)), request))
	}
	input.WriteString(envelope("after", serveTestDerive))
	documents, code := runServeString(t, input.String())
	if code != 0 || len(documents) != len(invalid)+1 {
		t.Fatalf("serve code=%d answered=%d", code, len(documents))
	}
	for index, request := range invalid {
		oneShot, oneShotCode := runOneShotString(t, request)
		if oneShotCode != 1 || oneShot["ok"] != false {
			t.Fatalf("one-shot reference for %q unexpectedly succeeded", request)
		}
		if documents[index]["id"] != "bad"+string(rune('a'+index)) {
			t.Fatalf("refusal %d carries id %v", index, documents[index]["id"])
		}
		assertSameDocument(t, request, withoutID(documents[index]), oneShot)
	}
	if documents[len(invalid)]["ok"] != true || documents[len(invalid)]["id"] != "after" {
		t.Fatalf("serve stopped answering after refusals: %v", documents[len(invalid)])
	}
}

func TestServeAnswersABrokenEnvelopeWithoutAnIdAndKeepsServing(t *testing.T) {
	lines := []string{
		"not json\n",
		`{"id":"x","request":{"operation":"generateApiKey"},"extra":1}` + "\n",
		`{"id":"bad id!","request":{"operation":"generateApiKey"}}` + "\n",
		`{"id":"","request":{"operation":"generateApiKey"}}` + "\n",
		`{"id":"x"}` + "\n",
		`{"id":"x","request":{"operation":"generateApiKey"}} {"id":"y"}` + "\n",
		"   \n",
		envelope("ok", serveTestDerive),
	}
	documents, code := runServeString(t, strings.Join(lines, ""))
	if code != 0 || len(documents) != 7 {
		t.Fatalf("serve code=%d answered=%d", code, len(documents))
	}
	for index, document := range documents[:6] {
		if document["ok"] != false || document["errorCode"] != "invalid_input" {
			t.Fatalf("broken envelope %d was not refused: %v", index, document)
		}
		// Only a well-formed id is echoed: the envelope without a request.
		wantID := ""
		if index == 4 {
			wantID = "x"
		}
		if document["id"] != wantID {
			t.Fatalf("broken envelope %d carries id %v, want %q", index, document["id"], wantID)
		}
	}
	if documents[6]["ok"] != true || documents[6]["id"] != "ok" {
		t.Fatalf("serve stopped answering after broken envelopes: %v", documents[6])
	}
}

func TestServeNeverExecutesATrailingFragmentWithoutANewline(t *testing.T) {
	input := envelope("one", serveTestDerive) + strings.TrimSuffix(envelope("two", serveTestDerive), "\n")
	documents, code := runServeString(t, input)
	if code != 0 || len(documents) != 1 || documents[0]["id"] != "one" {
		t.Fatalf("code=%d documents=%v", code, documents)
	}
}

func TestServeExitsOnAnOverlongLine(t *testing.T) {
	input := strings.Repeat("x", maxServeLineBytes+10) + "\n" + envelope("later", serveTestDerive)
	documents, code := runServeString(t, input)
	if code != 1 {
		t.Fatalf("serve exit code = %d, want 1 after losing the framing", code)
	}
	if len(documents) != 1 || documents[0]["ok"] != false || documents[0]["id"] != "" {
		t.Fatalf("overlong line answer = %v", documents)
	}
}

func TestServeAnswersAPanicForThatRequestAndThenExits(t *testing.T) {
	original := serveExecute
	t.Cleanup(func() { serveExecute = original })
	serveExecute = func(request signerRequest) (signerResponse, error) {
		panic("boom")
	}
	documents, code := runServeString(t, envelope("p", serveTestDerive)+envelope("never", serveTestDerive))
	if code != 1 {
		t.Fatalf("serve exit code after panic = %d, want 1", code)
	}
	if len(documents) != 1 || documents[0]["id"] != "p" || documents[0]["errorCode"] != "panic" || documents[0]["error"] != panicMessage {
		t.Fatalf("panic answer = %v", documents)
	}
}

func TestServeWipesRequestBytesFromItsLineBuffer(t *testing.T) {
	input := envelope("a", serveTestCreateOrder) + envelope("b", serveTestAccountAuth)
	reader := newServeLineReader(strings.NewReader(input))
	var output bytes.Buffer
	if code := serveLines(reader, &output); code != 0 {
		t.Fatalf("serve exit code = %d", code)
	}
	if bytes.Contains(reader.buf, []byte(serveTestPrivateKey[:16])) {
		t.Fatalf("private key bytes remain in the serve line buffer")
	}
	for _, value := range reader.buf {
		if value != 0 {
			t.Fatalf("serve line buffer is not wiped after end of input")
		}
	}
}

func TestServeStopsWhenTheResponseCannotBeWritten(t *testing.T) {
	code := serve(strings.NewReader(envelope("a", serveTestDerive)+envelope("b", serveTestDerive)), failingWriter{})
	if code != 1 {
		t.Fatalf("serve exit code with a dead parent = %d, want 1", code)
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestOneShotModeStillAnswersOnceAndReportsFailureByExitCode(t *testing.T) {
	ok, okCode := runOneShotString(t, serveTestDerive)
	if okCode != 0 || ok["ok"] != true {
		t.Fatalf("one-shot derive = %v code %d", ok, okCode)
	}
	if _, present := ok["id"]; present {
		t.Fatalf("one-shot output gained an id member")
	}
	refused, refusedCode := runOneShotString(t, `{"operation":"nope"}`)
	if refusedCode != 1 || refused["errorCode"] != "invalid_input" || refused["error"] != "unsupported signer operation" {
		t.Fatalf("one-shot refusal = %v code %d", refused, refusedCode)
	}
	// One-shot reads one document; anything after it is never executed.
	var output bytes.Buffer
	code := runOneShot(strings.NewReader(serveTestDerive+"\n"+serveTestDerive+"\n"), &output)
	if code != 0 || strings.Count(output.String(), "\n") != 1 {
		t.Fatalf("one-shot answered more than one request: %q", output.String())
	}
}
