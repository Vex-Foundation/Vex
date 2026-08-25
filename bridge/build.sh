#!/usr/bin/env bash
#
# Build the Vex Studio MCP bridge.
#
# THE TOOLCHAIN IS EXACT, NOT A MINIMUM. go.mod's `go` directive is only a
# floor and Go will happily satisfy it with a newer toolchain (or download
# one), so exactness lives HERE: GOTOOLCHAIN=local forbids the download, and
# the version check below refuses any patch other than the pinned one. Raw
# `go build` in a packaging path bypasses both, which is why every packaging
# job calls this script instead.
#
# Usage:
#   bridge/build.sh                 # all six release targets
#   bridge/build.sh linux amd64     # one target
#
# Output: bridge/dist/<goos>-<goarch>/vex-mcp[.exe]
#
# Packaging identity, frozen with the contract: Electron x64 -> Go amd64,
# arm64 -> arm64, mac/win/linux -> darwin/windows/linux. The target list is the
# UNION of both electron-builder profiles (production mac arm64+x64, win x64,
# linux x64; dev additionally win arm64 and linux arm64).

set -euo pipefail

readonly REQUIRED_GO_VERSION="go1.27.0"
readonly BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DIST_DIR="${BRIDGE_DIR}/dist"

# Reproducibility pins:
#   CGO_ENABLED=0  a static binary with no host libc dependency, so the same
#                  artifact runs on every distribution the app ships to.
#   GOAMD64=v1     the baseline instruction set. A higher level would emit
#                  instructions some supported CPUs do not have.
#   GOARM64=v8.0   the same decision for arm64.
#   -trimpath      removes the builder's absolute paths from the binary.
#   -buildvcs=false  keeps the repository's commit and dirty state out of the
#                  artifact, so two builds of the same source match.
readonly LDFLAGS="-s -w"

TARGETS=(
  "darwin arm64"
  "darwin amd64"
  "windows amd64"
  "windows arm64"
  "linux amd64"
  "linux arm64"
)

main() {
  require_go

  if [ "$#" -eq 2 ]; then
    TARGETS=("$1 $2")
  elif [ "$#" -ne 0 ]; then
    echo "usage: $(basename "$0") [goos goarch]" >&2
    exit 2
  fi

  for target in "${TARGETS[@]}"; do
    # shellcheck disable=SC2086
    set -- $target
    build_one "$1" "$2"
  done
}

require_go() {
  if ! command -v go >/dev/null 2>&1; then
    echo "error: no 'go' on PATH. The Vex Studio bridge needs ${REQUIRED_GO_VERSION} exactly; see vex-app/DEV.md." >&2
    exit 1
  fi
  local reported
  reported="$(GOTOOLCHAIN=local go env GOVERSION)"
  if [ "$reported" != "$REQUIRED_GO_VERSION" ]; then
    echo "error: this toolchain reports '${reported}'; the bridge is pinned to '${REQUIRED_GO_VERSION}'." >&2
    echo "       The pin is exact, not a minimum: a different patch changes the emitted binary." >&2
    exit 1
  fi
}

build_one() {
  local goos="$1" goarch="$2"
  local out_dir="${DIST_DIR}/${goos}-${goarch}"
  local binary="vex-mcp"
  if [ "$goos" = "windows" ]; then
    binary="vex-mcp.exe"
  fi

  mkdir -p "$out_dir"
  (
    cd "$BRIDGE_DIR"
    GOTOOLCHAIN=local \
    CGO_ENABLED=0 \
    GOOS="$goos" \
    GOARCH="$goarch" \
    GOAMD64=v1 \
    GOARM64=v8.0 \
    go build -trimpath -buildvcs=false -ldflags "$LDFLAGS" \
      -o "${out_dir}/${binary}" ./cmd/vex-mcp
  )
  echo "built ${goos}-${goarch} -> dist/${goos}-${goarch}/${binary}"
}

main "$@"
