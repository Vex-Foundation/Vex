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
  "$LINUX_BUILD_IMAGE" \
  bash -c 'set -euo pipefail
    dnf install -y -q bison flex perl-FindBin perl-File-Compare zlib-devel git >/dev/null
    # The bind mount is owned by the host user, not root.
    git config --global --add safe.directory "*"
    exec "./$0/build.sh" linux-x64 "$@"' "$component" "$@"
