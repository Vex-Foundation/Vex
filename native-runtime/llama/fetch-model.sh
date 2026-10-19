#!/usr/bin/env bash
# fetch-model.sh
#
# Puts the pinned embeddings model at native-runtime/.work/models/, verified
# against the sha256 the app pins. Filename, URL and checksum are read from
# vex-app/src/main/onboarding/embedding-defaults.ts so the pin has one home.

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

DEFAULTS="$NR_ROOT/../vex-app/src/main/onboarding/embedding-defaults.ts"
pinned() {
  # The value is the first double-quoted string after `export const <name> =`,
  # which may sit on the next line.
  awk -v name="$1" '
    $0 ~ "export const " name " =" { found = 1 }
    found && match($0, /"[^"]+"/) { print substr($0, RSTART + 1, RLENGTH - 2); exit }
  ' "$DEFAULTS"
}

file="$(pinned EMBEDDING_MODEL_FILENAME)"
sha="$(pinned EMBEDDING_MODEL_SHA256)"
url="$(pinned EMBEDDING_MODEL_DOWNLOAD_URL)"
[ -n "$file" ] && [[ "$sha" =~ ^[0-9a-f]{64}$ ]] && [[ "$url" == https://* ]] ||
  nr_die "could not read the model pin from $DEFAULTS"

nr_fetch_verified "$url" "$sha" "$NR_ROOT/.work/models/$file"
nr_log "model ready: $NR_ROOT/.work/models/$file"
