package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	lighterclient "github.com/elliottech/lighter-go/client"
	"github.com/elliottech/lighter-go/types"
)

const maxInputBytes = 32 * 1024

var privateKeyPattern = regexp.MustCompile(`^(?:0x)?[a-fA-F0-9]{64}$`)

type signerRequest struct {
	Operation    string             `json:"operation"`
	PrivateKey   string             `json:"privateKey"`
	ChainID      uint32             `json:"chainId"`
	AccountIndex int64              `json:"accountIndex"`
	APIKeyIndex  uint8              `json:"apiKeyIndex"`
	Nonce        int64              `json:"nonce"`
	Order        createOrderRequest `json:"order"`
}

type createOrderRequest struct {
	MarketIndex      int16  `json:"marketIndex"`
	ClientOrderIndex int64  `json:"clientOrderIndex"`
	BaseAmount       int64  `json:"baseAmount"`
	Price            uint32 `json:"price"`
	IsAsk            uint8  `json:"isAsk"`
	OrderType        uint8  `json:"orderType"`
	TimeInForce      uint8  `json:"timeInForce"`
	ReduceOnly       uint8  `json:"reduceOnly"`
	TriggerPrice     uint32 `json:"triggerPrice"`
	OrderExpiry      int64  `json:"orderExpiry"`
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
	if request.AccountIndex <= 0 {
		return request, fmt.Errorf("invalid account index")
	}
	if request.APIKeyIndex < 4 || request.APIKeyIndex > 254 {
		return request, fmt.Errorf("invalid api key index")
	}
	if request.Nonce <= 0 {
		return request, fmt.Errorf("invalid nonce")
	}
	if request.Order.ClientOrderIndex < 0 {
		return request, fmt.Errorf("invalid client order index")
	}
	if request.Order.BaseAmount <= 0 {
		return request, fmt.Errorf("invalid base amount")
	}
	if request.Order.Price == 0 {
		return request, fmt.Errorf("invalid price")
	}
	if request.Order.IsAsk > 1 || request.Order.ReduceOnly > 1 {
		return request, fmt.Errorf("invalid boolean field")
	}
	if request.Order.OrderExpiry <= 0 {
		return request, fmt.Errorf("invalid order expiry")
	}
	return request, nil
}

func signCreateOrder(request signerRequest) (signerResponse, error) {
	client, err := lighterclient.NewTxClient(
		nil,
		strings.TrimPrefix(request.PrivateKey, "0x"),
		request.AccountIndex,
		request.APIKeyIndex,
		request.ChainID,
	)
	if err != nil {
		return signerResponse{}, err
	}

	order := &types.CreateOrderTxReq{
		MarketIndex:      request.Order.MarketIndex,
		ClientOrderIndex: request.Order.ClientOrderIndex,
		BaseAmount:       request.Order.BaseAmount,
		Price:            request.Order.Price,
		IsAsk:            request.Order.IsAsk,
		Type:             request.Order.OrderType,
		TimeInForce:      request.Order.TimeInForce,
		ReduceOnly:       request.Order.ReduceOnly,
		TriggerPrice:     request.Order.TriggerPrice,
		OrderExpiry:      request.Order.OrderExpiry,
	}
	apiKeyIndex := request.APIKeyIndex
	accountIndex := request.AccountIndex
	nonce := request.Nonce
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
