package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/elliottech/lighter-go/types/txtypes"
	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
)

func TestGenerateAPIKeyReturnsMatchingStandardKeyPair(t *testing.T) {
	response, err := generateAPIKey()
	if err != nil {
		t.Fatalf("generateAPIKey() error = %v", err)
	}
	if !response.OK {
		t.Fatalf("generateAPIKey() returned OK=false")
	}
	if len(response.PrivateKey) != 82 || !strings.HasPrefix(response.PrivateKey, "0x") {
		t.Fatalf("generated private key has unexpected encoding")
	}
	if len(response.PublicKey) != 82 || !strings.HasPrefix(response.PublicKey, "0x") {
		t.Fatalf("generated public key has unexpected encoding")
	}

	derived, err := derivePublicKey(signerRequest{PrivateKey: response.PrivateKey})
	if err != nil {
		t.Fatalf("derivePublicKey() error = %v", err)
	}
	if derived.PublicKey != response.PublicKey {
		t.Fatalf("derived public key does not match generated public key")
	}
}

func TestReadRequestAcceptsSecretlessGenerationOnly(t *testing.T) {
	if _, err := readRequest(strings.NewReader(`{"operation":"generateApiKey"}`)); err != nil {
		t.Fatalf("readRequest() generation error = %v", err)
	}
	if _, err := readRequest(strings.NewReader(`{
		"operation":"generateApiKey",
		"privateKey":"11111111111111111111111111111111111111111111111111111111111111111111111111111111"
	}`)); err == nil {
		t.Fatalf("expected generation request with credential material to be rejected")
	}
}

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

