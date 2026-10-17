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
# inside linux/build-in-container.sh. Every run starts from a clean tree.

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

# set -e alone exits silently; name the command that failed.
set -E
trap 'nr_log "ERROR: build.sh failed at line $LINENO: $BASH_COMMAND"' ERR

target="${1:-}"
nr_require_target "$target"
build_started=$SECONDS

work="$NR_ROOT/.work/$target/postgres"
out="$NR_ROOT/out/$target/postgres"
tarball="$NR_ROOT/.work/downloads/postgresql-$PG_VERSION.tar.bz2"
prefix=/vex-unrelocated
stage="$work/stage"
root="$stage$prefix"
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
esac

ninja -C "$work/build"
meson install -C "$work/build" --destdir "$stage" --quiet

# pgvector against the staged server. OPTFLAGS="" is mandatory: the default
# is -march=native, which would tie the module to the build machine's CPU.
pg_config="$root/bin/pg_config"
[ "$("$pg_config" --pkglibdir)" = "$root/lib/postgresql" ] ||
  nr_die "staged pg_config does not relocate: $("$pg_config" --pkglibdir)"
make -C "$work/pgvector" -j"$(nr_jobs)" OPTFLAGS="" PG_CONFIG="$pg_config"
make -C "$work/pgvector" install OPTFLAGS="" PG_CONFIG="$pg_config"

# ---- Assemble the shipped tree ---------------------------------------------

mkdir -p "$out/bin" "$out/lib/postgresql" "$out/share/licenses/postgresql" "$out/share/licenses/pgvector"

for b in postgres initdb pg_ctl pg_controldata pg_dump pg_restore; do
  cp "$root/bin/$b" "$out/bin/$b"
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
esac
[ -n "$libpq_name" ] || nr_die "could not read libpq's install name / SONAME"
cp -L "$root/lib/$libpq_name" "$out/lib/$libpq_name"

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
esac

# No build-machine path may ship, except inside the recorded compiler flags
# (the pg_config view), which carry the -ffile-prefix-map argument itself.
leaks="$(find "$out" -type f -exec strings -a {} + | grep -F "$NR_ROOT" | grep -vF -- "$prefix_map" || true)"
[ -z "$leaks" ] || nr_die "build paths leaked into the tree:"$'\n'"$leaks"

"$NR_ROOT/lib/verify-tree.sh" "$out" "$target"

# Verified: drop the build trees (hundreds of MB); keep the pinned download.
rm -rf "$work/src" "$work/build" "$work/build-zic" "$stage"

nr_log "postgres $PG_VERSION + pgvector $PGVECTOR_TAG for $target: $(du -sh "$out" | cut -f1) in $((SECONDS - build_started))s -> $out"
