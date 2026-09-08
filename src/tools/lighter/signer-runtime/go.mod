module github.com/vex-foundation/vex/lighter-signer-runtime

go 1.23.0

// Pins the COMPILER; the `go` line above is only the language floor. Kept
// strictly above that floor so `go mod tidy` cannot drop it as redundant.
// `actions/setup-go` reads this file (go-version-file) and
// scripts/verify-runtime-toolchain.mjs reads this directive, so the Go that
// builds the Lighter signing helper has exactly one home. 1.27.0 is the version
// the bridge jobs already pin in .github/workflows/ci.yml.
toolchain go1.27.0

require github.com/elliottech/lighter-go v1.0.7

require (
	github.com/bits-and-blooms/bitset v1.17.0 // indirect
	github.com/consensys/bavard v0.1.22 // indirect
	github.com/consensys/gnark-crypto v0.14.0 // indirect
	github.com/crate-crypto/go-ipa v0.0.0-20240724233137-53bbb0ceb27a // indirect
	github.com/crate-crypto/go-kzg-4844 v1.1.0 // indirect
	github.com/decred/dcrd/dcrec/secp256k1/v4 v4.0.1 // indirect
	github.com/elliottech/poseidon_crypto v0.0.15 // indirect
	github.com/ethereum/c-kzg-4844 v1.0.0 // indirect
	github.com/ethereum/go-ethereum v1.15.6 // indirect
	github.com/ethereum/go-verkle v0.2.2 // indirect
	github.com/holiman/uint256 v1.3.2 // indirect
	github.com/mmcloughlin/addchain v0.4.0 // indirect
	github.com/supranational/blst v0.3.14 // indirect
	golang.org/x/crypto v0.35.0 // indirect
	golang.org/x/sync v0.11.0 // indirect
	golang.org/x/sys v0.30.0 // indirect
	rsc.io/tmplfunc v0.0.3 // indirect
)