func TestSignCreateOrderAcceptsMarketIOCWithNilExpiry(t *testing.T) {
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
			"isAsk": 0,
			"orderType": 1,
			"timeInForce": 0,
			"reduceOnly": 0,
			"triggerPrice": "0",
			"orderExpiry": "0"
		}
	}`))
	if err != nil {
		t.Fatalf("readRequest() error = %v", err)
	}

	response, err := signCreateOrder(request)
	if err != nil {
		t.Fatalf("signCreateOrder() market IOC error = %v", err)
	}
	if !response.OK || response.TxInfo == "" || response.TxHash == "" {
		t.Fatalf("market IOC order did not produce a signed transaction")
	}
}

func TestSignCreateOrderRejectsMarketOrderWithNonNilExpiry(t *testing.T) {
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
			"isAsk": 0,
			"orderType": 1,
			"timeInForce": 0,
			"reduceOnly": 0,
			"triggerPrice": "0",
			"orderExpiry": "1893456000000"
		}
	}`))
	if err != nil {
		t.Fatalf("readRequest() error = %v", err)
	}

	if _, err := signCreateOrder(request); err == nil {
		t.Fatalf("expected market order with a non-nil expiry to be rejected by the official signer")
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

func TestCheckClientMatchesRegisteredPublicKey(t *testing.T) {
	const lighterPrivateKey = "11111111111111111111111111111111111111111111111111111111111111111111111111111111"
	derived, err := derivePublicKey(signerRequest{PrivateKey: lighterPrivateKey})
	if err != nil {
		t.Fatalf("derivePublicKey() error = %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/apikeys" || request.URL.Query().Get("account_index") != "42" {
			t.Fatalf("unexpected CheckClient request: %s", request.URL.String())
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{"code":200,"api_keys":[{"account_index":42,"api_key_index":7,"nonce":1,"public_key":%q}]}`, strings.TrimPrefix(derived.PublicKey, "0x"))
	}))
	defer server.Close()

	response, err := checkClientAtBaseURL(signerRequest{
		PrivateKey:   lighterPrivateKey,
		ChainID:      lighterCoreChainID,
		AccountIndex: "42",
		APIKeyIndex:  7,
	}, server.URL)
	if err != nil {
		t.Fatalf("checkClientAtBaseURL() error = %v", err)
	}
	if !response.OK || response.PublicKey != strings.TrimPrefix(derived.PublicKey, "0x") {
		t.Fatalf("CheckClient did not return the matching public key")
	}
}

func TestCheckClientRejectsMismatchedRegisteredPublicKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{"code":200,"api_keys":[{"account_index":43,"api_key_index":7,"nonce":1,"public_key":%q}]}`, strings.Repeat("2", 80))
	}))
	defer server.Close()

	_, err := checkClientAtBaseURL(signerRequest{
		PrivateKey:   strings.Repeat("1", 80),
		ChainID:      lighterCoreChainID,
		AccountIndex: "43",
		APIKeyIndex:  7,
	}, server.URL)
	if err == nil {
		t.Fatalf("expected CheckClient mismatch to fail")
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

func TestSignChangePubKeyBuildsOfficialTxType8AndVerifiesWallet(t *testing.T) {
	const lighterPrivateKey = "11111111111111111111111111111111111111111111111111111111111111111111111111111111"
	derived, err := derivePublicKey(signerRequest{PrivateKey: lighterPrivateKey})
	if err != nil {
		t.Fatalf("derivePublicKey() error = %v", err)
	}
	publicKey := strings.TrimPrefix(derived.PublicKey, "0x")
	message := fmt.Sprintf(
		txtypes.TemplateChangePubKey,
		publicKey,
		"0x0000000000000000",
		"0x000000000000002a",
		"0x0000000000000007",
	)
	evmPrivateKey, err := crypto.HexToECDSA(strings.Repeat("2", 64))
	if err != nil {
		t.Fatalf("crypto.HexToECDSA() error = %v", err)
	}
	l1Signature, err := crypto.Sign(accounts.TextHash([]byte(message)), evmPrivateKey)
	if err != nil {
		t.Fatalf("crypto.Sign() error = %v", err)
	}
	expectedAddress := crypto.PubkeyToAddress(evmPrivateKey.PublicKey).Hex()

	response, err := signChangePubKey(signerRequest{
		PrivateKey:        lighterPrivateKey,
		ChainID:           lighterCoreChainID,
		AccountIndex:      "42",
		APIKeyIndex:       7,
		Nonce:             "0",
		ExpiredAt:         "1893456000000",
		PublicKey:         publicKey,
		L1Signature:       hexutil.Encode(l1Signature),
		ExpectedL1Address: expectedAddress,
	})
	if err != nil {
		t.Fatalf("signChangePubKey() error = %v", err)
	}
	if !response.OK || response.TxType != 8 {
		t.Fatalf("signChangePubKey() did not return a TxType 8 response")
	}
	if response.MessageToSign != message {
		t.Fatalf("MessageToSign differs from official Lighter template")
	}
	if len(response.TxHash) != 80 {
		t.Fatalf("TxHash length = %d, want 80", len(response.TxHash))
	}
	var txInfo map[string]any
	if err := json.Unmarshal([]byte(response.TxInfo), &txInfo); err != nil {
		t.Fatalf("TxInfo is not JSON: %v", err)
	}
	if txInfo["L1Sig"] != hexutil.Encode(l1Signature) {
		t.Fatalf("TxInfo does not contain the verified wallet signature")
	}
	if txInfo["PubKey"] != base64.StdEncoding.EncodeToString(publicKeyBytes(t, publicKey)) {
		t.Fatalf("TxInfo PubKey has an unexpected representation")
	}
}

func TestSignChangePubKeyRejectsAnotherWalletSignature(t *testing.T) {
	const lighterPrivateKey = "11111111111111111111111111111111111111111111111111111111111111111111111111111111"
	derived, err := derivePublicKey(signerRequest{PrivateKey: lighterPrivateKey})
	if err != nil {
		t.Fatalf("derivePublicKey() error = %v", err)
	}
	publicKey := strings.TrimPrefix(derived.PublicKey, "0x")
	message := fmt.Sprintf(
		txtypes.TemplateChangePubKey,
		publicKey,
		"0x0000000000000000",
		"0x000000000000002a",
		"0x0000000000000007",
	)
	signerKey, _ := crypto.HexToECDSA(strings.Repeat("2", 64))
	otherKey, _ := crypto.HexToECDSA(strings.Repeat("3", 64))
	l1Signature, _ := crypto.Sign(accounts.TextHash([]byte(message)), signerKey)

	_, err = signChangePubKey(signerRequest{
		PrivateKey:        lighterPrivateKey,
		ChainID:           lighterCoreChainID,
		AccountIndex:      "42",
		APIKeyIndex:       7,
		Nonce:             "0",
		ExpiredAt:         "1893456000000",
		PublicKey:         publicKey,
		L1Signature:       hexutil.Encode(l1Signature),
		ExpectedL1Address: crypto.PubkeyToAddress(otherKey.PublicKey).Hex(),
	})
	if err == nil || !strings.Contains(err.Error(), "expected wallet") {
		t.Fatalf("expected a mismatched wallet signature rejection, got %v", err)
	}
}

func publicKeyBytes(t *testing.T, publicKey string) []byte {
	t.Helper()
	decoded, err := hexutil.Decode("0x" + publicKey)
	if err != nil {
		t.Fatalf("invalid public key fixture: %v", err)
	}
	return decoded
}
