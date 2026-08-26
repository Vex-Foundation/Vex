#!/usr/bin/env node
/**
 * Generator for `descriptors.ts` (a generated artifact - do not hand-edit its
 * output).
 *
 * Generator: this file.
 * Input:     `src/tools/dexscreener/codec/dexscreener-descriptors.pb`
 *            (a serialized `google.protobuf.FileDescriptorSet` extracted from
 *            the live dexscreener.com JS bundle by
 *            `src/vex-agent/tools/tool-surface-spec/dexscreener-site/evidence/
 *             extract-descriptors-from-bundle.py`).
 * Output:    `src/tools/dexscreener/codec/descriptors.ts`
 * Regenerate: `node src/tools/dexscreener/codec/generate-descriptors.mjs`
 * Validation gate: `src/__tests__/dexscreener-site/protobuf-decode.test.ts`
 *            (registry builds, allowlisted messages resolve, the captured
 *            search response decodes to its recorded JSON) and the env-gated
 *            drift test `descriptor-drift.gated.test.ts`.
 *
 * Why this step exists at all instead of embedding the raw .pb:
 *
 *  1. The TypeScript build has no asset pipeline, so the bytes must reach the
 *     runtime as a module. Base64 in a .ts file is the only form that survives
 *     `tsc` + `tsc-alias` unchanged.
 *  2. The descriptors are lifted out of a minified bundle where protobuf-es
 *     inlines each file individually: every `FileDescriptorProto.dependency`
 *     list is EMPTY (measured: zero `google/*` entries across all 25 files).
 *     `createFileRegistry(set)` adds files in array order and resolves type
 *     references against what is already added, so an unordered set throws
 *     `type_name .google.protobuf.Timestamp not found`. This generator
 *     therefore topologically orders the files by the type references they
 *     actually make, and the emitted set is already in a loadable order. The
 *     ordering decision lives here, once, rather than in the runtime.
 *  3. The same descriptors omit `json_name` on every field, which protobuf-es
 *     reads verbatim; without it every JSON key renders as an empty string.
 *     This generator fills it with protoc's own `ToJsonName` rule.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

const here = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.join(here, "dexscreener-descriptors.pb");
const OUTPUT = path.join(here, "descriptors.ts");

/**
 * protoc's `ToJsonName`: lowerCamelCase of the proto field name.
 *
 * The bundle's descriptors omit `json_name` (protoc always populates it, the
 * site's inline writer does not), and protobuf-es reads that field verbatim -
 * an absent one leaves every JSON key an empty string. Reconstructing it with
 * protoc's own rule is what makes `toJson` produce the field names the site's
 * own clients see.
 */
function toJsonName(name) {
  let out = "";
  let capitalizeNext = false;
  for (const char of name) {
    if (char === "_") {
      capitalizeNext = true;
      continue;
    }
    out += capitalizeNext ? char.toUpperCase() : char;
    capitalizeNext = false;
  }
  return out;
}

/** Populate `json_name` on every field of a file, in place. */
function fillJsonNames(file) {
  const walkMessage = (message) => {
    for (const field of message.field) {
      if (!field.jsonName) field.jsonName = toJsonName(field.name);
    }
    for (const extension of message.extension) {
      if (!extension.jsonName) extension.jsonName = toJsonName(extension.name);
    }
    for (const nested of message.nestedType) walkMessage(nested);
  };
  for (const message of file.messageType) walkMessage(message);
  for (const extension of file.extension) {
    if (!extension.jsonName) extension.jsonName = toJsonName(extension.name);
  }
}

/** Every fully qualified type name a file declares (messages, nested, enums). */
function definedTypes(file) {
  const out = new Set();
  const prefix = file.package ? `.${file.package}` : "";
  const walkMessage = (message, scope) => {
    const name = `${scope}.${message.name}`;
    out.add(name);
    for (const nested of message.nestedType) walkMessage(nested, name);
    for (const nestedEnum of message.enumType) out.add(`${name}.${nestedEnum.name}`);
  };
  for (const message of file.messageType) walkMessage(message, prefix);
  for (const enumType of file.enumType) out.add(`${prefix}.${enumType.name}`);
  return out;
}

