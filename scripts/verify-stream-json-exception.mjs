import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";

// GHSA-528h-pc64-c93x explicitly excludes StreamValues. Keep the exception
// conditional on Jayson's installed import graph and its actual parser working.
export async function verifyStreamJsonException(projectRoot) {
  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  const solanaRequire = createRequire(projectRequire.resolve("@solana/web3.js"));
  const jaysonEntry = solanaRequire.resolve("jayson");
  const jaysonRequire = createRequire(jaysonEntry);
  const allowed = new Set(["stream-json/streamers/StreamValues", "stream-json/utils/Verifier"]);
  const seen = new Set();
  function inspect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (entry.name.endsWith(".js")) {
        for (const match of readFileSync(file, "utf8").matchAll(/["'](stream-json[^"']*)["']/g)) {
          assert(allowed.has(match[1]), `Unreviewed stream-json import in ${file}: ${match[1]}`);
          seen.add(match[1]);
        }
      }
    }
  }
  inspect(path.join(path.dirname(jaysonEntry), "lib"));
  assert.deepEqual(seen, allowed, "The reviewed Jayson imports changed; reassess the exception");
  const utils = jaysonRequire("./lib/utils");
  const parse = (chunks) => new Promise((resolve, reject) => {
    const stream = new PassThrough();
    const timeout = setTimeout(() => reject(new Error("Jayson parser did not settle")), 2_000);
    utils.parseStream(stream, {}, (error, value) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    });
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
  assert.deepEqual(await parse(['{"jsonrpc":"2.0","result":', '{"value":42},"id":1}']), {
    jsonrpc: "2.0", result: { value: 42 }, id: 1,
  });
  await assert.rejects(parse(['{"result":]']));
  const loaded = Object.keys(jaysonRequire.cache).filter((file) => file.includes(`${path.sep}stream-json${path.sep}`));
  assert(loaded.length > 0, "The installed stream-json graph was not inspected");
  assert(loaded.every((file) => !file.includes(`${path.sep}filters${path.sep}`)),
    "The vulnerable stream-json filters are reachable; remove the exception");
}
