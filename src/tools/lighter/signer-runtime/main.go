package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	lighterclient "github.com/elliottech/lighter-go/client"
	lighterhttp "github.com/elliottech/lighter-go/client/http"
	lightersigner "github.com/elliottech/lighter-go/signer"
	"github.com/elliottech/lighter-go/types"
	schnorr "github.com/elliottech/poseidon_crypto/signature/schnorr"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

const maxInputBytes = 32 * 1024
const maxRegistrationNonce = int64(1<<48 - 1)
const lighterCoreChainID = uint32(304)
const lighterCoreBaseURL = "https://mainnet.zklighter.elliot.ai"
const lighterRHCChainID = uint32(466324)
const lighterRHCBaseURL = "https://api.rh.lighter.xyz"
const lighterWithdrawTxType = uint8(13)
const lighterCoreUSDCAssetIndex = int16(3)
const lighterSecureWithdrawRouteType = uint8(0)
const minWithdrawExpiryLead = int64(15 * 1000)
const maxWithdrawExpiryLead = int64(5 * 60 * 1000)

var privateKeyPattern = regexp.MustCompile(`^(?:0x)?[a-fA-F0-9]{80}$`)
var publicKeyPattern = regexp.MustCompile(`^(?:0x)?[a-fA-F0-9]{80}$`)
var l1SignaturePattern = regexp.MustCompile(`^0x[a-fA-F0-9]{130}$`)

type signerRequest struct {
	Operation           string              `json:"operation"`
	PrivateKey          string              `json:"privateKey"`
	ChainID             uint32              `json:"chainId"`
	AccountIndex        string              `json:"accountIndex"`
	APIKeyIndex         uint8               `json:"apiKeyIndex"`
	Nonce               string              `json:"nonce"`
	DeadlineUnixSeconds string              `json:"deadlineUnixSeconds"`
	ExpiredAt           string              `json:"expiredAt"`
	PublicKey           string              `json:"publicKey"`
	L1Signature         string              `json:"l1Signature"`
	ExpectedL1Address   string              `json:"expectedL1Address"`
	Order               *createOrderRequest `json:"order"`
	Withdrawal          *withdrawRequest    `json:"withdrawal"`
}

type createOrderRequest struct {
	MarketIndex      int16  `json:"marketIndex"`
	ClientOrderIndex string `json:"clientOrderIndex"`
	BaseAmount       string `json:"baseAmount"`
	Price            string `json:"price"`
	IsAsk            uint8  `json:"isAsk"`
	OrderType        uint8  `json:"orderType"`
	TimeInForce      uint8  `json:"timeInForce"`
	ReduceOnly       uint8  `json:"reduceOnly"`
	TriggerPrice     string `json:"triggerPrice"`
	OrderExpiry      string `json:"orderExpiry"`
}

type withdrawRequest struct {
	AssetIndex int16  `json:"assetIndex"`
	RouteType  uint8  `json:"routeType"`
	Amount     string `json:"amount"`
}

type signerResponse struct {
	OK            bool   `json:"ok"`
	TxType        uint8  `json:"txType,omitempty"`
	TxInfo        string `json:"txInfo,omitempty"`
	TxHash        string `json:"txHash,omitempty"`
	AuthToken     string `json:"authToken,omitempty"`
	PublicKey     string `json:"publicKey,omitempty"`
	PrivateKey    string `json:"privateKey,omitempty"`
	MessageToSign string `json:"messageToSign,omitempty"`
	ErrorCode     string `json:"errorCode,omitempty"`
	Error         string `json:"error,omitempty"`
}

func main() {
	defer func() {
		if recovered := recover(); recovered != nil {
			writeFailure("panic", "Lighter signer runtime failed before producing a transaction.")
		}
	}()

	request, err := readRequest(os.Stdin)
	if err != nil {
		writeFailure("invalid_input", err.Error())
		return
	}

	var response signerResponse
	switch request.Operation {
	case "generateApiKey":
		response, err = generateAPIKey()
	case "derivePublicKey":
		response, err = derivePublicKey(request)
	case "createAccountAuth":
		response, err = createAccountAuth(request)
	case "signCreateOrder":
		response, err = signCreateOrder(request)
	case "signWithdraw":
		response, err = signWithdraw(request)
	case "signChangePubKey":
		response, err = signChangePubKey(request)
	case "checkClient":
		response, err = checkClient(request)
	default:
		err = fmt.Errorf("unsupported signer operation")
	}
	if err != nil {
		writeFailure("signing_failed", "Lighter signer runtime could not complete the requested operation.")
		return
	}
	writeJSON(response)
}