/** Every fully qualified type name a file references. */
function referencedTypes(file) {
  const out = new Set();
  const addField = (field) => {
    if (field.typeName) out.add(field.typeName);
    if (field.extendee) out.add(field.extendee);
  };
  const walkMessage = (message) => {
    for (const field of message.field) addField(field);
    for (const extension of message.extension) addField(extension);
    for (const nested of message.nestedType) walkMessage(nested);
  };
  for (const message of file.messageType) walkMessage(message);
  for (const extension of file.extension) addField(extension);
  for (const service of file.service) {
    for (const method of service.method) {
      if (method.inputType) out.add(method.inputType);
      if (method.outputType) out.add(method.outputType);
    }
  }
  return out;
}

/**
 * Order files so that every file comes after the files declaring the types it
 * references. Self-references are ignored. Deterministic: among the files that
 * are ready at each step the original input order wins, so regenerating from
 * the same input always produces the same bytes.
 *
 * A reference to a type no file in the set declares is a hard failure: it means
 * the extraction is incomplete and the registry would throw at load time.
 */
function orderFiles(files) {
  const owner = new Map();
  for (const file of files) {
    for (const type of definedTypes(file)) owner.set(type, file.name);
  }
  const needs = new Map();
  const missing = [];
  for (const file of files) {
    const deps = new Set();
    for (const type of referencedTypes(file)) {
      const from = owner.get(type);
      if (from === undefined) {
        missing.push(`${file.name} references unknown type ${type}`);
        continue;
      }
      if (from !== file.name) deps.add(from);
    }
    needs.set(file.name, deps);
  }
  if (missing.length > 0) {
    throw new Error(
      `descriptor set is not self-contained:\n  ${missing.join("\n  ")}`
    );
  }

  const ordered = [];
  const placed = new Set();
  let remaining = files.slice();
  while (remaining.length > 0) {
    const ready = remaining.filter((file) =>
      [...needs.get(file.name)].every((dep) => placed.has(dep))
    );
    if (ready.length === 0) {
      throw new Error(
        `cyclic file dependency among: ${remaining.map((f) => f.name).join(", ")}`
      );
    }
    for (const file of ready) {
      ordered.push(file);
      placed.add(file.name);
    }
    remaining = remaining.filter((file) => !placed.has(file.name));
  }
  return ordered;
}

const inputBytes = readFileSync(INPUT);
const inputSha = createHash("sha256").update(inputBytes).digest("hex");
const set = fromBinary(FileDescriptorSetSchema, inputBytes);
for (const file of set.file) fillJsonNames(file);
set.file = orderFiles(set.file);
const orderedBytes = toBinary(FileDescriptorSetSchema, set);
const base64 = Buffer.from(orderedBytes).toString("base64");

const CHUNK = 96;
const lines = [];
for (let i = 0; i < base64.length; i += CHUNK) {
  lines.push(`  "${base64.slice(i, i + CHUNK)}"`);
}

const source = `/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Generator:  src/tools/dexscreener/codec/generate-descriptors.mjs
 * Input:      src/tools/dexscreener/codec/dexscreener-descriptors.pb
 *             sha256 ${inputSha}
 * Regenerate: node src/tools/dexscreener/codec/generate-descriptors.mjs
 *
 * The bytes are a \`google.protobuf.FileDescriptorSet\` lifted from the
 * dexscreener.com JS bundle, re-serialized with its files topologically
 * ordered so \`createFileRegistry\` can resolve every type reference (the
 * bundle's descriptors carry no \`dependency\` lists). ${set.file.length} files.
 */

/** Base64 of the ordered \`FileDescriptorSet\`. */
export const DEXSCREENER_DESCRIPTOR_SET_BASE64: string = [
${lines.join(" +\n")}
].join("");

/** sha256 of the .pb input this module was generated from. */
export const DEXSCREENER_DESCRIPTOR_SET_INPUT_SHA256 =
  "${inputSha}";

/** Proto file names in the emitted (load) order. */
export const DEXSCREENER_DESCRIPTOR_FILE_NAMES: readonly string[] = [
${set.file.map((f) => `  ${JSON.stringify(f.name)},`).join("\n")}
];
`;

writeFileSync(OUTPUT, source);
console.log(
  `wrote ${path.relative(process.cwd(), OUTPUT)} (${set.file.length} files, ${base64.length} base64 chars)`
);
