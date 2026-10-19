/**
 * FETCH the pinned native runtime trees (Postgres + pgvector, llama-server)
 * for one or more targets, or fail.
 *
 * For each target: download the release asset the lock names, verify its
 * sha256 and size against the lock BEFORE anything is extracted, extract into a
 * scratch directory, refuse anything that is not a regular file under
 * `<target>/postgres/` or `<target>/llama/`, re-derive the tree listing from the
 * extracted bytes, and accept it only if its digest is the lock's `treeSha256`.
 * Only then does the tree replace `resources/native-runtime/<target>/`, with the
 * listing (`SHA256SUMS`) and a record of the release beside it.
 *
 * IDEMPOTENT: a target whose fetched tree already matches the lock - release
 * record, listing digest, and every file against the listing - is left alone
 * without touching the network. A verified download is kept in
 * `resources/native-runtime/.downloads/` and reused.
 *
 * WHERE FROM. `<baseUrl>/<asset>` from the lock. While that is a GitHub release
 * on a PRIVATE repository, a plain download is refused (404), so with a token
 * in `VEX_NATIVE_RUNTIME_TOKEN` (or `GH_TOKEN` / `GITHUB_TOKEN`) the asset is
 * resolved through the GitHub API instead. The token is sent to api.github.com
 * only, never to the storage host the API redirects to, and never logged. A
 * public location needs no token at all.
 *
 * Usage (from vex-app/):
 *   node scripts/fetch-native-runtime.mjs                     # every target of this host's platform
 *   node scripts/fetch-native-runtime.mjs --platform win      # both Windows targets
 *   node scripts/fetch-native-runtime.mjs --target linux-x64  # one target (repeatable)
 *   node scripts/fetch-native-runtime.mjs --current           # this host's own platform/arch
 *   node scripts/fetch-native-runtime.mjs --all               # all five
 *
 * Bumping the runtime (a reviewed change; never hand-edit digests):
 *   node scripts/fetch-native-runtime.mjs --update-lock native-runtime-<yyyy.mm.dd>-<n> [--base-url <url>]
 * downloads the release's SHA256SUMS and every asset, verifies each asset
 * against it, extracts and gates every tree, and only then rewrites the lock
 * from what it measured.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  evaluateNativeRuntimeTree,
  fetchedNativeRuntimeDir,
  fetchedNativeRuntimeRoot,
  listTreeFiles,
  NATIVE_RUNTIME_COMPONENTS,
  NATIVE_RUNTIME_LISTING_FILE,
  NATIVE_RUNTIME_LOCK_FILE,
  NATIVE_RUNTIME_RELEASE_FILE,
  NATIVE_RUNTIME_TARGETS,
  nativeRuntimeAssetName,
  nativeRuntimeTargetFor,
  nativeRuntimeTargetNamed,
  nativeRuntimeTargetsForPlatform,
  parseTreeListing,
  readFetchedListing,
  readNativeRuntimeLock,
  renderTreeListing,
  sha256OfText,
  validateNativeRuntimeLock,
} from "./native-runtime-artifact.mjs";
import { sha256OfFile } from "./lighter-signer-artifact.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const targets = [];
  let updateLock;
  let baseUrl;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const needValue = () => {
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      i += 1;
      return value;
    };
    if (flag === "--target") targets.push(nativeRuntimeTargetNamed(needValue()));
    else if (flag === "--platform") targets.push(...nativeRuntimeTargetsForPlatform(needValue()));
    else if (flag === "--current") targets.push(nativeRuntimeTargetFor(process.platform, process.arch));
    else if (flag === "--all") targets.push(...NATIVE_RUNTIME_TARGETS);
    else if (flag === "--update-lock") updateLock = needValue();
    else if (flag === "--base-url") baseUrl = needValue();
    else throw new Error(`unknown argument ${flag}; accepts --target, --platform, --current, --all, --update-lock, --base-url`);
  }
  if (baseUrl !== undefined && updateLock === undefined) throw new Error("--base-url only applies to --update-lock");
  const chosen = targets.length > 0 ? targets : nativeRuntimeTargetsForPlatform(process.platform);
  return { targets: [...new Set(chosen)], updateLock, baseUrl };
}

// ── Download ────────────────────────────────────────────────────────────────

function token() {
  for (const name of ["VEX_NATIVE_RUNTIME_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** `{ owner, repo, tag }` when `baseUrl` is a GitHub release download location. */
function githubRelease(baseUrl) {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\/download\/([^/]+)\/?$/.exec(baseUrl);
  return match === null ? undefined : { owner: match[1], repo: match[2], tag: decodeURIComponent(match[3]) };
}

