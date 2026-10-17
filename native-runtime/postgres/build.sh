#!/usr/bin/env bash
# postgres/build.sh <target>
#
# Builds PostgreSQL and pgvector from the pins in sources.env and assembles the
# relocatable tree Vex ships at out/<target>/postgres/:
#
#   bin/                 postgres initdb pg_ctl pg_controldata pg_dump pg_restore
#   lib/                 libpq (under its install name / SONAME, no symlinks)
#   lib/postgresql/      plpgsql dict_snowball vector + the encoding conversions
#   share/postgresql/    postgres.bki, the initdb SQL and samples, timezone/,
#                        timezonesets/, tsearch_data/, extension/{plpgsql,vector}*
#   share/licenses/      PostgreSQL COPYRIGHT and pgvector LICENSE
#
# Postgres finds pkglibdir and sharedir relative to its own executable
# (src/port/path.c make_relative_path): it strips the compiled-in bindir's
# tail ("bin") from the executable's directory and appends the compiled-in
# "lib/postgresql" or "share/postgresql". So the layout above must be kept and
# binaries must stay in a directory named bin/. The compiled-in prefix is a
# path that never exists, so a broken layout fails loudly instead of quietly
# reading some other install.
#
# darwin-arm64 builds natively; darwin-x64 is a meson cross build from Apple
# Silicon (clang -arch x86_64, x64 binaries run under Rosetta); linux-x64 runs
# inside linux/build-in-container.sh. win32-x64 builds under Git Bash in an
# MSVC x64 developer environment (cl, /MD) with a static zlib from the pin;
# the layout is the same (bin/*.exe with libpq.dll and the app-local MSVC
# runtime, lib/postgresql/*.dll, share/postgresql), and Postgres on Windows
# resolves lib/postgresql and share/postgresql from its executable the same
# way. win32-arm64 has no Postgres build of its own: PG 18 cannot be built
# with MSVC for ARM64 (upstream support is PG 19), so that runtime ships this
# x64 tree under the OS's x64 emulation. Every run starts from a clean tree.

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

# set -e alone exits silently; name the command that failed.
set -E
trap 'nr_log "ERROR: build.sh failed at line $LINENO: $BASH_COMMAND"' ERR

target="${1:-}"
nr_require_target "$target"
[ "$target" = win32-arm64 ] &&
  nr_die "win32-arm64 ships the win32-x64 Postgres tree (PG 18 has no MSVC ARM64 build); build win32-x64"
build_started=$SECONDS

work="$NR_ROOT/.work/$target/postgres"
out="$NR_ROOT/out/$target/postgres"
tarball="$NR_ROOT/.work/downloads/postgresql-$PG_VERSION.tar.bz2"
prefix=/vex-unrelocated
stage="$work/stage"
root="$stage$prefix"
exe=
if [ "$target" = win32-x64 ]; then
  # An absolute prefix with a drive, so it does not depend on the Python
  # version's idea of a rooted path; meson's --destdir drops the drive.
  prefix=C:/vex-unrelocated
  root="$stage/vex-unrelocated"
  exe=.exe
fi
src="$work/src/postgresql-$PG_VERSION"

nr_fetch_verified "$PG_URL" "$PG_SHA256" "$tarball"
rm -rf "$work/src" "$work/build" "$work/build-zic" "$stage" "$out"
mkdir -p "$work/src"
tar -xjf "$tarball" -C "$work/src"
[ -f "$src/meson.build" ] || nr_die "unexpected tarball layout: no $src/meson.build"
nr_git_checkout "$PGVECTOR_REPO" "$PGVECTOR_COMMIT" "$PGVECTOR_TAG" "$work/pgvector"
nr_tools

# Plan 6.1 flags, except lz4 (no column compression in any migration, so it
# would be an unused bundled library). -Drpath=false: relative rpaths are set
# below instead of meson's absolute ones.
pg_opts=(
  --buildtype=release -Dauto_features=disabled
  -Dssl=none -Dicu=disabled -Dreadline=disabled -Dnls=disabled -Dllvm=disabled
  -Dplperl=disabled -Dplpython=disabled -Dpltcl=disabled -Dlibxml=disabled
  -Dlibxslt=disabled -Dgssapi=disabled -Dldap=disabled -Duuid=none
  -Dlibcurl=disabled -Dliburing=disabled -Dzlib=enabled -Dlz4=disabled
  -Ddocs=disabled -Dtap_tests=disabled
  -Drpath=false --prefix="$prefix" --libdir=lib
)
# --libdir=lib: meson defaults to lib64 on RHEL-family hosts (manylinux), and
# the shipped layout is the same lib/ on every target.
# flex #line directives and header Asserts bake absolute source paths into
# __FILE__; map the work dir away so no build-machine path ships.
prefix_map="-ffile-prefix-map=$work/="

