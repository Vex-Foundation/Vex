package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/elliottech/lighter-go/types"
	"github.com/elliottech/lighter-go/types/txtypes"
	schnorr "github.com/elliottech/poseidon_crypto/signature/schnorr"
	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
)

type integratorFeesRequest struct {
	IntegratorAccountIndex int64  `json:"integratorAccountIndex"`
	IntegratorMakerFee     uint32 `json:"integratorMakerFee"`
	IntegratorTakerFee     uint32 `json:"integratorTakerFee"`
}

type approveIntegratorRequest struct {
	IntegratorAccountIndex int64  `json:"integratorAccountIndex"`
	MaxPerpsMakerFee       uint32 `json:"maxPerpsMakerFee"`
	MaxPerpsTakerFee       uint32 `json:"maxPerpsTakerFee"`
	MaxSpotMakerFee        uint32 `json:"maxSpotMakerFee"`
	MaxSpotTakerFee        uint32 `json:"maxSpotTakerFee"`
	ApprovalExpiry         int64  `json:"approvalExpiry"`
}

func integratorAttributes(fees *integratorFeesRequest) (*types.L2TxAttributes, error) {
	if fees == nil {
		return &types.L2TxAttributes{}, nil
	}
	if fees.IntegratorAccountIndex < 1 || fees.IntegratorAccountIndex > txtypes.MaxAccountIndex || int64(fees.IntegratorMakerFee) > txtypes.FeeTick || int64(fees.IntegratorTakerFee) > txtypes.FeeTick {
		return nil, fmt.Errorf("invalid integrator fee attributes")
	}
	return &types.L2TxAttributes{IntegratorAccountIndex: &fees.IntegratorAccountIndex, IntegratorMakerFee: &fees.IntegratorMakerFee, IntegratorTakerFee: &fees.IntegratorTakerFee}, nil
}

func validateApproveIntegratorRequest(request signerRequest) error {
	if !isSupportedRegistrationChainID(request.ChainID) || request.ApproveIntegrator == nil || request.APIKeyIndex < 4 || request.APIKeyIndex > 254 {
		return fmt.Errorf("invalid integrator authorization scope")
	}
	account, err := parsePositiveInt64(request.AccountIndex, "account index")
	if err != nil || account > txtypes.MaxAccountIndex {
		return fmt.Errorf("invalid integrator authorization account")
	}
	nonce, err := parseNonNegativeInt64(request.Nonce, "nonce")
	if err != nil || nonce > maxRegistrationNonce {
		return fmt.Errorf("invalid integrator authorization nonce")
	}
	expiry, err := parsePositiveInt64(request.ExpiredAt, "expiry")
	now := time.Now().UnixMilli()
	if err != nil || expiry < now+minWithdrawExpiryLead || expiry > now+maxWithdrawExpiryLead {
		return fmt.Errorf("invalid integrator transaction expiry")
	}
	approval := request.ApproveIntegrator
	if approval.IntegratorAccountIndex < 1 || approval.IntegratorAccountIndex > txtypes.MaxAccountIndex || approval.ApprovalExpiry < 0 || approval.ApprovalExpiry > txtypes.MaxTimestamp {
		return fmt.Errorf("invalid integrator permission")
	}
	caps := []uint32{approval.MaxPerpsMakerFee, approval.MaxPerpsTakerFee, approval.MaxSpotMakerFee, approval.MaxSpotTakerFee}
	for _, cap := range caps {
		if int64(cap) > txtypes.FeeTick || (approval.ApprovalExpiry == 0 && cap != 0) {
			return fmt.Errorf("invalid integrator cap")
		}
	}
	if approval.ApprovalExpiry != 0 && approval.ApprovalExpiry <= now {
		return fmt.Errorf("expired integrator permission")
	}
	if !common.IsHexAddress(request.ExpectedL1Address) {
		return fmt.Errorf("invalid expected wallet")
	}
	if approval.ApprovalExpiry == 0 && request.L1Signature == "" {
		return nil
	}
	if !l1SignaturePattern.MatchString(request.L1Signature) {
		return fmt.Errorf("invalid integrator wallet signature")
	}
	recovery := strings.ToLower(request.L1Signature[len(request.L1Signature)-2:])
	if recovery != "00" && recovery != "01" && recovery != "1b" && recovery != "1c" {
		return fmt.Errorf("invalid integrator wallet signature recovery")
	}
	return nil
}

func signApproveIntegrator(request signerRequest) (signerResponse, error) {
	if err := validateApproveIntegratorRequest(request); err != nil {
		return signerResponse{}, err
	}
	client, accountIndex, nonce, err := lifecycleClient(request)
	if err != nil {
		return signerResponse{}, err
	}
	expiredAt, err := parsePositiveInt64(request.ExpiredAt, "expiry")
	if err != nil {
		return signerResponse{}, err
	}
	approval := request.ApproveIntegrator
	apiKeyIndex := request.APIKeyIndex
	tx, err := types.ConstructApproveIntegratorTx(client.GetKeyManager(), request.ChainID,
		&types.ApproveIntegratorTxReq{IntegratorAccountIndex: approval.IntegratorAccountIndex,
			MaxPerpsMakerFee: approval.MaxPerpsMakerFee, MaxPerpsTakerFee: approval.MaxPerpsTakerFee,
			MaxSpotMakerFee: approval.MaxSpotMakerFee, MaxSpotTakerFee: approval.MaxSpotTakerFee, ApprovalExpiry: approval.ApprovalExpiry},
		&types.TransactOpts{FromAccountIndex: &accountIndex, ApiKeyIndex: &apiKeyIndex, Nonce: &nonce, ExpiredAt: expiredAt, TxAttributes: &types.L2TxAttributes{}})
	if err != nil {
		return signerResponse{}, err
	}
	message := tx.GetL1SignatureBody(request.ChainID)
	if request.L1Signature != "" {
		signature, err := hexutil.Decode(request.L1Signature)
		if err != nil {
			return signerResponse{}, fmt.Errorf("invalid integrator wallet signature")
		}
		if signature[64] >= 27 {
			signature[64] -= 27
		}
		publicKey, err := crypto.SigToPub(accounts.TextHash([]byte(message)), signature)
		if err != nil || crypto.PubkeyToAddress(*publicKey) != common.HexToAddress(request.ExpectedL1Address) {
			return signerResponse{}, fmt.Errorf("integrator signature does not match expected wallet")
		}
	}
	tx.L1Sig = request.L1Signature
	hash, err := tx.Hash(request.ChainID)
	if err != nil {
		return signerResponse{}, err
	}
	publicKey := client.GetKeyManager().PubKeyBytes()
	if err := schnorr.Validate(publicKey[:], hash, tx.Sig); err != nil {
		return signerResponse{}, fmt.Errorf("invalid integrator l2 signature")
	}
	result, err := lifecycleResponse(tx, txtypes.TxTypeL2ApproveIntegrator)
	if err != nil {
		return signerResponse{}, err
	}
	result.MessageToSign = message
	return result, nil
}
