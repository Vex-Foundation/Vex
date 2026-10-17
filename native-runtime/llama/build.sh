#!/usr/bin/env bash
# build.sh <target>
#
# Builds llama-server from the pinned llama.cpp tag (sources.env) CPU-only and
# assembles the shipped tree at out/<target>/llama/:
#
#   llama-server                 the executable
#   lib*.dylib | lib*.so.0       every shared library it links, under the
#                                install name / SONAME it is linked against
#   libggml-cpu*.so              the CPU backend(s) ggml dlopens at runtime
#   LICENSE, licenses/           llama.cpp (MIT) and the vendored code it embeds
#
# Everything is flat in one directory: the linked libraries are found through
# an rpath of @loader_path (macOS) / $ORIGIN (Linux), and ggml's backend loader
# (ggml/src/ggml-backend-reg.cpp, ggml_backend_load_best) scans the directory
# of the running executable (_NSGetExecutablePath / /proc/self/exe) for
# libggml-cpu-*.so, then the current directory. GGML_BACKEND_DIR is left unset
# so no build-machine path is compiled in.
#
# linux-x64 is built by linux/build-in-container.sh llama, never directly on a
# Mac. win32-x64 and win32-arm64 are built under Git Bash in an MSVC developer
# environment with clang (MSVC ABI), as upstream's release workflow does:
# ggml-cpu refuses MSVC for ARM, and arm64 is cross-built from x64 with the
# target triple arm64-pc-windows-msvc. The Windows tree is the same flat
# layout: llama-server.exe, the DLLs it links, ggml-cpu*.dll, and the app-local
# MSVC runtime (msvcp140/vcruntime140*), since a clean Windows has none.
# Re-running is safe: the checkout is reset and the build and output
# directories are recreated.

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

target="${1:-}"
nr_require_target "$target"

work="$NR_ROOT/.work/$target"
src="$work/llama.cpp"
build="$work/llama-build"
out="$NR_ROOT/out/$target/llama"

started=$SECONDS
nr_tools
command -v cmake >/dev/null && command -v ninja >/dev/null || nr_die "pinned cmake/ninja not on PATH"
nr_git_checkout "$LLAMA_REPO" "$LLAMA_COMMIT" "$LLAMA_TAG" "$src"

# Every option below exists at the pinned commit (CMakeLists.txt,
# ggml/CMakeLists.txt, vendor/cpp-httplib/CMakeLists.txt). LLAMA_CURL is only
# a deprecation stub at this tag; HTTPS (model download) would come from
# LLAMA_OPENSSL, which is off: Vex hands the server a local file. No BLAS or
# Accelerate, so every platform runs the same ggml CPU kernels; no OpenMP, so
# ggml uses its own threadpool and there is no libgomp/libomp to ship.
cmake_args=(
  -G Ninja
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=ON
  -DLLAMA_BUILD_NUMBER="${LLAMA_TAG#b}"
  -DLLAMA_BUILD_SERVER=ON
  -DLLAMA_BUILD_WEBUI=OFF
  -DLLAMA_BUILD_TESTS=OFF
  -DLLAMA_BUILD_EXAMPLES=OFF
  -DLLAMA_OPENSSL=OFF
  -DGGML_NATIVE=OFF
  -DGGML_BACKEND_DL=ON
  -DGGML_METAL=OFF
  -DGGML_BLAS=OFF
  -DGGML_ACCELERATE=OFF
  -DGGML_OPENMP=OFF
  -DGGML_CCACHE=OFF
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON
)

case "$target" in
  darwin-*)
    nr_darwin_env "$target"
    cmake_args+=(
      -DCMAKE_OSX_ARCHITECTURES="$NR_DARWIN_ARCH"
      -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET"
      -DCMAKE_INSTALL_RPATH=@loader_path
    )
    ;;
  linux-*)
    cmake_args+=(-DCMAKE_INSTALL_RPATH='$ORIGIN')
    ;;
  win32-*)
    nr_win_env "$target"
    command -v clang >/dev/null || nr_die "clang is not on PATH"
    nr_log "$(clang --version | head -1)"
    cmake_args+=(-DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++)
    ;;
