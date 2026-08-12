package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"

	lighterclient "github.com/elliottech/lighter-go/client"
	"github.com/elliottech/lighter-go/types"
)

const maxInputBytes = 32 * 1024

var privateKeyPattern = regexp.MustCompile(`^(?:0x)?[a-fA-F0-9]{80}$`)

type signerRequest struct {
	Operation    string             `json:"operation"`
	PrivateKey   string             `json:"privateKey"`
	ChainID      uint32             `json:"chainId"`
	AccountIndex string             `json:"accountIndex"`
	APIKeyIndex  uint8              `json:"apiKeyIndex"`
	Nonce        string             `json:"nonce"`
	Order        createOrderRequest `json:"order"`
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

type signerResponse struct {
	OK        bool   `json:"ok"`
	TxType    uint8  `json:"txType,omitempty"`
	TxInfo    string `json:"txInfo,omitempty"`
	TxHash    string `json:"txHash,omitempty"`
	ErrorCode string `json:"errorCode,omitempty"`
	Error     string `json:"error,omitempty"`
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

	response, err := signCreateOrder(request)
	if err != nil {
		writeFailure("signing_failed", "Lighter signer runtime could not sign the prepared order.")
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
	if request.Operation != "signCreateOrder" {
		return request, fmt.Errorf("unsupported signer operation")
	}
	if !privateKeyPattern.MatchString(request.PrivateKey) {
		return request, fmt.Errorf("invalid signer credential material")
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
	if _, err := parsePositiveInt64(request.Order.OrderExpiry, "order expiry"); err != nil {
		return request, fmt.Errorf("invalid order expiry")
	}
	return request, nil
}

func signCreateOrder(request signerRequest) (signerResponse, error) {
	accountIndex, err := parseNonNegativeInt64(request.AccountIndex, "account index")
	if err != nil {
		return signerResponse{}, err
	}
	nonce, err := parseNonNegativeInt64(request.Nonce, "nonce")
	if err != nil {
		return signerResponse{}, err
	}
	clientOrderIndex, err := parseNonNegativeInt64(request.Order.ClientOrderIndex, "client order index")
	if err != nil {
		return signerResponse{}, err
	}
	baseAmount, err := parsePositiveInt64(request.Order.BaseAmount, "base amount")
	if err != nil {
		return signerResponse{}, err
	}
	price, err := parsePositiveUint32(request.Order.Price, "price")
	if err != nil {
		return signerResponse{}, err
	}
	triggerPrice, err := parseNonNegativeUint32(request.Order.TriggerPrice, "trigger price")
	if err != nil {
		return signerResponse{}, err
	}
	orderExpiry, err := parsePositiveInt64(request.Order.OrderExpiry, "order expiry")
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
		MarketIndex:      request.Order.MarketIndex,
		ClientOrderIndex: clientOrderIndex,
		BaseAmount:       baseAmount,
		Price:            price,
		IsAsk:            request.Order.IsAsk,
		Type:             request.Order.OrderType,
		TimeInForce:      request.Order.TimeInForce,
		ReduceOnly:       request.Order.ReduceOnly,
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