case "$target" in
  darwin-arm64)
    nr_darwin_env "$target"
    export CFLAGS="$CFLAGS $prefix_map"
    export LDFLAGS="$LDFLAGS -Wl,-headerpad_max_install_names"
    meson setup "$work/build" "$src" "${pg_opts[@]}"
    ;;
  darwin-x64)
    # A real cross build, so meson's host_cpu is x86_64 and Postgres picks the
    # x86 CRC32C/popcount paths. Cross builds need a zic that runs on the
    # build machine (src/timezone/meson.build), so build one natively first.
    export MACOSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET"
    unset CFLAGS CXXFLAGS LDFLAGS
    meson setup "$work/build-zic" "$src" "${pg_opts[@]}"
    ninja -C "$work/build-zic" src/timezone/zic
    cat >"$work/cross-x86_64.ini" <<EOF
[binaries]
c = 'clang'
ar = 'ar'
strip = 'strip'

[built-in options]
c_args = ['-arch', 'x86_64', '-mmacosx-version-min=$MACOS_DEPLOYMENT_TARGET', '$prefix_map']
c_link_args = ['-arch', 'x86_64', '-mmacosx-version-min=$MACOS_DEPLOYMENT_TARGET', '-Wl,-headerpad_max_install_names']

[properties]
needs_exe_wrapper = false

[host_machine]
system = 'darwin'
subsystem = 'macos'
kernel = 'xnu'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
EOF
    meson setup "$work/build" "$src" "${pg_opts[@]}" \
      --cross-file "$work/cross-x86_64.ini" -DZIC="$work/build-zic/src/timezone/zic"
    ;;
  linux-x64)
    command -v patchelf >/dev/null || nr_die "patchelf is required for linux-x64"
    export CFLAGS="${CFLAGS:-} $prefix_map"
    meson setup "$work/build" "$src" "${pg_opts[@]}"
    ;;
  win32-x64)
    nr_win_env "$target"
    # cl spells __FILE__ (elog/ereport record it) as an absolute path, so trim
    # the work dir off it, the MSVC counterpart of -ffile-prefix-map (the
    # option Bazel's MSVC toolchain uses for the same purpose). Passed through
    # cl's CL environment variable, so meson does not record it in pg_config's
    # CFLAGS; dash syntax, so Git Bash does not rewrite it as a path.
    export CL="-d1trimfile:$(cygpath -w "$work")\\"
    # flex/bison from the pinned winflexbison, perl from Strawberry (what
    # upstream's Windows CI uses; Git Bash's msys perl must not be picked).
    wfb="$NR_ROOT/.work/tools/winflexbison-$WINFLEXBISON_VERSION"
    wfb_zip="$NR_ROOT/.work/downloads/win_flex_bison-$WINFLEXBISON_VERSION.zip"
    if [ ! -f "$wfb/win_flex.exe" ]; then
      nr_fetch_verified "$WINFLEXBISON_URL" "$WINFLEXBISON_SHA256" "$wfb_zip"
      rm -rf "$wfb" && mkdir -p "$wfb"
      "$NR_VENV_PYTHON" -I -m zipfile -e "$wfb_zip" "$wfb"
    fi
    perl_exe=/c/Strawberry/perl/bin/perl.exe
    [ -f "$perl_exe" ] || nr_die "Strawberry Perl not found at $perl_exe"
    nr_log "$("$perl_exe" -e 'print "perl $^V"'), $("$wfb/win_flex.exe" --version | head -1), $("$wfb/win_bison.exe" --version | head -1)"

    # zlib: a static zlib.lib (win32/Makefile.msc builds it with /MD, the same
    # CRT as Postgres), found by meson's zlib lookup through INCLUDE/LIB.
    zsrc="$work/src/zlib-$ZLIB_VERSION"
    nr_fetch_verified "$ZLIB_URL" "$ZLIB_SHA256" "$NR_ROOT/.work/downloads/zlib-$ZLIB_VERSION.tar.gz"
    tar -xzf "$NR_ROOT/.work/downloads/zlib-$ZLIB_VERSION.tar.gz" -C "$work/src"
    (cd "$zsrc" && nmake -nologo -f win32/Makefile.msc zlib.lib >"$work/zlib-build.log" 2>&1) ||
      { tail -30 "$work/zlib-build.log" >&2; nr_die "zlib build failed"; }
    mkdir -p "$work/zlib/include" "$work/zlib/lib"
    cp "$zsrc/zlib.h" "$zsrc/zconf.h" "$work/zlib/include/"
    cp "$zsrc/zlib.lib" "$work/zlib/lib/"
    INCLUDE="$(cygpath -w "$work/zlib/include");$INCLUDE"
    LIB="$(cygpath -w "$work/zlib/lib");$LIB"
    CMAKE_PREFIX_PATH="$(cygpath -w "$work/zlib")"
    export INCLUDE LIB CMAKE_PREFIX_PATH
    # The image has MinGW and Strawberry pkg-configs (and zlibs) on PATH; no
    # dependency may come from them.
    export PKG_CONFIG=pkg-config-disabled-for-msvc

    CC=cl meson setup "$work/build" "$src" "${pg_opts[@]}" -Db_vscrt=md \
      -DPERL="$(cygpath -m "$perl_exe")" -DPYTHON="$(cygpath -m "$NR_VENV_PYTHON")" \
      -DFLEX="$(cygpath -m "$wfb/win_flex.exe")" -DBISON="$(cygpath -m "$wfb/win_bison.exe")"
    grep -qE "dependency zlib found: YES $ZLIB_VERSION" "$work/build/meson-logs/meson-log.txt" ||
      nr_die "meson did not pick the pinned zlib $ZLIB_VERSION: $(grep -i 'dependency zlib' "$work/build/meson-logs/meson-log.txt")"
    grep -q '^#define HAVE_LIBZ 1' "$work/build/src/include/pg_config.h" || nr_die "configured without zlib"
    ! grep -qiE 'libz\.(a|dll)|zlib1' "$work/build/build.ninja" || nr_die "build links a zlib other than the pinned static one"
    ;;
