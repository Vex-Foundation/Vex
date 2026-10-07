import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// The reviewed major override is safe for Solana's browser HTTP client only.
// Jayson's TCP/TLS framing changed in v5, so fail if the SDK starts importing it.
export async function verifySolanaRpcDependency(projectRoot) {
  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  const sdkEntry = projectRequire.resolve("@solana/web3.js");
  const sdkRequire = createRequire(sdkEntry);
  const jaysonEntry = sdkRequire.resolve("jayson");
  const jaysonRoot = path.dirname(jaysonEntry);
  const manifest = JSON.parse(readFileSync(path.join(jaysonRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, "5.0.0", "Reassess the Solana Jayson override before changing its version");
  assert(!Object.hasOwn(manifest.dependencies ?? {}, "stream-json"), "The vulnerable parser dependency returned");

  const sdkImports = new Set();
  for (const file of javascriptFiles(path.dirname(sdkEntry))) {
    for (const match of readFileSync(file, "utf8").matchAll(/["'](jayson(?:\/[^"']*)?)["']/g)) {
      sdkImports.add(match[1]);
    }
  }
  assert.deepEqual(sdkImports, new Set(["jayson/lib/client/browser"]),
    "Solana's Jayson imports changed; reassess TCP/TLS compatibility");
  for (const file of javascriptFiles(path.join(jaysonRoot, "lib"))) {
    assert(!/["']stream-json(?:\/[^"']*)?["']/.test(readFileSync(file, "utf8")),
      `The vulnerable parser is imported by ${file}`);
  }

  const browserEntry = sdkRequire.resolve("jayson/lib/client/browser");
  const browserGraph = new Set();
  function inspectBrowser(file) {
    if (browserGraph.has(file)) return;
    browserGraph.add(file);
    const moduleRequire = createRequire(file);
    for (const match of readFileSync(file, "utf8").matchAll(/require\(["']([^"']+)["']\)/g)) {
      assert(match[1].startsWith("."), `Unreviewed browser dependency: ${match[1]}`);
      inspectBrowser(moduleRequire.resolve(match[1]));
    }
  }
  inspectBrowser(browserEntry);
  assert.deepEqual(browserGraph, new Set([
    browserEntry,
    path.join(jaysonRoot, "lib", "generateRequest.js"),
    path.join(jaysonRoot, "lib", "generateId.js"),
  ]), "Jayson's browser dependency graph changed");

  const Client = sdkRequire("jayson/lib/client/browser");
  const client = new Client(() => assert.fail("Parser checks must not dispatch a request"));
  const generated = client.request("getVersion", []);
  assert.match(generated.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(generated.params, []);
  assert.equal(generated.jsonrpc, "2.0");
  assert(!Object.hasOwn(client.request("getVersion", [], null), "id"));
  assert.deepEqual(client.request("getSlot", [], 42), { method: "getSlot", jsonrpc: "2.0", params: [], id: 42 });

  const parse = (text) => new Promise((resolve, reject) => {
    client._parseResponse(null, text, (error, value) => error ? reject(error) : resolve(value));
  });
  for (const proto of ['{"isAdmin":true}', '["admin"]', "null", "false", '"value"']) {
    const text = '{"jsonrpc":"2.0","id":1,"result":{"__proto__":' + proto +
      ',"constructor":{"prototype":{"polluted":true}},"nested":{"__proto__":{"isAdmin":true}},"tail":42}}';
    const response = await parse(text);
    assert.deepEqual(response, JSON.parse(text), "Response differs from native JSON.parse");
    assert.equal(Object.getPrototypeOf(response.result), Object.prototype);
    assert.equal(Object.hasOwn(response.result, "__proto__"), true);
    assert.equal(response.result.isAdmin, undefined);
    assert.equal(response.result.tail, 42);
    assert.equal(Object.getPrototypeOf(response.result.nested), Object.prototype);
    assert.equal(response.result.nested.isAdmin, undefined);
    assert.equal(Object.hasOwn(response.result, "constructor"), true);
    assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  }
  const duplicate = '{"__proto__":{"isAdmin":true},"__proto__":null,"tail":"λ🌍"}';
  assert.deepEqual(await parse(duplicate), JSON.parse(duplicate));
  await assert.rejects(parse('{"result":]'), SyntaxError);
  await assert.rejects(parse('/* comment */ {"result":1}'), SyntaxError);
  await assert.rejects(parse('{"result":1} {"result":2}'), SyntaxError);

  const transportError = new Error("controlled transport error");
  await assert.rejects(new Promise((resolve, reject) => {
    client._parseResponse(transportError, "", (error, value) => error ? reject(error) : resolve(value));
  }), (error) => error === transportError);
  assert.equal(await parse(""), undefined);

  const batch = [
    { jsonrpc: "2.0", id: "a", result: 42 },
    { jsonrpc: "2.0", id: "b", error: { code: -32601, message: "not found" } },
  ];
  assert.deepEqual(await parse(JSON.stringify(batch)), batch);
  await new Promise((resolve, reject) => {
    client._parseResponse(null, JSON.stringify(batch), (error, errors, successes) => {
      try {
        assert.ifError(error);
        assert.deepEqual(errors, [batch[1]]);
        assert.deepEqual(successes, [batch[0]]);
        resolve();
      } catch (failure) { reject(failure); }
    });
  });
  const revived = new Client(() => assert.fail("Reviver check must not dispatch"), {
    reviver: (key, value) => key === "amount" ? Number(value) : value,
    generator: () => "reviewed-custom-id",
  });
  assert.equal(revived.request("getVersion", []).id, "reviewed-custom-id");
  revived._parseResponse(null, '{"amount":"42","__proto__":{"isAdmin":true}}', (error, value) => {
    assert.ifError(error);
    assert.equal(value.amount, 42);
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.equal(value.isAdmin, undefined);
    assert.equal(Object.hasOwn(value, "__proto__"), true);
  });
}

function* javascriptFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* javascriptFiles(file);
    else if (entry.name.endsWith(".js")) yield file;
  }
}
