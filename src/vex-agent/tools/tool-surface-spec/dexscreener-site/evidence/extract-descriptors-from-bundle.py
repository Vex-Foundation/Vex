"""Extract the protobuf schemas the dexscreener.com JS bundle carries inline.

protobuf-es inlines every schema file as `fileDesc("<base64 FileDescriptorProto>")`
(older builds: proto3.makeMessageType). Every base64 literal of 200 characters
or more is tried as a FileDescriptorProto; the ones that parse and carry a file
name are the site's schemas. This is the same rule the drift gate
(`src/__tests__/dexscreener-site/descriptor-drift.gated.test.ts`) applies.

Usage (cwd = repo root, the bundle read as data only):

    python3 -P -E src/vex-agent/tools/tool-surface-spec/dexscreener-site/evidence/extract-descriptors-from-bundle.py \
        <bundle-dir> [<out-dir>]

<bundle-dir> is walked recursively for `.js` files (the 2026-10 site layout is
`assets/entries/*.js` and `assets/chunks/*.js`; the 2026-08 one was `js/` and
`js/chunks/`). Writes, into <out-dir> (default: this script's directory):

  - dexscreener-descriptors.pb      FileDescriptorSet, files sorted by name
  - dexscreener-schemas.proto.txt   the same set, human readable

Copy the .pb to `src/tools/dexscreener/codec/dexscreener-descriptors.pb` and run
`node src/tools/dexscreener/codec/generate-descriptors.mjs`.

EXCLUDED FILES, by name, each for a stated reason. The checked-in set only has
to be a SUBSET of the bundle (the drift gate compares what we decode against
what the site declares), so leaving a file out is safe; it is named here so the
omission is a decision and not an accident:

  - buf/validate/*, cel/expr/*, dex_feed/validation.proto: protovalidate rule
    machinery the site runs CLIENT-SIDE before sending a feed request. It is not
    a wire message, and buf/validate extends google/protobuf/descriptor.proto,
    which the bundle does not ship, so the set would not be self-contained. The
    two rules it carries are recorded in DexScreener.md (chain/AMM id
    `^[A-Za-z0-9-]+$`, pair/token id `^[0-9A-Za-z-_:.$]+$`).
  - dex_users_client/*, dex_web/native_embed.proto: signed-in chart settings
    persistence and the native app's embed bridge (postMessage). Neither is a
    network surface a tool can read.
"""

import base64
import os
import re
import sys

from google.protobuf import descriptor_pb2

EXCLUDED_PREFIXES = (
    "buf/validate/",
    "cel/expr/",
    "dex_feed/validation.proto",
    "dex_users_client/",
    "dex_web/native_embed.proto",
)

LITERAL = re.compile(r'\("([A-Za-z0-9+/=_-]{200,})"')

LABELS = {1: "optional", 2: "required", 3: "repeated"}
SCALARS = {
    1: "double", 2: "float", 3: "int64", 4: "uint64", 5: "int32", 6: "fixed64",
    7: "fixed32", 8: "bool", 9: "string", 12: "bytes", 13: "uint32",
    15: "sfixed32", 16: "sfixed64", 17: "sint32", 18: "sint64",
}


def extract(bundle_dir):
    files = {}
    for root, _dirs, names in os.walk(bundle_dir):
        for name in sorted(names):
            if not name.endswith(".js"):
                continue
            path = os.path.join(root, name)
            with open(path, encoding="utf-8", errors="replace") as handle:
                source = handle.read()
            for match in LITERAL.finditer(source):
                literal = match.group(1)
                try:
                    raw = base64.b64decode(literal + "=" * (-len(literal) % 4))
                    file = descriptor_pb2.FileDescriptorProto()
                    file.ParseFromString(raw)
                except Exception:
                    continue
                if file.name:
                    files[file.name] = (file, os.path.relpath(path, bundle_dir), match.start())
    return files


def render_enum(enum, indent):
    values = " ".join(f"{value.name}={value.number};" for value in enum.value)
    return [f"{indent}enum {enum.name} {{ {values} }}"]


def render_message(message, indent):
    lines = [f"{indent}message {message.name} {{"]
    inner = indent + "  "
    for enum in message.enum_type:
        lines += render_enum(enum, inner)
    for nested in message.nested_type:
        lines += render_message(nested, inner)
    for field in message.field:
        kind = field.type_name.lstrip(".") if field.type_name else SCALARS.get(field.type, f"type{field.type}")
        oneof = ""
        if field.HasField("oneof_index"):
            oneof = f" [oneof {message.oneof_decl[field.oneof_index].name}]"
        lines.append(f"{inner}{LABELS.get(field.label, 'optional')} {kind} {field.name} = {field.number};{oneof}")
    lines.append(f"{indent}}}")
    return lines


def render(files):
    out = []
    for name in sorted(files):
        file = files[name][0]
        if name.startswith("google/protobuf/"):
            continue
        out.append(f"// ===== {name} (package {file.package})")
        for enum in file.enum_type:
            out += render_enum(enum, "")
        for message in file.message_type:
            out += render_message(message, "")
        for service in file.service:
            rpcs = " ".join(
                f"rpc {method.name}({method.input_type.lstrip('.')}) returns "
                f"({'stream ' if method.server_streaming else ''}{method.output_type.lstrip('.')});"
                for method in service.method
            )
            out.append(f"service {service.name} {{ {rpcs} }}")
        out.append("")
    return "\n".join(out)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    bundle_dir = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__))
    found = extract(bundle_dir)
    kept = {name: entry for name, entry in found.items() if not name.startswith(EXCLUDED_PREFIXES)}
    print(f"{len(found)} file descriptors found, {len(kept)} kept")
    for name, (file, source, offset) in sorted(found.items()):
        mark = " " if name in kept else "x"
        print(f" {mark} {name:50s} pkg={file.package:22s} msgs={len(file.message_type):3d} <- {source}@{offset}")
    descriptor_set = descriptor_pb2.FileDescriptorSet()
    for name in sorted(kept):
        descriptor_set.file.append(kept[name][0])
    with open(os.path.join(out_dir, "dexscreener-descriptors.pb"), "wb") as handle:
        handle.write(descriptor_set.SerializeToString())
    with open(os.path.join(out_dir, "dexscreener-schemas.proto.txt"), "w", encoding="utf-8") as handle:
        handle.write(render(kept))


if __name__ == "__main__":
    main()
