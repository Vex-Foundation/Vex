package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/elliottech/lighter-go/types/txtypes"
	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
)

func approvalFixture(t *testing.T, chain uint32) signerRequest {
	t.Helper()
	wallet, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	expiry := time.Now().Add(2 * time.Minute).UnixMilli()
	approval := &approveIntegratorRequest{IntegratorAccountIndex: 123, MaxPerpsMakerFee: 1000, MaxPerpsTakerFee: 1000, MaxSpotMakerFee: 2500, MaxSpotTakerFee: 2500, ApprovalExpiry: time.Now().Add(365 * 24 * time.Hour).UnixMilli()}
	request := signerRequest{Operation: "signApproveIntegrator", PrivateKey: strings.Repeat("1", 80), ChainID: chain, AccountIndex: "42", APIKeyIndex: 7, Nonce: "9", ExpiredAt: fmt.Sprint(expiry), ExpectedL1Address: crypto.PubkeyToAddress(wallet.PublicKey).Hex(), ApproveIntegrator: approval}
	tx := &txtypes.L2ApproveIntegratorTxInfo{AccountIndex: 42, ApiKeyIndex: 7, Nonce: 9, ExpiredAt: expiry, IntegratorAccountIndex: 123, MaxPerpsMakerFee: 1000, MaxPerpsTakerFee: 1000, MaxSpotMakerFee: 2500, MaxSpotTakerFee: 2500, ApprovalExpiry: approval.ApprovalExpiry}
	signature, err := crypto.Sign(accounts.TextHash([]byte(tx.GetL1SignatureBody(chain))), wallet)
	if err != nil {
		t.Fatal(err)
	}
	request.L1Signature = hexutil.Encode(signature)
	return request
}

func TestIntegratorApprovalSignsOfficialTermsAndRejectsDrift(t *testing.T) {
	for _, chain := range []uint32{lighterCoreChainID, lighterRHCChainID} {
		request := approvalFixture(t, chain)
		result, err := signApproveIntegrator(request)
		if err != nil || result.TxType != 45 {
			t.Fatalf("approval signing failed: %v", err)
		}
		var tx txtypes.L2ApproveIntegratorTxInfo
		if err = json.Unmarshal([]byte(result.TxInfo), &tx); err != nil {
			t.Fatal(err)
		}
		if tx.IntegratorAccountIndex != 123 || tx.MaxSpotMakerFee != 2500 || tx.MaxPerpsTakerFee != 1000 || tx.L1Sig != request.L1Signature || tx.ApprovalExpiry != request.ApproveIntegrator.ApprovalExpiry {
			t.Fatal("signed approval terms changed")
		}
		if result.MessageToSign != tx.GetL1SignatureBody(chain) {
			t.Fatal("incorrect official wallet message")
		}
		request.ApproveIntegrator.IntegratorAccountIndex = 124
		if _, err = signApproveIntegrator(request); err == nil {
			t.Fatal("accepted signature for another collector")
		}
	}
}

func TestIntegratorApprovalRevocationRequiresZeroCaps(t *testing.T) {
	request := approvalFixture(t, lighterCoreChainID)
	request.ApproveIntegrator = &approveIntegratorRequest{IntegratorAccountIndex: 123}
	request.L1Signature = ""
	if _, err := signApproveIntegrator(request); err != nil {
		t.Fatalf("L2-only revocation failed: %v", err)
	}
	request.ApproveIntegrator.MaxSpotMakerFee = 1
	if _, err := signApproveIntegrator(request); err == nil {
		t.Fatal("revocation with fee accepted")
	}
	request.ApproveIntegrator.MaxSpotMakerFee = 0
	request.ApproveIntegrator.ApprovalExpiry = time.Now().Add(time.Hour).UnixMilli()
	if _, err := signApproveIntegrator(request); err == nil {
		t.Fatal("new allowance accepted without L1 signature")
	}
}

func TestIntegratorAttributesBoundInEveryOrderPath(t *testing.T) {
	base := signerRequest{PrivateKey: strings.Repeat("1", 80), ChainID: lighterCoreChainID, AccountIndex: "42", APIKeyIndex: 7, Nonce: "9", ExpiredAt: fmt.Sprint(time.Now().Add(2 * time.Minute).UnixMilli()), IntegratorFees: &integratorFeesRequest{IntegratorAccountIndex: 123, IntegratorMakerFee: 1000, IntegratorTakerFee: 1000}}
	order := createOrderRequest{MarketIndex: 0, ClientOrderIndex: "101", BaseAmount: "12500", Price: "280000", IsAsk: 1, OrderType: 0, TimeInForce: 1, TriggerPrice: "0", OrderExpiry: "1893456000000"}
	create := base
	create.Order = &order
	group := base
	child1 := order
	child1.OrderType = 2
	child1.TimeInForce = 0
	child1.ReduceOnly = 1
	child1.TriggerPrice = "285000"
	child2 := child1
	child2.OrderType = 4
	child2.ClientOrderIndex = "102"
	child2.TriggerPrice = "330000"
	group.GroupedOrders = &groupedOrdersRequest{GroupingType: 2, Orders: []createOrderRequest{child1, child2}}
	modify := base
	modify.ModifyOrder = &modifyOrderRequest{MarketIndex: 0, OrderIndex: "1234", BaseAmount: "12500", Price: "280000", TriggerPrice: "0"}
	for _, test := range []struct {
		name    string
		request signerRequest
		sign    func(signerRequest) (signerResponse, error)
	}{{"create", create, signCreateOrder}, {"group", group, signCreateGroupedOrders}, {"modify", modify, signModifyOrder}} {
		t.Run(test.name, func(t *testing.T) {
			result, err := test.sign(test.request)
			if err != nil {
				t.Fatal(err)
			}
			var tx struct{ L2TxAttributes map[string]int64 }
			if err = json.Unmarshal([]byte(result.TxInfo), &tx); err != nil {
				t.Fatal(err)
			}
			if tx.L2TxAttributes["1"] != 123 || tx.L2TxAttributes["2"] != 1000 || tx.L2TxAttributes["3"] != 1000 {
				t.Fatal("missing signed integrator attributes")
			}
			changed := *test.request.IntegratorFees
			changed.IntegratorTakerFee = 999
			test.request.IntegratorFees = &changed
			second, err := test.sign(test.request)
			if err != nil {
				t.Fatal(err)
			}
			if second.TxHash == result.TxHash {
				t.Fatal("fee change did not change transaction hash")
			}
		})
	}
}