esac

ninja -C "$work/build"
meson install -C "$work/build" --destdir "$stage" --quiet

# pgvector against the staged server. OPTFLAGS="" is mandatory: the default
# is -march=native, which would tie the module to the build machine's CPU.
pg_config="$root/bin/pg_config$exe"
if [ "$target" != win32-x64 ]; then
  [ "$("$pg_config" --pkglibdir)" = "$root/lib/postgresql" ] ||
    nr_die "staged pg_config does not relocate: $("$pg_config" --pkglibdir)"
  make -C "$work/pgvector" -j"$(nr_jobs)" OPTFLAGS="" PG_CONFIG="$pg_config"
  make -C "$work/pgvector" install OPTFLAGS="" PG_CONFIG="$pg_config"
else
  # Windows: the same relocation check (pg_config prints C:/... with forward
  # slashes), then pgvector's own Makefile.win. Its include/lib defaults
  # assume the EDB layout, so the meson layout's directories are passed in;
  # OPTFLAGS=-MD links it against the same dynamic CRT as postgres.exe (cl's
  # default is the static one). The files are copied below, no nmake install.
  got="$("$pg_config" --pkglibdir | tr -d '\r')"
  want="$(cygpath -m "$root/lib/postgresql")"
  [ "${got,,}" = "${want,,}" ] || nr_die "staged pg_config does not relocate: $got (expected $want)"
  [ -f "$root/lib/postgres.lib" ] || nr_die "postgres.lib (the import library modules link against) was not installed"
  (cd "$work/pgvector" && nmake -nologo -f Makefile.win all OPTFLAGS=-MD \
    PGROOT="$(cygpath -w "$root")" INCLUDEDIR="$(cygpath -w "$root/include")" \
    INCLUDEDIR_SERVER="$(cygpath -w "$root/include/postgresql/server")" LIBDIR="$(cygpath -w "$root/lib")")
  cp "$work/pgvector/vector.dll" "$root/lib/postgresql/"
  cp "$work/pgvector/vector.control" "$work/pgvector"/sql/vector--*.sql "$root/share/postgresql/extension/"
fi

# ---- Assemble the shipped tree ---------------------------------------------

mkdir -p "$out/bin" "$out/lib/postgresql" "$out/share/licenses/postgresql" "$out/share/licenses/pgvector"

for b in postgres initdb pg_ctl pg_controldata pg_dump pg_restore; do
  cp "$root/bin/$b$exe" "$out/bin/$b$exe"
done

# libpq under the name the binaries load it by, dereferenced: no symlinks in
# the tree, so packaging cannot drop or duplicate them.
case "$target" in
  darwin-*)
    libpq_name="$(basename "$(otool -D "$root/lib/libpq.dylib" | tail -n +2)")"
    dlsuffix=.dylib
    ;;
  linux-*)
    libpq_name="$(readelf -d "$root/lib/libpq.so" | sed -nE 's/.*\(SONAME\).*\[(.*)\]/\1/p')"
    dlsuffix=.so
    ;;
  win32-*)
    # libpq.dll (meson installs DLLs into bin/) and the MSVC runtime go into
    # bin/, beside the executables that load them: the import closure below.
    libpq_name=
    dlsuffix=.dll
    ;;
