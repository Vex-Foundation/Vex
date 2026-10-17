#!/usr/bin/env bash
# run.sh <target> [model.gguf]
#
# Runs the embedding parity gate for one built target: the native tree at
# out/<target>/llama as the CANDIDATE, launched with the production flags and a
# per-launch API key, against the pinned reference image on the platform that
# target's users run today (Apple Silicon Macs: linux/arm64; Intel Macs, Linux
# and Windows x64: linux/amd64). Writes out/parity-<target>.json.
#
# linux-x64 runs inside ubuntu:22.04 (linux/amd64); --host 0.0.0.0 there is
# the one override, so the published port is reachable from the host.

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

target="${1:-}"
case " $NR_TARGETS " in *" $target "*) ;; *) nr_die "usage: run.sh <target> [model.gguf]" ;; esac
model="${2:-$NR_ROOT/.work/models/embeddinggemma-300M-Q8_0.gguf}"
tree="$NR_ROOT/out/$target/llama"
[ -x "$tree/llama-server" ] || nr_die "no built tree at $tree (run $target build first)"
[ -f "$model" ] || nr_die "model not found: $model"

UBUNTU_IMAGE="ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401"
ref_port=28134
cand_port=28135
# The runtime's thread rule (plan D9, as llama/smoke.mjs applies it):
# min(4, physical cores / 2), at least 1. ggml's threadpool spin-waits, so
# more threads than the machine has cores is drastically slower; a fixed 4
# made the candidate ~7x slower on a 2-vCPU CI runner.
if [ "$(uname -s)" = Darwin ]; then cores="$(sysctl -n hw.physicalcpu)"; else cores="$(nproc)"; fi
threads=$((cores / 2))
[ "$threads" -le 4 ] || threads=4
[ "$threads" -ge 1 ] || threads=1
api_key="$(openssl rand -hex 24)"
log="$NR_ROOT/.work/parity-$target-candidate.log"
cand_name="vex-parity-candidate-$cand_port"

case "$target" in
  darwin-arm64) platform=linux/arm64 ;;
  *) platform=linux/amd64 ;;
esac

cand_pid=""
cleanup() {
  [ -z "$cand_pid" ] || kill "$cand_pid" 2>/dev/null || true
  docker rm -f "$cand_name" >/dev/null 2>&1 || true
  "$NR_ROOT/parity/reference.sh" stop "$ref_port"
}
trap cleanup EXIT

"$NR_ROOT/parity/reference.sh" start "$ref_port" "$model" "$platform"

flags=(--embeddings --alias "ai/embeddinggemma:300M-Q8_0" --device none -ngl 0 -np 1
  -t "$threads" -tb "$threads" --no-webui --offline)
cache="$(mktemp -d)"
case "$target" in
  darwin-*)
    # Minimal environment, as the runtime host will spawn it; LLAMA_CACHE is
    # required on macOS (b9115 dereferences a NULL $HOME without it).
    env -i PATH=/usr/bin:/bin LLAMA_API_KEY="$api_key" LLAMA_CACHE="$cache" \
      "$tree/llama-server" --model "$model" --host 127.0.0.1 --port "$cand_port" "${flags[@]}" \
      >"$log" 2>&1 &
    cand_pid=$!
    ;;
  linux-x64)
    LLAMA_API_KEY="$api_key" docker run --rm --name "$cand_name" --platform linux/amd64 \
      -e LLAMA_API_KEY -e LLAMA_CACHE=/tmp/llama-cache \
      --mount "type=bind,source=$tree,target=/opt/vex/llama,readonly" \
      --mount "type=bind,source=$(dirname "$model"),target=/models,readonly" \
      -p "127.0.0.1:$cand_port:$cand_port" "$UBUNTU_IMAGE" \
      /opt/vex/llama/llama-server --model "/models/$(basename "$model")" \
      --host 0.0.0.0 --port "$cand_port" "${flags[@]}" >"$log" 2>&1 &
    cand_pid=$!
    ;;
esac

for _ in $(seq 1 600); do
  grep -q "server is listening on" "$log" 2>/dev/null && break
  kill -0 "$cand_pid" 2>/dev/null || { cat "$log" >&2; nr_die "candidate exited before listening"; }
  sleep 1
done
grep -q "server is listening on" "$log" || nr_die "candidate never reported listening"
nr_log "candidate $target: $(grep -m1 -o 'load_backend: loaded CPU backend from .*' "$log" | sed 's|.*/||' || true)"

mkdir -p "$NR_ROOT/out"
cd "$NR_ROOT/.."
NR_CANDIDATE_API_KEY="$api_key" node_modules/.bin/tsx native-runtime/parity/parity.ts \
  --reference "http://127.0.0.1:$ref_port/v1" \
  --candidate "http://127.0.0.1:$cand_port/v1" \
  --out "$NR_ROOT/out/parity-$target.json"
