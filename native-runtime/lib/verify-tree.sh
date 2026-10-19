#!/usr/bin/env bash
# verify-tree.sh <tree> <target>
#
# Refuses a runtime tree that would not run on every machine of its target:
# wrong architecture, a macOS floor above MACOS_DEPLOYMENT_TARGET, a glibc
# symbol above LINUX_GLIBC_MAX, an absolute rpath or install name that points
# at the build machine, or a dependency on a system library a clean install
# does not have. Runs on the build platform (otool/lipo on macOS, readelf on
# Linux). Windows trees are checked by lib/pe.mjs (machine type, imports
# resolvable on a clean Windows 10/11 without the VC++ redistributable, no
# PDB path); it needs only Node.

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

tree="${1:-}"
target="${2:-}"
[ -d "$tree" ] || nr_die "usage: verify-tree.sh <tree> <target>"
nr_require_target "$target"

failures=0
fail() { nr_log "FAIL $1"; failures=$((failures + 1)); }

# Files the tree itself provides, so a dependency on one of them is satisfied.
own_libs="$(find "$tree" -type f \( -name '*.dylib' -o -name '*.so' -o -name '*.so.*' \) -exec basename {} \; | sort -u)"

version_le() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$1" ]; }

verify_macho() {
  local f="$1" want_arch="$2" archs minos
  archs="$(lipo -archs "$f" 2>/dev/null || true)"
  [ "$archs" = "$want_arch" ] || fail "$f: arch '$archs', expected '$want_arch'"

  minos="$(otool -l "$f" | awk '/LC_BUILD_VERSION/{b=1} b&&/minos/{print $2; exit}')"
  if [ -z "$minos" ]; then
    minos="$(otool -l "$f" | awk '/LC_VERSION_MIN_MACOSX/{b=1} b&&/version/{print $2; exit}')"
  fi
  [ -n "$minos" ] || fail "$f: no minimum macOS version load command"
  [ -z "$minos" ] || version_le "$minos" "$MACOS_DEPLOYMENT_TARGET" ||
    fail "$f: minos $minos is above the $MACOS_DEPLOYMENT_TARGET floor"

  # Dependencies: the OS, or something resolved relative to the binary.
  while read -r dep; do
    case "$dep" in
      /usr/lib/* | /System/Library/*) ;;
      @rpath/* | @loader_path/* | @executable_path/*) ;;
      *) fail "$f: links $dep (absolute path outside the OS)" ;;
    esac
  done < <(otool -L "$f" | tail -n +2 | awk '{print $1}' | grep -v "^$f:\$" || true)

  while read -r rpath; do
    case "$rpath" in
      @loader_path* | @executable_path*) ;;
      *) fail "$f: LC_RPATH $rpath is not relative to the binary" ;;
    esac
  done < <(otool -l "$f" | awk '/LC_RPATH/{b=1} b&&/ path /{print $2; b=0}')

  if otool -hv "$f" | grep -q DYLIB; then
    local id
    id="$(otool -D "$f" | tail -n +2)"
    case "$id" in
      @rpath/* | @loader_path/* | "") ;;
      *) fail "$f: install name $id is absolute" ;;
    esac
  fi
}

verify_elf() {
  local f="$1" machine glibc
  machine="$(readelf -h "$f" | awk -F: '/Machine:/{gsub(/^ +/,"",$2); print $2}')"
  [ "$machine" = "Advanced Micro Devices X86-64" ] || fail "$f: machine '$machine', expected x86-64"

  # A binary may reference no versioned glibc symbol at all; grep finding
  # nothing must not abort the script under pipefail.
  glibc="$(readelf -V "$f" 2>/dev/null | { grep -oE 'GLIBC_[0-9]+(\.[0-9]+)+' || true; } | sed 's/GLIBC_//' | sort -V | tail -1)"
  [ -z "$glibc" ] || version_le "$glibc" "$LINUX_GLIBC_MAX" ||
    fail "$f: needs GLIBC_$glibc, above the $LINUX_GLIBC_MAX ceiling"

  while read -r rp; do
    case "$rp" in
      '$ORIGIN'*) ;;
      *) fail "$f: RUNPATH/RPATH '$rp' is not \$ORIGIN-relative" ;;
    esac
  done < <(readelf -d "$f" | sed -nE 's/.*\((RUNPATH|RPATH)\).*\[(.*)\]/\2/p' | tr ':' '\n')

  while read -r need; do
    case "$need" in
      libc.so.6 | libm.so.6 | libdl.so.2 | libpthread.so.0 | librt.so.1 | \
        ld-linux-x86-64.so.2 | libz.so.1 | libstdc++.so.6 | libgcc_s.so.1) ;;
      *) printf '%s\n' "$own_libs" | grep -qxF "$need" ||
        fail "$f: needs $need, which neither the OS baseline nor the tree provides" ;;
    esac
  done < <(readelf -d "$f" | sed -nE 's/.*\(NEEDED\).*\[(.*)\]/\1/p')
}

# Windows: delegate to pe.mjs. The win32-arm64 runtime ships the x64 Postgres
# tree (PG 18 cannot be built with MSVC for ARM64), run under the OS's x64
# emulation, so a Postgres tree is x64 on both Windows targets.
case "$target" in
  win32-*)
    machine=x64
    [ "$target" = win32-arm64 ] && [ ! -f "$tree/bin/postgres.exe" ] && machine=arm64
    exec node "$NR_ROOT/lib/pe.mjs" verify "$tree" "$machine"
    ;;
esac

checked=0
case "$target" in
  darwin-*)
    want_arch=arm64
    [ "$target" = darwin-x64 ] && want_arch=x86_64
    while IFS= read -r -d '' f; do
      if file -b "$f" | grep -q '^Mach-O'; then
        verify_macho "$f" "$want_arch"
        checked=$((checked + 1))
      fi
    done < <(find "$tree" -type f -print0)
    ;;
  linux-*)
    while IFS= read -r -d '' f; do
      if [ "$(head -c 4 "$f" | od -An -tx1 | tr -d ' ')" = 7f454c46 ]; then
        verify_elf "$f"
        checked=$((checked + 1))
      fi
    done < <(find "$tree" -type f -print0)
    ;;
esac

[ "$checked" -gt 0 ] || nr_die "no binaries found under $tree"
[ "$failures" -eq 0 ] || nr_die "$failures problem(s) in $tree ($checked binaries checked)"
nr_log "verified $checked binaries in $tree for $target"
