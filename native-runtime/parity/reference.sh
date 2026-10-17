#!/usr/bin/env bash
# reference.sh start <port> <model.gguf> <linux/arm64|linux/amd64>
# reference.sh stop <port>
#
# Runs today's embeddings server, the pinned llama.cpp server-b9115 image, with
# the exact arguments the compose stack uses, as the parity REFERENCE. The
# image reference is read from the compose template so there is one pin.

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

TEMPLATE="$NR_ROOT/../vex-app/resources/compose/docker-compose.template.yml"
IMAGE="$(awk '/image: ghcr.io\/ggml-org\/llama.cpp:/{print $2; exit}' "$TEMPLATE")"
[ -n "$IMAGE" ] || nr_die "no llama.cpp image in $TEMPLATE"

cmd="${1:-}"
port="${2:-}"
[[ "$port" =~ ^[0-9]+$ ]] || nr_die "usage: reference.sh start <port> <model.gguf> <platform> | stop <port>"
name="vex-parity-reference-$port"

case "$cmd" in
  start)
    model="${3:-}"
    platform="${4:-}"
    [ -f "$model" ] || nr_die "model not found: $model"
    case "$platform" in linux/arm64 | linux/amd64) ;; *) nr_die "platform must be linux/arm64 or linux/amd64" ;; esac
    # Run the platform's own manifest, as listed in the pinned index: Docker's
    # classic image store keeps one platform per reference, so the index
    # digest alone cannot hold the arm64 and amd64 images side by side.
    repo="${IMAGE%%[:@]*}"
    index_digest="${IMAGE##*@}"
    path="${repo#ghcr.io/}"
    token="$(curl -fsSL "https://ghcr.io/token?scope=repository:$path:pull&service=ghcr.io" |
      python3 -c 'import sys, json; print(json.load(sys.stdin)["token"])')"
    child="$(curl -fsSL -H "Authorization: Bearer $token" \
      -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
      "https://ghcr.io/v2/$path/manifests/$index_digest" |
      python3 -c 'import sys, json
os_, arch = sys.argv[1].split("/")
print(next(m["digest"] for m in json.load(sys.stdin)["manifests"]
           if m["platform"]["os"] == os_ and m["platform"]["architecture"] == arch))' "$platform")"
    [ -n "$child" ] || nr_die "pinned index $index_digest lists no $platform image"
    docker run -d --rm --name "$name" --platform "$platform" \
      -p "127.0.0.1:$port:8080" \
      -v "$(dirname "$model"):/models:ro" \
      "$repo@$child" \
      --model "/models/$(basename "$model")" \
      --embeddings --alias "ai/embeddinggemma:300M-Q8_0" \
      --host 0.0.0.0 --port 8080 >/dev/null
    for _ in $(seq 1 300); do
      if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health")" = 200 ]; then
        nr_log "reference $IMAGE ($platform: $child) ready on 127.0.0.1:$port"
        exit 0
      fi
      sleep 1
    done
    docker logs "$name" >&2 || true
    docker rm -f "$name" >/dev/null 2>&1 || true
    nr_die "reference server did not become healthy"
    ;;
  stop)
    docker rm -f "$name" >/dev/null 2>&1 || true
    ;;
  *) nr_die "usage: reference.sh start|stop ..." ;;
esac