esac
if [[ "$target" != win32-* ]]; then
  [ -n "$libpq_name" ] || nr_die "could not read libpq's install name / SONAME"
  cp -L "$root/lib/$libpq_name" "$out/lib/$libpq_name"
fi

modules=(plpgsql dict_snowball vector)
for d in "$src"/src/backend/utils/mb/conversion_procs/*/; do
  modules+=("$(basename "$d")")
done
for m in "${modules[@]}"; do
  [ -f "$root/lib/postgresql/$m$dlsuffix" ] || nr_die "module $m$dlsuffix was not built"
  cp "$root/lib/postgresql/$m$dlsuffix" "$out/lib/postgresql/"
done

# share/: everything initdb (initdb.c set_input) and the server read, minus
# the contrib extensions, the psql and libpq-service samples (no psql, no
# service file) and errcodes.txt (a build input for plpgsql and PGXS only).
cp -R "$root/share/postgresql" "$out/share/postgresql"
find "$out/share/postgresql/extension" -type f ! -name 'plpgsql*' ! -name 'vector*' -delete
rm -f "$out/share/postgresql/psqlrc.sample" "$out/share/postgresql/pg_service.conf.sample" \
  "$out/share/postgresql/errcodes.txt"
[ -f "$out/share/postgresql/postgres.bki" ] || nr_die "postgres.bki missing from share/"
[ -f "$out/share/postgresql/extension/vector.control" ] || nr_die "vector.control missing"

cp "$src/COPYRIGHT" "$out/share/licenses/postgresql/COPYRIGHT"
cp "$work/pgvector/LICENSE" "$out/share/licenses/pgvector/LICENSE"

# ---- Relocate and strip ----------------------------------------------------

case "$target" in
  darwin-*)
    install_name_tool -id "@rpath/$libpq_name" "$out/lib/$libpq_name"
    while IFS= read -r -d '' f; do
      file -b "$f" | grep -q '^Mach-O' || continue
      needs_rpath=0
      while read -r dep; do
        case "$dep" in
          "$prefix"/lib/*)
            install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$f"
            needs_rpath=1
            ;;
          @rpath/*) needs_rpath=1 ;;
        esac
      done < <(otool -L "$f" | tail -n +2 | awk '{print $1}')
      if [ "$needs_rpath" = 1 ] && [ "$f" != "$out/lib/$libpq_name" ]; then
        case "$f" in
          "$out"/bin/*) install_name_tool -add_rpath @loader_path/../lib "$f" ;;
          "$out"/lib/postgresql/*) install_name_tool -add_rpath @loader_path/.. "$f" ;;
          *) nr_die "unexpected Mach-O location $f" ;;
        esac
      fi
      strip -x "$f"
      # Editing a Mach-O voids its signature, and arm64 refuses to run an
      # unsigned binary. Ad-hoc sign here; release signing replaces it.
      codesign --force --sign - "$f" 2>/dev/null
    done < <(find "$out" -type f -print0)
    ;;
  linux-*)
    while IFS= read -r -d '' f; do
      [ "$(head -c 4 "$f" | od -An -tx1 | tr -d ' ')" = 7f454c46 ] || continue
      strip --strip-unneeded "$f"
      if readelf -d "$f" | grep -q "(NEEDED).*\[$libpq_name\]"; then
        case "$f" in
          "$out"/bin/*) patchelf --set-rpath '$ORIGIN/../lib' "$f" ;;
          *) nr_die "unexpected libpq consumer $f" ;;
        esac
      fi
    done < <(find "$out" -type f -print0)
    ;;
  win32-*)
    # No rpaths on Windows: every PE here runs in, or is loaded by, a process
    # whose executable is in bin/, and that directory is where DLLs are
    # searched. Nothing to strip: release links carry no debug info.
    nr_win_closure "$out/bin" "$out" "$root/bin" "$(nr_win_crt_dir x64)"
    ls "$out/bin" >&2
    ;;
esac

if [[ "$target" == win32-* ]]; then
  nr_win_no_build_paths "$out"
else
  # No build-machine path may ship, except inside the recorded compiler flags
  # (the pg_config view), which carry the -ffile-prefix-map argument itself.
  leaks="$(find "$out" -type f -exec strings -a {} + | grep -F "$NR_ROOT" | grep -vF -- "$prefix_map" || true)"
  [ -z "$leaks" ] || nr_die "build paths leaked into the tree:"$'\n'"$leaks"
fi

"$NR_ROOT/lib/verify-tree.sh" "$out" "$target"

# Verified: drop the build trees (hundreds of MB); keep the pinned download.
rm -rf "$work/src" "$work/build" "$work/build-zic" "$stage"

nr_log "postgres $PG_VERSION + pgvector $PGVECTOR_TAG for $target: $(du -sh "$out" | cut -f1) in $((SECONDS - build_started))s -> $out"