esac
# win32-arm64: a cross build (upstream's cmake/arm64-windows-llvm.cmake,
# without its -march=armv8.7-a -ffp-model=fast flags: every target is built at
# the compiler's arm64 baseline and the default FP model like the other
# platforms, and ggml-cpu alone at GGML_CPU_ARM_ARCH). armv8.2-a+dotprod is
# Cortex-A75/A76 class, the oldest Snapdragon that Windows 11 supports
# (850 / 7c / 8cx); the M1 baseline the macOS build uses adds fp16, i8mm etc.
if [ "$target" = win32-arm64 ]; then
  cmake_args+=(
    -DCMAKE_SYSTEM_NAME=Windows -DCMAKE_SYSTEM_PROCESSOR=arm64
    -DCMAKE_C_COMPILER_TARGET=arm64-pc-windows-msvc -DCMAKE_CXX_COMPILER_TARGET=arm64-pc-windows-msvc
    -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod
  )
fi

# x64: one CPU backend per ISA level, the best one chosen at runtime by its
# ggml_backend_score. arm64: a single backend at the compiler's baseline
# (Apple clang's arm64 default is apple-m1: NEON + DOTPROD + FP16).
case "$target" in
  *-x64) cmake_args+=(-DGGML_CPU_ALL_VARIANTS=ON) ;;
  *-arm64) cmake_args+=(-DGGML_CPU_ALL_VARIANTS=OFF) ;;
esac

# ggml's asserts print __FILE__; without this every shipped binary carries the
# build machine's absolute checkout path. Changes no code, only those strings.
# On Windows the compiler sees the checkout as D:/a/..., not Git Bash's /d/a/...
src_seen="$src"
[[ "$target" == win32-* ]] && src_seen="$(cygpath -m "$src")"
export CFLAGS="${CFLAGS:-} -ffile-prefix-map=$src_seen=llama.cpp"
export CXXFLAGS="${CXXFLAGS:-} -ffile-prefix-map=$src_seen=llama.cpp"

rm -rf "$build"
nr_log "configuring llama.cpp $LLAMA_TAG for $target"
cmake -S "$src" -B "$build" "${cmake_args[@]}" >"$work/llama-configure.log" 2>&1 ||
  { tail -40 "$work/llama-configure.log" >&2; nr_die "cmake configure failed (log: $work/llama-configure.log)"; }

# The ggml target depends on every GGML_BACKEND_DL module, so this builds the
# CPU backend(s) along with the server. Inside Docker Desktop's VM (a few GiB
# shared with other builds) one C++ job per CPU can run out of memory, so cap
# the jobs at one per GiB.
jobs="$(nr_jobs)"
if [ -r /proc/meminfo ]; then
  mem_gib="$(awk '/^MemTotal:/{print int($2 / 1048576)}' /proc/meminfo)"
  if [ "$mem_gib" -ge 1 ] && [ "$mem_gib" -lt "$jobs" ]; then jobs="$mem_gib"; fi
fi
nr_log "building llama-server ($jobs jobs)"
cmake --build "$build" --target llama-server -j "$jobs"

bin="$build/bin"
if [[ "$target" == win32-* ]]; then
  [ -f "$bin/llama-server.exe" ] || nr_die "llama-server.exe was not produced"
  rm -rf "$out"
  mkdir -p "$out"
  cp "$bin/llama-server.exe" "$out/"
  compgen -G "$bin/ggml-cpu*.dll" >/dev/null || nr_die "no CPU backend modules (ggml-cpu*.dll) in $bin"
  cp "$bin"/ggml-cpu*.dll "$out/"
  arch=x64
  [ "$target" = win32-arm64 ] && arch=arm64
  nr_win_closure "$out" "$out" "$bin" "$(nr_win_crt_dir "$arch")"
  cp "$src/LICENSE" "$out/LICENSE"
  mkdir -p "$out/licenses"
  cp "$src/vendor/cpp-httplib/LICENSE" "$out/licenses/cpp-httplib-LICENSE"
  cp "$src/licenses/LICENSE-jsonhpp" "$out/licenses/nlohmann-json-LICENSE"
  nr_win_no_build_paths "$out"
  "$NR_ROOT/lib/verify-tree.sh" "$out" "$target"
  cp "$build/CMakeCache.txt" "$work/llama-CMakeCache.txt"
  rm -rf "$build"
  nr_log "llama $LLAMA_TAG for $target: $(du -sh "$out" | cut -f1) in $out ($((SECONDS - started)) s)"
  ls -l "$out" >&2
  exit 0