const releaseAssetsCache = new Map();

/** The API URL of one release asset, through the authenticated releases API. */
async function githubAssetApiUrl(release, assetName, auth) {
  const key = `${release.owner}/${release.repo}@${release.tag}`;
  if (!releaseAssetsCache.has(key)) {
    const url = `https://api.github.com/repos/${release.owner}/${release.repo}/releases/tags/${encodeURIComponent(release.tag)}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${auth}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status} for release ${key}; does the token have read access to ${release.owner}/${release.repo}?`);
    }
    const body = await response.json();
    releaseAssetsCache.set(key, new Map(body.assets.map((asset) => [asset.name, asset.url])));
  }
  const assetUrl = releaseAssetsCache.get(key).get(assetName);
  if (assetUrl === undefined) throw new Error(`release ${key} has no asset ${assetName}`);
  return assetUrl;
}

/**
 * The response for one asset. With a token and a GitHub release location, the
 * asset API answers with a redirect to signed storage; it is followed BY HAND
 * so the Authorization header is never offered to that host.
 */
async function openAsset(baseUrl, assetName) {
  const release = githubRelease(baseUrl);
  const auth = token();
  if (release !== undefined && auth !== undefined) {
    const apiUrl = await githubAssetApiUrl(release, assetName, auth);
    const redirect = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${auth}`, Accept: "application/octet-stream", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "manual",
    });
    if (redirect.status >= 300 && redirect.status < 400) {
      const location = redirect.headers.get("location");
      if (location === null) throw new Error(`GitHub API redirected ${assetName} without a location`);
      await redirect.body?.cancel();
      return fetch(location);
    }
    return redirect;
  }
  const url = `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(assetName)}`;
  const response = await fetch(url);
  if (response.status === 404 && release !== undefined) {
    await response.body?.cancel();
    throw new Error(
      `${url} answered 404. If that release is on a private repository, give this script a token with read `
        + "access in VEX_NATIVE_RUNTIME_TOKEN (or GH_TOKEN), e.g. GH_TOKEN=$(gh auth token)."
    );
  }
  return response;
}

/**
 * Download one asset to `destination`, hashing while writing. Resolves to
 * `{ sha256, bytes }` of what was written; the caller compares them with what
 * it expects before the file is used for anything.
 */
async function downloadAsset(baseUrl, assetName, destination) {
  const response = await openAsset(baseUrl, assetName);
  if (!response.ok || response.body === null) {
    throw new Error(`downloading ${assetName} from ${baseUrl} failed: HTTP ${response.status}`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  mkdirSync(path.dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination));
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * A verified copy of the asset in the download cache: reused when its digest
 * and size match, otherwise downloaded to a `.partial` file, checked, and only
 * then renamed into place. A mismatch deletes the partial file and fails.
 */
async function verifiedDownload(baseUrl, assetName, expected) {
  const cache = path.join(fetchedNativeRuntimeRoot(APP_ROOT), ".downloads");
  const file = path.join(cache, assetName);
  if (existsSync(file) && statSync(file).size === expected.bytes && sha256OfFile(file) === expected.sha256) {
    return file;
  }
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  const got = await downloadAsset(baseUrl, assetName, partial);
  if (got.sha256 !== expected.sha256 || got.bytes !== expected.bytes) {
    rmSync(partial, { force: true });
    throw new Error(
      `${assetName} from ${baseUrl} is ${got.bytes} bytes with sha256 ${got.sha256}; `
        + `expected ${expected.bytes} bytes with sha256 ${expected.sha256}. Nothing was extracted.`
    );
  }
  renameSync(partial, file);
  return file;
}

// ── Extraction ──────────────────────────────────────────────────────────────

/**
 * The tar to run. On Windows that is the system's own bsdtar
 * (`%SystemRoot%\System32\tar.exe`), named by full path: under Git Bash a bare
 * `tar` is GNU tar, which reads `C:\...` as a remote host.
 */
function tarCommand() {
  if (process.platform !== "win32") return "tar";
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}

function runTar(args) {
  const result = spawnSync(tarCommand(), args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) throw new Error(`${tarCommand()} could not be run: ${result.error.message}`);
  if (result.status !== 0) {
    const version = spawnSync(tarCommand(), ["--version"], { encoding: "utf8" });
    throw new Error(
      `${tarCommand()} ${args[0]} failed (exit ${result.status}): ${(result.stderr ?? "").trim()}\n`
        + `    tar --version: ${(version.stdout ?? "").split("\n")[0]}`
    );
  }
  return result.stdout;
}

/**
 * Every member must sit under `<target>/postgres/` or `<target>/llama/`, as
 * the publish job packs them, with no absolute or parent-relative path. Read
 * BEFORE extracting, so a hostile name is refused before it is written.
 */
function assertArchiveMembers(archive, target) {
  const members = runTar(["-tf", archive]).split(/\r?\n/).filter((line) => line.length > 0);
  if (members.length === 0) throw new Error(`${archive} lists no members`);
  for (const member of members) {
    const name = member.replace(/\/$/, "");
    const parts = name.split("/");
    const inside = parts[0] === target.name
      && (parts.length === 1 || NATIVE_RUNTIME_COMPONENTS.includes(parts[1]));
    if (!inside || name.includes("\\") || parts.some((part) => part === ".." || part === "")) {
      throw new Error(`${archive} carries ${JSON.stringify(member)}, outside ${target.name}/{postgres,llama}/`);
    }
  }
  return members.length;
}

/**
 * Extract one verified archive into a scratch directory beside the final one
 * and return the extracted `<scratch>/<target>` directory. The scratch
 * directory is the caller's to move or delete.
 */
function extractArchive(archive, target, scratch) {
  assertArchiveMembers(archive, target);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  runTar(["-xf", archive, "-C", scratch]);
  const extracted = path.join(scratch, target.name);
  for (const component of NATIVE_RUNTIME_COMPONENTS) {
    if (!existsSync(path.join(extracted, component))) {
      throw new Error(`${archive} has no ${target.name}/${component} tree`);
    }
  }
  return extracted;
}

/** The listing of an extracted tree, measured from its bytes. */
function measureListing(treeDir) {
  const dirs = Object.fromEntries(NATIVE_RUNTIME_COMPONENTS.map((component) => [component, path.join(treeDir, component)]));
  const entries = listTreeFiles(dirs).map((entry) => ({ path: entry.path, digest: sha256OfFile(entry.file) }));
  const text = renderTreeListing(entries);
  return { text, digest: sha256OfText(text), files: entries.length, dirs };
}

function componentDirsOf(treeDir) {
  return Object.fromEntries(NATIVE_RUNTIME_COMPONENTS.map((component) => [component, path.join(treeDir, component)]));
}

/** The fetch root carries its own ignore rule: everything in it is build input fetched from elsewhere. */
function ensureFetchRoot() {
  const root = fetchedNativeRuntimeRoot(APP_ROOT);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, ".gitignore"), "*\n");
  return root;
}

// ── Fetch ───────────────────────────────────────────────────────────────────

/** True when the fetched tree for `target` already IS the locked one. */
function fetchedTreeIsCurrent(target, lock) {
  const dir = fetchedNativeRuntimeDir(APP_ROOT, target);
  const recordFile = path.join(dir, NATIVE_RUNTIME_RELEASE_FILE);
  if (!existsSync(recordFile)) return false;
  try {
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    const entry = lock.targets[target.name];
    if (record.release !== lock.release || record.sha256 !== entry.sha256 || record.treeSha256 !== entry.treeSha256) {
      return false;
    }
    const listing = readFetchedListing(APP_ROOT, target, lock);
    return evaluateNativeRuntimeTree(componentDirsOf(dir), target, listing).issues.length === 0;
  } catch {
    return false;
  }
}

/**
 * Fetch one target to `resources/native-runtime/<target>/`, or throw with the
 * reason named. Returns `{ target, status, dir }`.
 */
export async function fetchNativeRuntime(target, lock) {
  const entry = lock.targets[target.name];
  const dir = fetchedNativeRuntimeDir(APP_ROOT, target);
  if (fetchedTreeIsCurrent(target, lock)) return { target, status: "already current", dir };

  const root = ensureFetchRoot();
  const archive = await verifiedDownload(lock.baseUrl, entry.asset, entry);
  const scratch = path.join(root, `.extract-${target.name}`);
  try {
    const extracted = extractArchive(archive, target, scratch);
    const measured = measureListing(extracted);
    if (measured.digest !== entry.treeSha256 || measured.files !== entry.files) {
      throw new Error(
        `${entry.asset} extracted to ${measured.files} files with listing digest ${measured.digest}; `
          + `${NATIVE_RUNTIME_LOCK_FILE} pins ${entry.files} files and ${entry.treeSha256}`
      );
    }
    const listing = parseTreeListing(measured.text, `${entry.asset} listing`);
    const { issues } = evaluateNativeRuntimeTree(measured.dirs, target, listing);
    if (issues.length > 0) {
      throw new Error(`${entry.asset} does not hold a usable ${target.name} runtime:\n    - ${issues.join("\n    - ")}`);
    }

    rmSync(dir, { recursive: true, force: true });
    renameSync(extracted, dir);
    writeFileSync(path.join(dir, NATIVE_RUNTIME_LISTING_FILE), measured.text);
    writeFileSync(
      path.join(dir, NATIVE_RUNTIME_RELEASE_FILE),
      `${JSON.stringify({ release: lock.release, asset: entry.asset, sha256: entry.sha256, treeSha256: entry.treeSha256 }, null, 2)}\n`
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // Read back through the same path every later gate takes.
  const listing = readFetchedListing(APP_ROOT, target, lock);
  const { issues } = evaluateNativeRuntimeTree(componentDirsOf(dir), target, listing);
  if (issues.length > 0) throw new Error(`${dir} failed re-verification:\n    - ${issues.join("\n    - ")}`);
  return { target, status: `fetched ${entry.asset} (${lock.release})`, dir };
}

// ── Lock update ─────────────────────────────────────────────────────────────

/**
 * Rewrite the lock from a published release, measuring everything it records:
 * each asset is checked against the release's own SHA256SUMS, extracted and
 * gated exactly as a fetch would, and only a release whose five trees all pass
 * is written.
 */
async function updateLock(release, explicitBaseUrl) {
  let baseUrl = explicitBaseUrl;
  if (baseUrl === undefined) {
    const current = readNativeRuntimeLock(APP_ROOT);
    const github = githubRelease(current.baseUrl);
    if (github === undefined) throw new Error("the current lock is not a GitHub release location; pass --base-url");
    baseUrl = `https://github.com/${github.owner}/${github.repo}/releases/download/${release}`;
  }

  const root = ensureFetchRoot();
  const sumsFile = path.join(root, ".downloads", `${release}-SHA256SUMS`);
  await downloadAsset(baseUrl, "SHA256SUMS", sumsFile);
  const published = new Map();
  for (const line of readFileSync(sumsFile, "utf8").split("\n").filter((l) => l.length > 0)) {
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line);
    if (match === null) throw new Error(`${release} SHA256SUMS has a malformed line: ${line}`);
    published.set(match[2], match[1]);
  }

  const targets = {};
  for (const target of NATIVE_RUNTIME_TARGETS) {
    const asset = nativeRuntimeAssetName(target);
    const sha256 = published.get(asset);
    if (sha256 === undefined) throw new Error(`${release} SHA256SUMS lists no ${asset}`);
    const file = path.join(root, ".downloads", asset);
    const got = await downloadAsset(baseUrl, asset, `${file}.partial`);
    if (got.sha256 !== sha256) {
      rmSync(`${file}.partial`, { force: true });
      throw new Error(`${asset} downloaded with sha256 ${got.sha256}; the release's SHA256SUMS says ${sha256}`);
    }
    renameSync(`${file}.partial`, file);
    const scratch = path.join(root, `.extract-${target.name}`);
    try {
      const measured = measureListing(extractArchive(file, target, scratch));
      const listing = parseTreeListing(measured.text, `${asset} listing`);
      const { issues } = evaluateNativeRuntimeTree(measured.dirs, target, listing);
      if (issues.length > 0) {
        throw new Error(`${asset} does not hold a usable ${target.name} runtime:\n    - ${issues.join("\n    - ")}`);
      }
      targets[target.name] = { asset, sha256, bytes: got.bytes, treeSha256: measured.digest, files: measured.files };
      console.log(`native-runtime: ${asset} ${got.bytes} B sha256 ${sha256}, ${measured.files} files, tree ${measured.digest}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const lock = validateNativeRuntimeLock({ release, baseUrl, targets });
  writeFileSync(path.join(APP_ROOT, NATIVE_RUNTIME_LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`native-runtime: wrote ${NATIVE_RUNTIME_LOCK_FILE} for ${release}`);
}

async function main() {
  const { targets, updateLock: release, baseUrl } = parseArgs(process.argv.slice(2));
  if (release !== undefined) {
    await updateLock(release, baseUrl);
    return;
  }
  const lock = readNativeRuntimeLock(APP_ROOT);
  for (const target of targets) {
    const result = await fetchNativeRuntime(target, lock);
    console.log(`native-runtime: ${target.name} ${result.status} -> ${path.relative(APP_ROOT, result.dir)}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
