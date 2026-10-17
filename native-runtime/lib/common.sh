# Shared helpers for the native-runtime build scripts. Sourced, never executed.
#
# Layout (all under native-runtime/, both gitignored):
#   .work/<target>/   source checkouts and build trees for one target
#   .work/tools/<host>/  private venv with the pinned meson/ninja/cmake
#   out/<target>/     the finished, relocatable runtime trees
#
# Targets use Node's platform-arch vocabulary so the packaging scripts can map
# them one-to-one onto electron-builder's ${os}/${arch}.

set -euo pipefail

NR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NR_TARGETS="darwin-arm64 darwin-x64 linux-x64 win32-x64 win32-arm64"

# shellcheck source=../sources.env
source "$NR_ROOT/sources.env"

nr_log() { printf '[native-runtime] %s\n' "$*" >&2; }
nr_die() { printf '[native-runtime] ERROR: %s\n' "$*" >&2; exit 1; }

# The target this machine builds without a container or cross toolchain.
nr_host_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS*) os=win32 ;; # Git Bash on Windows
    *) nr_die "unsupported build host $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) nr_die "unsupported build host arch $(uname -m)" ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

nr_require_target() {
  local target="${1:-}"
  case " $NR_TARGETS " in
    *" $target "*) ;;
    *) nr_die "unknown target '${target}'; expected one of: $NR_TARGETS" ;;
  esac
  # macOS cross-builds x64 on arm64 (clang -arch); Linux builds only natively,
  # which on a Mac means inside linux/build-in-container.sh.
  case "$target" in
    darwin-*) [ "$(uname -s)" = Darwin ] || nr_die "$target must be built on macOS" ;;
    linux-*) [ "$(nr_host_target)" = "$target" ] ||
      nr_die "$target must be built on $target (use linux/build-in-container.sh)" ;;
    # Windows builds run under Git Bash inside an MSVC developer environment
    # (nr_win_env); arm64 is cross-built from x64 like upstream llama.cpp.
    win32-*) [[ "$(nr_host_target)" == win32-* ]] || nr_die "$target must be built on Windows (Git Bash)" ;;
  esac
}

nr_jobs() {
  if command -v nproc >/dev/null 2>&1; then nproc; else sysctl -n hw.ncpu; fi
}

nr_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Download $1 to $3 unless it is already there, and refuse it unless its
# sha256 is exactly $2. A mismatching cached file is deleted, never trusted.
nr_fetch_verified() {
  local url="$1" want="$2" dest="$3" got
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ] && [ "$(nr_sha256 "$dest")" != "$want" ]; then
    nr_log "cached $(basename "$dest") does not match its pin; re-downloading"
    rm -f "$dest"
  fi
  if [ ! -f "$dest" ]; then
    nr_log "downloading $url"
    curl -fL --retry 3 --proto '=https' --tlsv1.2 -o "$dest.part" "$url"
    mv "$dest.part" "$dest"
  fi
  got="$(nr_sha256 "$dest")"
  [ "$got" = "$want" ] || { rm -f "$dest"; nr_die "sha256 mismatch for $url: got $got, pinned $want"; }
}

# Check out tag $3 of $1 into $4 and refuse it unless HEAD is exactly commit $2.
nr_git_checkout() {
  local repo="$1" commit="$2" tag="$3" dest="$4" head
  if [ ! -d "$dest/.git" ]; then
    rm -rf "$dest"
    git clone --quiet --depth 1 --branch "$tag" "$repo" "$dest"
  fi
  head="$(git -C "$dest" rev-parse HEAD)"
  [ "$head" = "$commit" ] || nr_die "$repo tag $tag is at $head, pinned $commit"
  # A previous build may have left generated files; the tree must be pristine.
  git -C "$dest" clean -fdxq
  git -C "$dest" checkout --quiet -- .
}

# Put the pinned meson/ninja/cmake first on PATH.
nr_tools() {
  local venv="$NR_ROOT/.work/tools/$(nr_host_target)"
  local stamp="$venv/.pins-$MESON_VERSION-$NINJA_VERSION-$CMAKE_VERSION"
  # A Windows venv keeps its executables in Scripts/, and the interpreter is
  # python.exe (python3 may be the Microsoft Store stub).
  local py="${NR_PYTHON:-python3}" vbin=bin
  if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* ]]; then py="${NR_PYTHON:-python}"; vbin=Scripts; fi
  if [ ! -f "$stamp" ]; then
    rm -rf "$venv"
    "$py" -m venv "$venv"
    "$venv/$vbin/pip" install --quiet --disable-pip-version-check \
      "meson==$MESON_VERSION" "ninja==$NINJA_VERSION" "cmake==$CMAKE_VERSION"
    touch "$stamp"
  fi
  export PATH="$venv/$vbin:$PATH"
  NR_VENV_PYTHON="$venv/$vbin/python"
}