fi
[ -x "$bin/llama-server" ] || nr_die "llama-server was not produced"

# Assemble: the executable, the backend modules, then the closure of the
# shared libraries they link (by the name they are linked against), copying
# the real file behind any symlink so the tree has no links in it.
rm -rf "$out"
mkdir -p "$out"
cp "$bin/llama-server" "$out/"
backends=()
while IFS= read -r -d '' f; do backends+=("$f"); done \
  < <(find "$bin" -maxdepth 1 -type f -name 'libggml-cpu*.so' -print0)
[ "${#backends[@]}" -gt 0 ] || nr_die "no CPU backend modules (libggml-cpu*.so) in $bin"
cp "${backends[@]}" "$out/"

linked_names() {
  case "$target" in
    darwin-*) otool -L "$1" | tail -n +2 | awk '{print $1}' | sed -n 's|^@rpath/||p' ;;
    linux-*) readelf -d "$1" | sed -nE 's/.*\(NEEDED\).*\[(.*)\]/\1/p' ;;
  esac
}

changed=1
while [ "$changed" -eq 1 ]; do
  changed=0
  for f in "$out"/*; do
    [ -f "$f" ] || continue
    while read -r name; do
      [ -n "$name" ] && [ ! -e "$out/$name" ] || continue
      if [ -e "$bin/$name" ]; then
        cp -L "$bin/$name" "$out/$name"
        changed=1
      elif [[ "$target" == darwin-* ]]; then
        nr_die "$(basename "$f") links @rpath/$name, which the build did not produce"
      fi
      # Linux: a NEEDED name the build did not produce is a system library;
      # verify-tree.sh decides whether it is an allowed one.
    done < <(linked_names "$f")
  done
done

# Strip, keeping the dynamic symbol tables the loader and dlsym need. On macOS
# any edit invalidates the linker's ad-hoc signature, and arm64 refuses to run
# unsigned code, so re-sign ad hoc (release signing happens at packaging).
for f in "$out"/*; do
  case "$target" in
    darwin-*)
      if [ "$(basename "$f")" = llama-server ]; then strip "$f"; else strip -x "$f"; fi
      codesign --force --sign - "$f" 2>/dev/null
      codesign --verify --strict "$f" || nr_die "$(basename "$f"): signature does not verify after strip"
      ;;
    linux-*)
      if [ "$(basename "$f")" = llama-server ]; then strip "$f"; else strip --strip-unneeded "$f"; fi
      ;;
  esac
done

cp "$src/LICENSE" "$out/LICENSE"
mkdir -p "$out/licenses"
cp "$src/vendor/cpp-httplib/LICENSE" "$out/licenses/cpp-httplib-LICENSE"
cp "$src/licenses/LICENSE-jsonhpp" "$out/licenses/nlohmann-json-LICENSE"

"$NR_ROOT/lib/verify-tree.sh" "$out" "$target"

# The build tree is only needed to produce $out; keep its cache as a record
# of the options the tree was built with.
cp "$build/CMakeCache.txt" "$work/llama-CMakeCache.txt"
rm -rf "$build"
nr_log "llama $LLAMA_TAG for $target: $(du -sh "$out" | cut -f1) in $out ($((SECONDS - started)) s)"
ls -l "$out" >&2
