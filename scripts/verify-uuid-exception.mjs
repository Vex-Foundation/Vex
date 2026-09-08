import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// GHSA-w5hq-g745-h8pq is a weak-randomness defect in uuid's v3, v5 and v6
// generators when the CALLER supplies an output buffer. Jayson's exception
// rests on two claims, and this verifier refuses to take either on trust:
//
//   1. the installed Jayson binds `require('uuid').v4` only, never v3, v5 or
//      v6, and never the module namespace it could reach them through;
//   2. every call site invokes that binding with NO arguments, so no caller
//      -provided buffer or offset ever reaches the generator.
//
// Both are read from the INSTALLED sources, then the reachable entry point is
// exercised for real, so a Jayson or Solana bump that changes the import graph
// turns the gate red instead of silently widening the exception.
export async function verifyUuidException(projectRoot) {
  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  const solanaRequire = createRequire(projectRequire.resolve("@solana/web3.js"));
  const jaysonEntry = solanaRequire.resolve("jayson");
  const jaysonRequire = createRequire(jaysonEntry);
  const libraryRoot = path.join(path.dirname(jaysonEntry), "lib");

  // The ONLY accepted binding form. Anything else (a namespace import, a
  // destructured v3/v5/v6, a dynamic property read) is unreviewed.
  const ACCEPTED_BINDING = /require\(\s*["']uuid["']\s*\)\s*\.\s*v4\b/;
  const ANY_UUID_REQUIRE = /require\(\s*["']uuid["']\s*\)[^\n]*/g;
  const bindings = new Map();
  let bindingSites = 0;

  function inspect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        inspect(file);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(ANY_UUID_REQUIRE)) {
        assert(ACCEPTED_BINDING.test(match[0]),
          `Unreviewed uuid import in ${file}: ${match[0].trim()}`);
        bindingSites += 1;
      }
      const binding = /const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']uuid["']\s*\)\s*\.\s*v4\s*;/.exec(source);
      if (binding !== null) bindings.set(file, binding[1]);
    }
  }
  inspect(libraryRoot);

  assert(bindingSites > 0, "The installed Jayson no longer imports uuid; remove the exception");
  assert.equal(bindings.size, bindingSites,
    "A uuid import in the installed Jayson is not a plain `const x = require('uuid').v4;` binding");

  // Every invocation of that binding must be argument-free. `name(` followed by
  // anything other than `)` is a caller-provided options/buffer/offset call,
  // which is precisely the shape the advisory covers.
  for (const [file, name] of bindings) {
    const source = readFileSync(file, "utf8");
    const calls = [...source.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*\\(([^)]*)\\)`, "g"))];
    assert(calls.length > 0, `The uuid binding in ${file} is imported but never called; reassess the exception`);
    for (const call of calls) {
      assert.equal(call[1].trim(), "",
        `Jayson passes arguments to uuid in ${file}: ${call[0].trim()}; the advisory's buffer path is reachable`);
    }
  }

  // The reachable entry point, exercised for real: Jayson generates request ids
  // through Utils.generateId, which is the v4 call above.
  const utils = jaysonRequire("./lib/utils");
  const id = utils.generateId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    `Jayson's reachable uuid entry point did not produce a v4 identifier: ${String(id)}`);
  assert.notEqual(utils.generateId(), id, "Jayson's uuid entry point returned a constant identifier");

  const loaded = Object.keys(jaysonRequire.cache).filter((file) => file.includes(`${path.sep}uuid${path.sep}`));
  assert(loaded.length > 0, "The installed uuid graph was not exercised");
}