func readRequest(reader io.Reader) (signerRequest, error) {
	var request signerRequest
	decoder := json.NewDecoder(io.LimitReader(reader, maxInputBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return request, fmt.Errorf("invalid signer request")
	}
	if request.Operation != "signCreateOrder" && request.Operation != "signWithdraw" && request.Operation != "signChangePubKey" &&
		request.Operation != "checkClient" &&
		request.Operation != "createAccountAuth" &&
		request.Operation != "generateApiKey" && request.Operation != "derivePublicKey" {
		return request, fmt.Errorf("unsupported signer operation")
	}
	if request.Operation == "generateApiKey" {
		if request.PrivateKey != "" {
			return request, fmt.Errorf("generate api key does not accept credential material")
		}
		return request, nil
	}
	if !privateKeyPattern.MatchString(request.PrivateKey) {
		return request, fmt.Errorf("invalid signer credential material")
	}
	if request.Operation == "derivePublicKey" {
		return request, nil
	}
	if request.ChainID == 0 {
		return request, fmt.Errorf("invalid chain id")
	}
	if _, err := parseNonNegativeInt64(request.AccountIndex, "account index"); err != nil {
		return request, fmt.Errorf("invalid account index")
	}
	if request.APIKeyIndex < 4 || request.APIKeyIndex > 254 {
		return request, fmt.Errorf("invalid api key index")
	}
	if request.Operation == "createAccountAuth" {
		if _, err := parsePositiveInt64(request.DeadlineUnixSeconds, "auth deadline"); err != nil {
			return request, fmt.Errorf("invalid auth deadline")
		}
		return request, nil
	}
	if request.Operation == "checkClient" {
		if !isSupportedRegistrationChainID(request.ChainID) {
			return request, fmt.Errorf("invalid registration chain id")
		}
		return request, nil
	}
	if request.Operation == "signChangePubKey" {
		nonce, err := parseNonNegativeInt64(request.Nonce, "nonce")
		if err != nil || nonce > maxRegistrationNonce {
			return request, fmt.Errorf("invalid nonce")
		}
		if !isSupportedRegistrationChainID(request.ChainID) {
			return request, fmt.Errorf("invalid registration chain id")
		}
		if _, err := parsePositiveInt64(request.ExpiredAt, "expiry"); err != nil {
			return request, fmt.Errorf("invalid expiry")
		}
		if !publicKeyPattern.MatchString(request.PublicKey) {
			return request, fmt.Errorf("invalid public key")
		}
		if !l1SignaturePattern.MatchString(request.L1Signature) {
			return request, fmt.Errorf("invalid l1 signature")
		}
		recovery := strings.ToLower(request.L1Signature[len(request.L1Signature)-2:])
		if recovery != "00" && recovery != "01" && recovery != "1b" && recovery != "1c" {
			return request, fmt.Errorf("invalid l1 signature recovery value")
		}
		if !common.IsHexAddress(request.ExpectedL1Address) {
			return request, fmt.Errorf("invalid expected l1 address")
		}
		return request, nil
	}
	if request.Operation == "signWithdraw" {
		nonce, err := parseNonNegativeInt64(request.Nonce, "nonce")
		if err != nil || nonce > maxRegistrationNonce {
			return request, fmt.Errorf("invalid nonce")
		}
		if request.ChainID != lighterCoreChainID && request.ChainID != lighterRHCChainID {
			return request, fmt.Errorf("invalid withdrawal chain id")
		}
		expiredAt, err := parsePositiveInt64(request.ExpiredAt, "expiry")
		if err != nil {
			return request, fmt.Errorf("invalid expiry")
		}
		nowMillis := time.Now().UnixMilli()
		if expiredAt < nowMillis+minWithdrawExpiryLead || expiredAt > nowMillis+maxWithdrawExpiryLead {
			return request, fmt.Errorf("invalid withdrawal expiry window")
		}
		if request.Withdrawal == nil {
			return request, fmt.Errorf("missing withdrawal")
		}
		if request.Withdrawal.AssetIndex != lighterCoreUSDCAssetIndex {
			return request, fmt.Errorf("invalid withdrawal asset")
		}
		if request.Withdrawal.RouteType != lighterSecureWithdrawRouteType {
			return request, fmt.Errorf("invalid withdrawal route")
		}
		if _, err := parsePositiveUint64(request.Withdrawal.Amount, "withdrawal amount"); err != nil {
			return request, fmt.Errorf("invalid withdrawal amount")
		}
		return request, nil
	}
	if request.Order == nil {
		return request, fmt.Errorf("missing create order")
	}
	if _, err := parseNonNegativeInt64(request.Nonce, "nonce"); err != nil {
		return request, fmt.Errorf("invalid nonce")
	}
	if _, err := parseNonNegativeInt64(request.Order.ClientOrderIndex, "client order index"); err != nil {
		return request, fmt.Errorf("invalid client order index")
	}
	if _, err := parsePositiveInt64(request.Order.BaseAmount, "base amount"); err != nil {
		return request, fmt.Errorf("invalid base amount")
	}
	if _, err := parsePositiveUint32(request.Order.Price, "price"); err != nil {
		return request, fmt.Errorf("invalid price")
	}
	if request.Order.IsAsk > 1 || request.Order.ReduceOnly > 1 {
		return request, fmt.Errorf("invalid boolean field")
	}
	if _, err := parseNonNegativeUint32(request.Order.TriggerPrice, "trigger price"); err != nil {
		return request, fmt.Errorf("invalid trigger price")
	}
	// Expiry 0 is Lighter's nil expiry, required for immediate-or-cancel orders.
	// The per-order-type expiry rule is enforced by lighter-go's Validate().
	if _, err := parseNonNegativeInt64(request.Order.OrderExpiry, "order expiry"); err != nil {
		return request, fmt.Errorf("invalid order expiry")
	}
	return request, nil
}

func checkClient(request signerRequest) (signerResponse, error) {
	baseURL, err := registrationBaseURL(request.ChainID)
	if err != nil {
		return signerResponse{}, err
	}
	return checkClientAtBaseURL(request, baseURL)
}

func isSupportedRegistrationChainID(chainID uint32) bool {
	return chainID == lighterCoreChainID || chainID == lighterRHCChainID
}

func registrationBaseURL(chainID uint32) (string, error) {
	switch chainID {
	case lighterCoreChainID:
		return lighterCoreBaseURL, nil
	case lighterRHCChainID:
		return lighterRHCBaseURL, nil
	default:
		return "", fmt.Errorf("unsupported registration chain id")
	}
}

func checkClientAtBaseURL(request signerRequest, baseURL string) (signerResponse, error) {
	accountIndex, err := parsePositiveInt64(request.AccountIndex, "account index")
	if err != nil {
		return signerResponse{}, err
	}
	client, err := lighterclient.NewTxClient(
		lighterhttp.NewClient(baseURL),
		strings.TrimPrefix(request.PrivateKey, "0x"),
		accountIndex,
		request.APIKeyIndex,
		request.ChainID,
	)
	if err != nil {
		return signerResponse{}, err
	}
	if err := client.Check(); err != nil {
		return signerResponse{}, err
	}
	publicKey := client.GetKeyManager().PubKeyBytes()
	return signerResponse{
		OK:        true,
		PublicKey: hex.EncodeToString(publicKey[:]),
	}, nil
}

func generateAPIKey() (signerResponse, error) {
	privateKey, publicKey, err := lighterclient.GenerateAPIKey()
	if err != nil {
		return signerResponse{}, err
	}
	return signerResponse{
		OK:         true,
		PrivateKey: privateKey,
		PublicKey:  publicKey,
	}, nil
}

func derivePublicKey(request signerRequest) (signerResponse, error) {
	privateKey := request.PrivateKey
	if !strings.HasPrefix(privateKey, "0x") {
		privateKey = "0x" + privateKey
	}
	privateKeyBytes, err := hexutil.Decode(privateKey)
	if err != nil {
		return signerResponse{}, err
	}
	keyManager, err := lightersigner.NewKeyManager(privateKeyBytes)
	if err != nil {
		return signerResponse{}, err
	}
	publicKey := keyManager.PubKeyBytes()
	return signerResponse{
		OK:        true,
		PublicKey: hexutil.Encode(publicKey[:]),
	}, nil
}

func createAccountAuth(request signerRequest) (signerResponse, error) {
	accountIndex, err := parseNonNegativeInt64(request.AccountIndex, "account index")
	if err != nil {
		return signerResponse{}, err
	}
	deadline, err := parsePositiveInt64(request.DeadlineUnixSeconds, "auth deadline")
	if err != nil {
		return signerResponse{}, err
	}
	client, err := lighterclient.NewTxClient(
		nil,
		strings.TrimPrefix(request.PrivateKey, "0x"),
		accountIndex,
		request.APIKeyIndex,
		request.ChainID,
	)
	if err != nil {
		return signerResponse{}, err
	}
	authToken, err := client.GetAuthToken(time.Unix(deadline, 0))
	if err != nil {
		return signerResponse{}, err
	}
	publicKey := client.GetKeyManager().PubKeyBytes()
	return signerResponse{
		OK:        true,
		AuthToken: authToken,
		PublicKey: hex.EncodeToString(publicKey[:]),
	}, nil
}

func signChangePubKey(request signerRequest) (signerResponse, error) {
	accountIndex, err := parsePositiveInt64(request.AccountIndex, "account index")
	if err != nil {
		return signerResponse{}, err
	}
	nonce, err := parseNonNegativeInt64(request.Nonce, "nonce")
	if err != nil {
		return signerResponse{}, err
	}
	expiredAt, err := parsePositiveInt64(request.ExpiredAt, "expiry")
	if err != nil {
		return signerResponse{}, err
	}
	publicKeyBytes, err := hexutil.Decode("0x" + strings.TrimPrefix(request.PublicKey, "0x"))
	if err != nil || len(publicKeyBytes) != 40 {
		return signerResponse{}, fmt.Errorf("invalid public key")
	}
	var publicKey [40]byte
	copy(publicKey[:], publicKeyBytes)

	client, err := lighterclient.NewTxClient(
		nil,
		strings.TrimPrefix(request.PrivateKey, "0x"),
		accountIndex,
		request.APIKeyIndex,
		request.ChainID,
	)
	if err != nil {
		return signerResponse{}, err
	}
	derivedPublicKey := client.GetKeyManager().PubKeyBytes()
	if !strings.EqualFold(hex.EncodeToString(derivedPublicKey[:]), hex.EncodeToString(publicKey[:])) {
		return signerResponse{}, fmt.Errorf("public key does not match signer credential")
	}

	apiKeyIndex := request.APIKeyIndex
	tx, err := types.ConstructChangePubKeyTx(
		client.GetKeyManager(),
		request.ChainID,
		&types.ChangePubKeyReq{PubKey: publicKey},
		&types.TransactOpts{
			FromAccountIndex: &accountIndex,
			ApiKeyIndex:      &apiKeyIndex,
			ExpiredAt:        expiredAt,
			Nonce:            &nonce,
			TxAttributes:     &types.L2TxAttributes{},
		},
	)
	if err != nil {
		return signerResponse{}, err
	}
	if tx == nil {
		return signerResponse{}, fmt.Errorf("empty signer response")
	}
	messageHash, err := tx.Hash(request.ChainID)
	if err != nil {
		return signerResponse{}, err
	}
	if err := schnorr.Validate(derivedPublicKey[:], messageHash, tx.Sig); err != nil {
		return signerResponse{}, fmt.Errorf("failed to validate l2 signature")
	}
	tx.L1Sig = request.L1Signature
	messageToSign := tx.GetL1SignatureBody()
	if tx.GetL1AddressBySignature() != common.HexToAddress(request.ExpectedL1Address) {
		return signerResponse{}, fmt.Errorf("l1 signature does not match expected wallet")
	}
	txInfo, err := tx.GetTxInfo()
	if err != nil {
		return signerResponse{}, err
	}
	return signerResponse{
		OK:            true,
		TxType:        tx.GetTxType(),
		TxInfo:        txInfo,
		TxHash:        tx.GetTxHash(),
		MessageToSign: messageToSign,
	}, nil
}

func signCreateOrder(request signerRequest) (signerResponse, error) {
	if request.Order == nil {
		return signerResponse{}, fmt.Errorf("missing create order")
	}
	orderRequest := request.Order
	accountIndex, err := parseNonNegativeInt64(request.AccountIndex, "account index")
	if err != nil {
		return signerResponse{}, err
	}
	nonce, err := parseNonNegativeInt64(request.Nonce, "nonce")
	if err != nil {
		return signerResponse{}, err
	}
	clientOrderIndex, err := parseNonNegativeInt64(orderRequest.ClientOrderIndex, "client order index")
	if err != nil {
		return signerResponse{}, err
	}
	baseAmount, err := parsePositiveInt64(orderRequest.BaseAmount, "base amount")
	if err != nil {
		return signerResponse{}, err
	}
	price, err := parsePositiveUint32(orderRequest.Price, "price")
	if err != nil {
		return signerResponse{}, err
	}
	triggerPrice, err := parseNonNegativeUint32(orderRequest.TriggerPrice, "trigger price")
	if err != nil {
		return signerResponse{}, err
	}
	orderExpiry, err := parseNonNegativeInt64(orderRequest.OrderExpiry, "order expiry")
	if err != nil {
		return signerResponse{}, err
	}

	client, err := lighterclient.NewTxClient(
		nil,
		strings.TrimPrefix(request.PrivateKey, "0x"),
		accountIndex,
		request.APIKeyIndex,
		request.ChainID,
	)
	if err != nil {
		return signerResponse{}, err
	}

	order := &types.CreateOrderTxReq{
		MarketIndex:      orderRequest.MarketIndex,
		ClientOrderIndex: clientOrderIndex,
		BaseAmount:       baseAmount,
		Price:            price,
		IsAsk:            orderRequest.IsAsk,
		Type:             orderRequest.OrderType,
		TimeInForce:      orderRequest.TimeInForce,
		ReduceOnly:       orderRequest.ReduceOnly,
		TriggerPrice:     triggerPrice,
		OrderExpiry:      orderExpiry,
	}
	apiKeyIndex := request.APIKeyIndex
	tx, err := client.GetCreateOrderTransaction(order, &types.TransactOpts{
		FromAccountIndex: &accountIndex,
		ApiKeyIndex:      &apiKeyIndex,
		Nonce:            &nonce,
		TxAttributes:     &types.L2TxAttributes{},
	})
	if err != nil {
		return signerResponse{}, err
	}
	if tx == nil {
		return signerResponse{}, fmt.Errorf("empty signer response")
	}
	txInfo, err := tx.GetTxInfo()
	if err != nil {
		return signerResponse{}, err
	}
	return signerResponse{
		OK:     true,
		TxType: tx.GetTxType(),
		TxInfo: txInfo,
		TxHash: tx.GetTxHash(),
	}, nil
}

func signWithdraw(request signerRequest) (signerResponse, error) {
	if request.Withdrawal == nil {
		return signerResponse{}, fmt.Errorf("missing withdrawal")
	}
	accountIndex, err := parseNonNegativeInt64(request.AccountIndex, "account index")
	if err != nil {
		return signerResponse{}, err
	}
	nonce, err := parseNonNegativeInt64(request.Nonce, "nonce")
	if err != nil {
		return signerResponse{}, err
	}
	expiredAt, err := parsePositiveInt64(request.ExpiredAt, "expiry")
	if err != nil {
		return signerResponse{}, err
	}
	amount, err := parsePositiveUint64(request.Withdrawal.Amount, "withdrawal amount")
	if err != nil {
		return signerResponse{}, err
	}

	client, err := lighterclient.NewTxClient(
		nil,
		strings.TrimPrefix(request.PrivateKey, "0x"),
		accountIndex,
		request.APIKeyIndex,
		request.ChainID,
	)
	if err != nil {
		return signerResponse{}, err
	}
	apiKeyIndex := request.APIKeyIndex
	tx, err := client.GetWithdrawTransaction(
		&types.WithdrawTxReq{
			AssetIndex: request.Withdrawal.AssetIndex,
			RouteType:  request.Withdrawal.RouteType,
			Amount:     amount,
		},
		&types.TransactOpts{
			FromAccountIndex: &accountIndex,
			ApiKeyIndex:      &apiKeyIndex,
			ExpiredAt:        expiredAt,
			Nonce:            &nonce,
			TxAttributes:     &types.L2TxAttributes{},
		},
	)
	if err != nil {
		return signerResponse{}, err
	}
	if tx == nil || tx.GetTxType() != lighterWithdrawTxType {
		return signerResponse{}, fmt.Errorf("invalid withdraw signer response")
	}
	if tx.FromAccountIndex != accountIndex || tx.ApiKeyIndex != apiKeyIndex ||
		tx.AssetIndex != lighterCoreUSDCAssetIndex || tx.RouteType != lighterSecureWithdrawRouteType ||
		tx.Amount != amount || tx.ExpiredAt != expiredAt || tx.Nonce != nonce {
		return signerResponse{}, fmt.Errorf("withdraw signer response identity mismatch")
	}
	messageHash, err := tx.Hash(request.ChainID)
	if err != nil {
		return signerResponse{}, err
	}
	publicKey := client.GetKeyManager().PubKeyBytes()
	if err := schnorr.Validate(publicKey[:], messageHash, tx.Sig); err != nil {
		return signerResponse{}, fmt.Errorf("failed to validate withdraw signature")
	}
	txInfo, err := tx.GetTxInfo()
	if err != nil {
		return signerResponse{}, err
	}
	return signerResponse{
		OK:     true,
		TxType: lighterWithdrawTxType,
		TxInfo: txInfo,
		TxHash: tx.GetTxHash(),
	}, nil
}

func parsePositiveInt64(value string, field string) (int64, error) {
	parsed, err := parseNonNegativeInt64(value, field)
	if err != nil {
		return 0, err
	}
	if parsed == 0 {
		return 0, fmt.Errorf("%s must be positive", field)
	}
	return parsed, nil
}

func parseNonNegativeInt64(value string, field string) (int64, error) {
	if !regexp.MustCompile(`^\d+$`).MatchString(value) {
		return 0, fmt.Errorf("%s must be a decimal integer", field)
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s is outside int64 range", field)
	}
	if parsed < 0 {
		return 0, fmt.Errorf("%s must be non-negative", field)
	}
	return parsed, nil
}

func parsePositiveUint32(value string, field string) (uint32, error) {
	parsed, err := parseNonNegativeUint32(value, field)
	if err != nil {
		return 0, err
	}
	if parsed == 0 {
		return 0, fmt.Errorf("%s must be positive", field)
	}
	return parsed, nil
}

func parseNonNegativeUint32(value string, field string) (uint32, error) {
	if !regexp.MustCompile(`^\d+$`).MatchString(value) {
		return 0, fmt.Errorf("%s must be a decimal integer", field)
	}
	parsed, err := strconv.ParseUint(value, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("%s is outside uint32 range", field)
	}
	return uint32(parsed), nil
}

func parsePositiveUint64(value string, field string) (uint64, error) {
	if !regexp.MustCompile(`^\d+$`).MatchString(value) {
		return 0, fmt.Errorf("%s must be a decimal integer", field)
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s is outside uint64 range", field)
	}
	if parsed == 0 {
		return 0, fmt.Errorf("%s must be positive", field)
	}
	return parsed, nil
}

func writeFailure(code string, message string) {
	writeJSON(signerResponse{
		OK:        false,
		ErrorCode: code,
		Error:     message,
	})
	os.Exit(1)
}

func writeJSON(response signerResponse) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(response); err != nil {
		os.Exit(1)
	}
}
