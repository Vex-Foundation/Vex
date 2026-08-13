package main

import (
	"strings"
	"testing"
)

func TestSignCreateOrderUsesStringDecimalPayload(t *testing.T) {
	request, err := readRequest(strings.NewReader(`{
		"operation": "signCreateOrder",
		"privateKey": "11111111111111111111111111111111111111111111111111111111111111111111111111111111",
		"chainId": 466324,
		"accountIndex": "42",
		"apiKeyIndex": 7,
		"nonce": "0",
		"order": {
			"marketIndex": 0,
			"clientOrderIndex": "281474976710655",
			"baseAmount": "1000",
			"price": "300000",
			"isAsk": 1,
			"orderType": 0,
			"timeInForce": 1,
			"reduceOnly": 0,
			"triggerPrice": "0",
			"orderExpiry": "1893456000000"
		}
	}`))
	if err != nil {
		t.Fatalf("readRequest() error = %v", err)
	}

	response, err := signCreateOrder(request)
	if err != nil {
		t.Fatalf("signCreateOrder() error = %v", err)
	}

	if !response.OK {
		t.Fatalf("signCreateOrder() returned OK=false")
	}
	if response.TxType != 14 {
		t.Fatalf("TxType = %d, want 14", response.TxType)
	}
	if response.TxInfo == "" {
		t.Fatalf("TxInfo is empty")
	}
	if response.TxHash == "" {
		t.Fatalf("TxHash is empty")
	}
}

func TestCreateAccountAuthReturnsCanonicalTokenAndPublicKey(t *testing.T) {
	request, err := readRequest(strings.NewReader(`{
		"operation": "createAccountAuth",
		"privateKey": "11111111111111111111111111111111111111111111111111111111111111111111111111111111",
		"chainId": 466324,
		"accountIndex": "42",
		"apiKeyIndex": 7,
		"deadlineUnixSeconds": "1893456600"
	}`))
	if err != nil {
		t.Fatalf("readRequest() error = %v", err)
	}

	response, err := createAccountAuth(request)
	if err != nil {
		t.Fatalf("createAccountAuth() error = %v", err)
	}
	if !response.OK {
		t.Fatalf("createAccountAuth() returned OK=false")
	}
	if !strings.HasPrefix(response.AuthToken, "1893456600:42:7:") {
		t.Fatalf("AuthToken has unexpected scope")
	}
	if len(response.PublicKey) != 80 {
		t.Fatalf("PublicKey length = %d, want 80", len(response.PublicKey))
	}
}

func TestReadRequestRejectsReservedAPIKeyIndexes(t *testing.T) {
	_, err := readRequest(strings.NewReader(`{
		"operation": "signCreateOrder",
		"privateKey": "11111111111111111111111111111111111111111111111111111111111111111111111111111111",
		"chainId": 466324,
		"accountIndex": "42",
		"apiKeyIndex": 3,
		"nonce": "123",
		"order": {
			"marketIndex": 0,
			"clientOrderIndex": "1",
			"baseAmount": "1000",
			"price": "300000",
			"isAsk": 0,
			"orderType": 0,
			"timeInForce": 1,
			"reduceOnly": 0,
			"triggerPrice": "0",
			"orderExpiry": "1893456000000"
		}
	}`))
	if err == nil {
		t.Fatalf("readRequest() error = nil, want reserved api key rejection")
	}
}
