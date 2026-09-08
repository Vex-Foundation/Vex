// Command wire-constants prints the Lighter order-type and time-in-force wire
// codes of the PINNED github.com/elliottech/lighter-go as JSON.
//
// Why it exists: the TypeScript side has to turn "limit" or "post-only" into
// the integer the signer puts on the wire, and those integers were hand-spelled
// in src/tools/lighter/signer-order.ts. A hand-spelled wire value is a defect
// even when it happens to be right (rule 10, "wire names come from machine
// artifacts, never convention"): nothing fails when the provider renumbers a
// member or inserts one, and the failure is a correctly signed order of the
// wrong type.
//
// This program is the machine artifact's reader. It imports the same txtypes
// package the signer itself links against, so the numbers below are the ones
// the pinned module would actually emit - not a copy of its source, and not a
// copy of its documentation. Its output is checked in next to it as
// wire-constants.json, and src/__tests__/vex-agent/tools/lighter-wire-codes.test.ts
// table-tests both TypeScript maps against that file, in both directions.
//
// REGENERATE with, from src/tools/lighter/signer-runtime:
//
//	go run ./cmd/wire-constants > wire-constants.json
//
// Run it whenever the lighter-go pin in go.mod moves. A diff in the output is a
// wire-contract change and is reviewed as one: the test turns it into a red
// suite, which is the whole point.
//
// Nothing here reaches the network, reads a key, or writes anywhere but stdout.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"

	"github.com/elliottech/lighter-go/types/txtypes"
)

// artifact is the shape wire-constants.json holds. Both maps are keyed by the
// EXPORTED Go identifier so a rename in lighter-go shows up as a key diff
// rather than silently re-pointing a value.
type artifact struct {
	Source          string         `json:"source"`
	Generator       string         `json:"generator"`
	Regenerate      string         `json:"regenerate"`
	OrderTypes      map[string]int `json:"orderTypes"`
	TimeInForce     map[string]int `json:"timeInForce"`
	ApiMaxOrderType int            `json:"apiMaxOrderType"`
}

func main() {
	out := artifact{
		Source:     "github.com/elliottech/lighter-go/types/txtypes (version pinned in ../../go.mod)",
		Generator:  "src/tools/lighter/signer-runtime/cmd/wire-constants",
		Regenerate: "cd src/tools/lighter/signer-runtime && go run ./cmd/wire-constants > wire-constants.json",
		// USER-SETTABLE order types only. TWAPSubOrder (7) and LiquidationOrder
		// (8) are internal to the exchange - lighter-go marks them so, and
		// ApiMaxOrderType is the provider's own statement of where the API
		// surface ends. Emitting them would invite the TypeScript side to offer
		// an order type the venue refuses from a client.
		OrderTypes: map[string]int{
			"LimitOrder":           txtypes.LimitOrder,
			"MarketOrder":          txtypes.MarketOrder,
			"StopLossOrder":        txtypes.StopLossOrder,
			"StopLossLimitOrder":   txtypes.StopLossLimitOrder,
			"TakeProfitOrder":      txtypes.TakeProfitOrder,
			"TakeProfitLimitOrder": txtypes.TakeProfitLimitOrder,
			"TWAPOrder":            txtypes.TWAPOrder,
		},
		TimeInForce: map[string]int{
			"ImmediateOrCancel": txtypes.ImmediateOrCancel,
			"GoodTillTime":      txtypes.GoodTillTime,
			"PostOnly":          txtypes.PostOnly,
		},
		ApiMaxOrderType: txtypes.ApiMaxOrderType,
	}

	// An Encoder rather than MarshalIndent: MarshalIndent escapes "&", "<" and
	// ">" as \u0026, \u003c and \u003e, which would turn the human-readable
	// regenerate line into an artifact diff on every CI run.
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(out); err != nil {
		fmt.Fprintf(os.Stderr, "wire-constants: %v\n", err)
		os.Exit(1)
	}
	if _, err := os.Stdout.Write(buffer.Bytes()); err != nil {
		fmt.Fprintf(os.Stderr, "wire-constants: %v\n", err)
		os.Exit(1)
	}
}
