#!/usr/bin/env bash
# build-in-container.sh <component> [args...]
#
# Runs native-runtime/<component>/build.sh linux-x64 inside the pinned
# manylinux_2_28 image, so a Linux build is the same on a Mac, a Linux laptop
# and CI. The native-runtime directory is bind-mounted, so the finished tree
# lands in native-runtime/out/linux-x64/ on the host.

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

component="${1:-}"
[ -n "$component" ] && [ -x "$NR_ROOT/$component/build.sh" ] ||
  nr_die "usage: build-in-container.sh <component> (one of: $(cd "$NR_ROOT" && ls -d */ | tr -d / | tr '\n' ' '))"
shift

# --platform matters on Apple Silicon: the image must run as x86_64, the
# target we ship, not be resolved to some other variant.
exec docker run --rm --platform linux/amd64 \
  -v "$NR_ROOT:/native-runtime" \
  -w /native-runtime \
  -e NR_PYTHON=/opt/python/cp312-cp312/bin/python3 \
  -e NR_HOST_UID="$(id -u)" -e NR_HOST_GID="$(id -g)" \
  "$LINUX_BUILD_IMAGE" \
  bash -c 'set -euo pipefail
    # On a Linux host the build runs as root and would leave root-owned
    # .work/ and out/ for the calling user (Docker Desktop maps this away on
    # macOS); hand them back whatever the outcome.
    trap "chown -R \"\$NR_HOST_UID:\$NR_HOST_GID\" .work out 2>/dev/null || true" EXIT
    dnf install -y -q bison flex perl-interpreter zlib-devel git >/dev/null
    # The bind mount is owned by the host user, not root.
    git config --global --add safe.directory "*"
    "./$0/build.sh" linux-x64 "$@"' "$component" "$@"
