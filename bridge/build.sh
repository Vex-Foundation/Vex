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
# Output: bridge/dist/<goos>-<goarch>/<artifact>[.exe], one file per artifact
# the table below lists for that triple.
#
# Packaging identity, frozen with the contract: Electron x64 -> Go amd64,
# arm64 -> arm64, mac/win/linux -> darwin/windows/linux. The target list is the
# UNION of both electron-builder profiles (production mac arm64+x64, win x64,
# linux x64; dev additionally win arm64 and linux arm64).
#
# THE ARTIFACT TABLE IS MIRRORED, NOT OWNED, HERE. Its one owner is
# vex-app/scripts/bridge-artifact.mjs (BRIDGE_ARTIFACTS), which every Node-side
# gate reads. Bash cannot import that module, so the ARTIFACTS block below is a
# deliberate mirror and the drift between the two is a TESTED invariant:
# vex-app/src/main/studio/__tests__/bridge-packaging-identity.test.ts parses
# this block out of this file and compares it, whole, against the table. Edit
# both or the test fails.

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
#
# Identity the front announces in HELLO_ACK (`frontVersion`, `buildHash`),
# recorded by main for support bundles and binding nothing (protocol section
# 6.1). Both values are functions of the TREE, never of git state, so the
# reproducibility promise above holds: the app version comes from
# vex-app/package.json and the hash is a digest of the bridge sources. vex-mcp
# declares neither symbol and the linker ignores an -X for a symbol that does
# not exist, so one LDFLAGS serves every artifact.
front_version() {
  sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "${BRIDGE_DIR}/../vex-app/package.json" | head -n 1
}

bridge_sources_digest() {
  local digest
  digest="$(
    cd "$BRIDGE_DIR" &&
      { find . -name '*.go' -type f -print; echo ./go.mod; echo ./go.sum; echo ./build.sh; } |
      LC_ALL=C sort -u |
      xargs cat |
      { sha256sum 2>/dev/null || shasum -a 256; }
  )" || return 1
  printf '%s\n' "${digest%% *}"
}

FRONT_VERSION="$(front_version)"
if [ -z "$FRONT_VERSION" ]; then
  FRONT_VERSION="unknown"
  echo "warning: vex-app/package.json carries no version; the front announces frontVersion=unknown" >&2
fi
BUILD_HASH="$(bridge_sources_digest)" || BUILD_HASH=""
if [ -z "$BUILD_HASH" ]; then
  BUILD_HASH="unknown"
  echo "warning: no sha256sum or shasum on PATH; the front announces buildHash=unknown" >&2
fi
readonly LDFLAGS="-s -w -X main.frontVersion=${FRONT_VERSION} -X main.buildHash=${BUILD_HASH:0:12}"

TARGETS=(
  "darwin arm64"
  "darwin amd64"
  "windows amd64"
  "windows arm64"
  "linux amd64"
  "linux arm64"
)

# name, Go package path, then every <goos>-<goarch> triple it is built for.
# Mirror of BRIDGE_ARTIFACTS; see the header.
ARTIFACTS=(
  "vex-mcp ./cmd/vex-mcp darwin-arm64 darwin-amd64 windows-amd64 windows-arm64 linux-amd64 linux-arm64"
  "vex-pipe-front ./cmd/vex-pipe-front windows-amd64 windows-arm64"
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
    build_target "$1" "$2"
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

# Every artifact the table lists for one triple, into a directory this script
# owns exclusively.
#
# The directory is CLEARED first. Without it, an artifact that stops being
# built for a triple - or one left behind by an older checkout - would sit
# beside the current outputs until someone deleted it by hand. Every consumer
# addresses the artifacts by name from the table, so a leftover cannot ship,
# but it can mislead a developer reading the directory.
build_target() {
  local goos="$1" goarch="$2"
  local triple="${goos}-${goarch}"
  local out_dir="${DIST_DIR}/${triple}"
  local entry name pkg listed built=0

  for entry in "${ARTIFACTS[@]}"; do
    # shellcheck disable=SC2086
    set -- $entry
    name="$1"
    pkg="$2"
    shift 2
    for listed in "$@"; do
      if [ "$listed" = "$triple" ]; then
        if [ "$built" -eq 0 ]; then
          rm -rf "$out_dir"
          mkdir -p "$out_dir"
        fi
        build_one "$goos" "$goarch" "$out_dir" "$name" "$pkg"
        built=$((built + 1))
        break
      fi
    done
  done

  if [ "$built" -eq 0 ]; then
    echo "error: no artifact is built for '${triple}'; see the ARTIFACTS table in $(basename "$0")." >&2
    exit 1
  fi
}

build_one() {
  local goos="$1" goarch="$2" out_dir="$3" name="$4" pkg="$5"
  local binary="$name"
  if [ "$goos" = "windows" ]; then
    binary="${name}.exe"
  fi

  (
    cd "$BRIDGE_DIR"
    GOTOOLCHAIN=local \
    CGO_ENABLED=0 \
    GOOS="$goos" \
    GOARCH="$goarch" \
    GOAMD64=v1 \
    GOARM64=v8.0 \
    go build -trimpath -buildvcs=false -ldflags "$LDFLAGS" \
      -o "${out_dir}/${binary}" "$pkg"
  )
  echo "built ${goos}-${goarch} -> dist/${goos}-${goarch}/${binary}"
}

main "$@"
