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
	"github.com/elliottech/lighter-go/types/txtypes"
	schnorr "github.com/elliottech/poseidon_crypto/signature/schnorr"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

const maxInputBytes = 32 * 1024
const maxRegistrationNonce = int64(1<<48 - 1)
const maxProviderOrderIndex = int64(1<<60 - 1)
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
	Operation           string                  `json:"operation"`
	PrivateKey          string                  `json:"privateKey"`
	ChainID             uint32                  `json:"chainId"`
	AccountIndex        string                  `json:"accountIndex"`
	APIKeyIndex         uint8                   `json:"apiKeyIndex"`
	Nonce               string                  `json:"nonce"`
	DeadlineUnixSeconds string                  `json:"deadlineUnixSeconds"`
	ExpiredAt           string                  `json:"expiredAt"`
	PublicKey           string                  `json:"publicKey"`
	L1Signature         string                  `json:"l1Signature"`
	ExpectedL1Address   string                  `json:"expectedL1Address"`
	Order               *createOrderRequest     `json:"order"`
	GroupedOrders       *groupedOrdersRequest   `json:"groupedOrders"`
	CancelOrder         *cancelOrderRequest     `json:"cancelOrder"`
	ModifyOrder         *modifyOrderRequest     `json:"modifyOrder"`
	CancelAllOrders     *cancelAllOrdersRequest `json:"cancelAllOrders"`
	Withdrawal          *withdrawRequest        `json:"withdrawal"`
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

type groupedOrdersRequest struct {
	GroupingType uint8                `json:"groupingType"`
	Orders       []createOrderRequest `json:"orders"`
}

type withdrawRequest struct {
	AssetIndex int16  `json:"assetIndex"`
	RouteType  uint8  `json:"routeType"`
	Amount     string `json:"amount"`
}

type cancelOrderRequest struct {
	MarketIndex int16  `json:"marketIndex"`
	OrderIndex  string `json:"orderIndex"`
}

type modifyOrderRequest struct {
	MarketIndex  int16  `json:"marketIndex"`
	OrderIndex   string `json:"orderIndex"`
	BaseAmount   string `json:"baseAmount"`
	Price        string `json:"price"`
	TriggerPrice string `json:"triggerPrice"`
}

type cancelAllOrdersRequest struct {
	TimeInForce uint8  `json:"timeInForce"`
	Time        string `json:"time"`
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
	case "signCreateGroupedOrders":
		response, err = signCreateGroupedOrders(request)
	case "signCancelOrder":
		response, err = signCancelOrder(request)
	case "signModifyOrder":
		response, err = signModifyOrder(request)
	case "signCancelAllOrders":
		response, err = signCancelAllOrders(request)
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
	if request.Operation != "signCreateOrder" && request.Operation != "signCreateGroupedOrders" && request.Operation != "signCancelOrder" && request.Operation != "signModifyOrder" &&
		request.Operation != "signCancelAllOrders" && request.Operation != "signWithdraw" && request.Operation != "signChangePubKey" &&
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
	if request.Operation == "signCancelOrder" || request.Operation == "signModifyOrder" || request.Operation == "signCancelAllOrders" {
		nonce, err := parseNonNegativeInt64(request.Nonce, "nonce")
		if err != nil || nonce > maxRegistrationNonce {
			return request, fmt.Errorf("invalid nonce")
		}
		expiredAt, err := parsePositiveInt64(request.ExpiredAt, "expiry")
		if err != nil {
			return request, fmt.Errorf("invalid expiry")
		}
		nowMillis := time.Now().UnixMilli()
		if expiredAt < nowMillis+minWithdrawExpiryLead || expiredAt > nowMillis+maxWithdrawExpiryLead {
			return request, fmt.Errorf("invalid lifecycle expiry window")
		}
		switch request.Operation {
		case "signCancelOrder":
			if request.CancelOrder == nil {
				return request, fmt.Errorf("missing cancel order")
			}
			orderIndex, err := parsePositiveInt64(request.CancelOrder.OrderIndex, "order index")
			if err != nil || orderIndex > maxProviderOrderIndex {
				return request, fmt.Errorf("invalid order index")
			}
		case "signModifyOrder":
			if request.ModifyOrder == nil {
				return request, fmt.Errorf("missing modify order")
			}
			orderIndex, err := parsePositiveInt64(request.ModifyOrder.OrderIndex, "order index")
			if err != nil || orderIndex > maxProviderOrderIndex {
				return request, fmt.Errorf("invalid order index")
			}
			if _, err := parsePositiveInt64(request.ModifyOrder.BaseAmount, "base amount"); err != nil {
				return request, fmt.Errorf("invalid base amount")
			}
			if _, err := parsePositiveUint32(request.ModifyOrder.Price, "price"); err != nil {
				return request, fmt.Errorf("invalid price")
			}
			if _, err := parseNonNegativeUint32(request.ModifyOrder.TriggerPrice, "trigger price"); err != nil {
				return request, fmt.Errorf("invalid trigger price")
			}
		case "signCancelAllOrders":
			if request.CancelAllOrders == nil || request.CancelAllOrders.TimeInForce != 0 || request.CancelAllOrders.Time != "0" {
				return request, fmt.Errorf("only immediate account-wide cancel all is supported")
			}
		}
		return request, nil
	}
	if nonce, err := parseNonNegativeInt64(request.Nonce, "nonce"); err != nil || nonce > maxRegistrationNonce {
		return request, fmt.Errorf("invalid nonce")
	}
	if request.Operation == "signCreateGroupedOrders" {
		if request.GroupedOrders == nil || request.GroupedOrders.GroupingType != txtypes.GroupingType_OneCancelsTheOther || len(request.GroupedOrders.Orders) != 2 {
			return request, fmt.Errorf("invalid grouped orders")
		}
		seenClientOrderIndexes := make(map[string]struct{}, 2)
		for index := range request.GroupedOrders.Orders {
			order := &request.GroupedOrders.Orders[index]
			if err := validateCreateOrderRequest(order); err != nil {
				return request, fmt.Errorf("invalid grouped order")
			}
			if _, exists := seenClientOrderIndexes[order.ClientOrderIndex]; exists {
				return request, fmt.Errorf("duplicate grouped client order index")
			}
			seenClientOrderIndexes[order.ClientOrderIndex] = struct{}{}
		}
		stopLoss := request.GroupedOrders.Orders[0]
		takeProfit := request.GroupedOrders.Orders[1]
		if stopLoss.MarketIndex != takeProfit.MarketIndex ||
			stopLoss.BaseAmount != takeProfit.BaseAmount ||
			stopLoss.IsAsk != takeProfit.IsAsk ||
			stopLoss.ReduceOnly != 1 || takeProfit.ReduceOnly != 1 ||
			stopLoss.OrderExpiry == "0" || stopLoss.OrderExpiry != takeProfit.OrderExpiry ||
			stopLoss.OrderType != txtypes.StopLossOrder || takeProfit.OrderType != txtypes.TakeProfitOrder ||
			stopLoss.TimeInForce != txtypes.ImmediateOrCancel || takeProfit.TimeInForce != txtypes.ImmediateOrCancel ||
			stopLoss.TriggerPrice == "0" || takeProfit.TriggerPrice == "0" {
			return request, fmt.Errorf("invalid OCO child contract")
		}
		return request, nil
	}
	if request.Order == nil {
		return request, fmt.Errorf("missing create order")
	}
	if err := validateCreateOrderRequest(request.Order); err != nil {
		return request, err
	}
	return request, nil
}