# Compiler environment for a macOS target: the arch and the deployment floor
# go into every compile and link, including the ones meson/cmake run for
# feature checks.
nr_darwin_env() {
  local target="$1" arch
  case "$target" in
    darwin-arm64) arch=arm64 ;;
    darwin-x64) arch=x86_64 ;;
    *) nr_die "nr_darwin_env: not a darwin target: $target" ;;
  esac
  export MACOSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET"
  export NR_DARWIN_ARCH="$arch"
  export CFLAGS="-arch $arch -mmacosx-version-min=$MACOS_DEPLOYMENT_TARGET ${CFLAGS:-}"
  export CXXFLAGS="-arch $arch -mmacosx-version-min=$MACOS_DEPLOYMENT_TARGET ${CXXFLAGS:-}"
  export LDFLAGS="-arch $arch -mmacosx-version-min=$MACOS_DEPLOYMENT_TARGET ${LDFLAGS:-}"
}

# ---- Windows ---------------------------------------------------------------

# Check and order the MSVC developer environment for a win32 target. The
# environment itself (vcvarsall: cl, link, rc, INCLUDE, LIB, VCToolsRedistDir)
# comes from the caller, in CI ilammy/msvc-dev-cmd; this only refuses the
# wrong one and puts MSVC's tools ahead of Git Bash's (whose /usr/bin/link.exe
# is coreutils link, not the linker).
nr_win_env() {
  local target="$1" want cl_dir
  case "$target" in
    win32-x64) want=x64 ;;
    win32-arm64) want=arm64 ;;
    *) nr_die "nr_win_env: not a win32 target: $target" ;;
  esac
  command -v cl >/dev/null || nr_die "no MSVC environment (cl not on PATH): run inside vcvarsall / msvc-dev-cmd"
  [ "${VSCMD_ARG_TGT_ARCH:-}" = "$want" ] ||
    nr_die "MSVC environment targets '${VSCMD_ARG_TGT_ARCH:-?}', $target needs '$want'"
  [ -n "${VCToolsRedistDir:-}" ] || nr_die "VCToolsRedistDir is not set by the MSVC environment"
  cl_dir="$(dirname "$(command -v cl)")"
  export PATH="$cl_dir:$PATH"
  nr_log "MSVC: VS ${VisualStudioVersion:-?}, tools ${VCToolsVersion:-?}, SDK ${WindowsSDKVersion:-?}, host ${VSCMD_ARG_HOST_ARCH:-?} -> $want"
}

# The app-local MSVC runtime for a Windows arch (x64 | arm64): the
# Microsoft.VC14x.CRT folder of the redistributable that ships with the build
# tools, which Microsoft supports copying next to the executables ("local
# deployment"). Prints the folder as a Git Bash path.
nr_win_crt_dir() {
  local arch="$1" redist d
  redist="$(cygpath -u "$VCToolsRedistDir")"
  for d in "$redist/$arch"/Microsoft.VC14*.CRT; do
    [ -f "$d/vcruntime140.dll" ] && { printf '%s\n' "$d"; return; }
  done
  nr_die "no Microsoft.VC14*.CRT with vcruntime140.dll under $redist/$arch"
}

# Copy into $1 every DLL the PEs of tree $2 import that neither Windows nor
# the tree provides (lib/pe.mjs needs), taken from the first of the source
# directories $3... that has it, until nothing is missing.
nr_win_closure() {
  local dest="$1" tree="$2" name src found missing
  shift 2
  for _ in 1 2 3 4 5 6 7 8; do
    missing="$(node "$NR_ROOT/lib/pe.mjs" needs "$tree")"
    [ -n "$missing" ] || return 0
    while read -r name; do
      found=
      for src in "$@"; do
        if [ -f "$src/$name" ]; then cp "$src/$name" "$dest/$name"; found=1; break; fi
      done
      [ -n "$found" ] || nr_die "$name is imported by the tree but is in none of: $*"
    done <<<"$missing"
  done
  nr_die "import closure of $tree did not converge"
}

# Fail if any file under $1 contains a path of this checkout, in any of the
# three spellings a Windows build can bake in (/d/a/..., D:\a\..., D:/a/...).
nr_win_no_build_paths() {
  local leaks
  leaks="$(grep -rlaiF -e "$NR_ROOT" -e "$(cygpath -w "$NR_ROOT")" -e "$(cygpath -m "$NR_ROOT")" "$1" || true)"
  [ -z "$leaks" ] || nr_die "build paths leaked into:"$'\n'"$leaks"
}
