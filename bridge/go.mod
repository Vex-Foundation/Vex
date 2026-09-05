module github.com/Vex-Foundation/vex/bridge

// NO `toolchain` DIRECTIVE, and that is Go's decision rather than an omission.
// A toolchain line is recorded only when it EXCEEDS the go directive; with
// `go 1.27.0` already naming the pinned patch, `toolchain go1.27.0` is
// redundant and `go mod tidy` deletes it, while leaving it in place makes
// every build fail with "updates to go.mod needed" (verified on go1.27.0).
//
// Neither directive is exactness anyway - both are MINIMUMS that a newer
// toolchain satisfies. Exactness lives in bridge/build.sh, which runs with
// GOTOOLCHAIN=local (no download) and refuses any GOVERSION other than the
// pinned patch. Every packaging and CI path calls that script.
go 1.27.0

require (
	github.com/Microsoft/go-winio v0.6.2
	golang.org/x/sys v0.10.0
)