func validateCreateOrderRequest(order *createOrderRequest) error {
	if _, err := parseNonNegativeInt64(order.ClientOrderIndex, "client order index"); err != nil {
		return fmt.Errorf("invalid client order index")
	}
	if _, err := parsePositiveInt64(order.BaseAmount, "base amount"); err != nil {
		return fmt.Errorf("invalid base amount")
	}
	if _, err := parsePositiveUint32(order.Price, "price"); err != nil {
		return fmt.Errorf("invalid price")
	}
	if order.IsAsk > 1 || order.ReduceOnly > 1 {
		return fmt.Errorf("invalid boolean field")
	}
	if _, err := parseNonNegativeUint32(order.TriggerPrice, "trigger price"); err != nil {
		return fmt.Errorf("invalid trigger price")
	}
	if _, err := parseNonNegativeInt64(order.OrderExpiry, "order expiry"); err != nil {
		return fmt.Errorf("invalid order expiry")
	}
	return nil
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

func signCreateGroupedOrders(request signerRequest) (signerResponse, error) {
	if request.GroupedOrders == nil || request.GroupedOrders.GroupingType != txtypes.GroupingType_OneCancelsTheOther || len(request.GroupedOrders.Orders) != 2 {
		return signerResponse{}, fmt.Errorf("invalid grouped orders request")
	}
	client, accountIndex, nonce, err := lifecycleClient(request)
	if err != nil {
		return signerResponse{}, err
	}
	orders := make([]*types.CreateOrderTxReq, 0, 2)
	for index := range request.GroupedOrders.Orders {
		orderRequest := &request.GroupedOrders.Orders[index]
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
		orders = append(orders, &types.CreateOrderTxReq{
			MarketIndex: orderRequest.MarketIndex, ClientOrderIndex: clientOrderIndex,
			BaseAmount: baseAmount, Price: price, IsAsk: orderRequest.IsAsk,
			Type: orderRequest.OrderType, TimeInForce: orderRequest.TimeInForce,
			ReduceOnly: orderRequest.ReduceOnly, TriggerPrice: triggerPrice,
			OrderExpiry: orderExpiry,
		})
	}
	apiKeyIndex := request.APIKeyIndex
	tx, err := client.GetCreateGroupedOrdersTransaction(&types.CreateGroupedOrdersTxReq{
		GroupingType: request.GroupedOrders.GroupingType,
		Orders:       orders,
	}, &types.TransactOpts{
		FromAccountIndex: &accountIndex,
		ApiKeyIndex:      &apiKeyIndex,
		Nonce:            &nonce,
		TxAttributes:     &types.L2TxAttributes{},
	})
	if err != nil {
		return signerResponse{}, err
	}
	return lifecycleResponse(tx, txtypes.TxTypeL2CreateGroupedOrders)
}

func lifecycleClient(request signerRequest) (*lighterclient.TxClient, int64, int64, error) {
	accountIndex, err := parseNonNegativeInt64(request.AccountIndex, "account index")
	if err != nil {
		return nil, 0, 0, err
	}
	nonce, err := parseNonNegativeInt64(request.Nonce, "nonce")
	if err != nil {
		return nil, 0, 0, err
	}
	client, err := lighterclient.NewTxClient(nil, strings.TrimPrefix(request.PrivateKey, "0x"), accountIndex, request.APIKeyIndex, request.ChainID)
	return client, accountIndex, nonce, err
}

func lifecycleResponse(tx txtypes.TxInfo, expectedType uint8) (signerResponse, error) {
	if tx == nil || tx.GetTxType() != expectedType {
		return signerResponse{}, fmt.Errorf("invalid lifecycle signer response")
	}
	txInfo, err := tx.GetTxInfo()
	if err != nil {
		return signerResponse{}, err
	}
	return signerResponse{OK: true, TxType: expectedType, TxInfo: txInfo, TxHash: tx.GetTxHash()}, nil
}

func signCancelOrder(request signerRequest) (signerResponse, error) {
	client, accountIndex, nonce, err := lifecycleClient(request)
	if err != nil || request.CancelOrder == nil {
		return signerResponse{}, fmt.Errorf("invalid cancel order request")
	}
	index, err := parsePositiveInt64(request.CancelOrder.OrderIndex, "order index")
	if err != nil {
		return signerResponse{}, err
	}
	expiredAt, err := parsePositiveInt64(request.ExpiredAt, "expiry")
	if err != nil {
		return signerResponse{}, err
	}
	apiKeyIndex := request.APIKeyIndex
	tx, err := client.GetCancelOrderTransaction(&types.CancelOrderTxReq{MarketIndex: request.CancelOrder.MarketIndex, Index: index}, &types.TransactOpts{FromAccountIndex: &accountIndex, ApiKeyIndex: &apiKeyIndex, Nonce: &nonce, ExpiredAt: expiredAt, TxAttributes: &types.L2TxAttributes{}})
	if err != nil {
		return signerResponse{}, err
	}
	return lifecycleResponse(tx, 15)
}

func signModifyOrder(request signerRequest) (signerResponse, error) {
	client, accountIndex, nonce, err := lifecycleClient(request)
	if err != nil || request.ModifyOrder == nil {
		return signerResponse{}, fmt.Errorf("invalid modify order request")
	}
	index, err := parsePositiveInt64(request.ModifyOrder.OrderIndex, "order index")
	if err != nil {
		return signerResponse{}, err
	}
	baseAmount, err := parsePositiveInt64(request.ModifyOrder.BaseAmount, "base amount")
	if err != nil {
		return signerResponse{}, err
	}
	price, err := parsePositiveUint32(request.ModifyOrder.Price, "price")
	if err != nil {
		return signerResponse{}, err
	}
	triggerPrice, err := parseNonNegativeUint32(request.ModifyOrder.TriggerPrice, "trigger price")
	if err != nil {
		return signerResponse{}, err
	}
	expiredAt, err := parsePositiveInt64(request.ExpiredAt, "expiry")
	if err != nil {
		return signerResponse{}, err
	}
	apiKeyIndex := request.APIKeyIndex
	tx, err := client.GetModifyOrderTransaction(&types.ModifyOrderTxReq{MarketIndex: request.ModifyOrder.MarketIndex, Index: index, BaseAmount: baseAmount, Price: price, TriggerPrice: triggerPrice}, &types.TransactOpts{FromAccountIndex: &accountIndex, ApiKeyIndex: &apiKeyIndex, Nonce: &nonce, ExpiredAt: expiredAt, TxAttributes: &types.L2TxAttributes{}})
	if err != nil {
		return signerResponse{}, err
	}
	return lifecycleResponse(tx, 17)
}

func signCancelAllOrders(request signerRequest) (signerResponse, error) {
	client, accountIndex, nonce, err := lifecycleClient(request)
	if err != nil || request.CancelAllOrders == nil {
		return signerResponse{}, fmt.Errorf("invalid cancel all request")
	}
	timeValue, err := parseNonNegativeInt64(request.CancelAllOrders.Time, "cancel all time")
	if err != nil {
		return signerResponse{}, err
	}
	expiredAt, err := parsePositiveInt64(request.ExpiredAt, "expiry")
	if err != nil {
		return signerResponse{}, err
	}
	apiKeyIndex := request.APIKeyIndex
	tx, err := client.GetCancelAllOrdersTransaction(&types.CancelAllOrdersTxReq{TimeInForce: request.CancelAllOrders.TimeInForce, Time: timeValue}, &types.TransactOpts{FromAccountIndex: &accountIndex, ApiKeyIndex: &apiKeyIndex, Nonce: &nonce, ExpiredAt: expiredAt, TxAttributes: &types.L2TxAttributes{}})
	if err != nil {
		return signerResponse{}, err
	}
	return lifecycleResponse(tx, 16)
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
