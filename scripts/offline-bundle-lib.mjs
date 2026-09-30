/**
 * Helpers for scripts/offline-bundle.mjs that start no process and use no network: reading the
 * lockfiles, comparing a bundle's manifest with a checkout, checking npm's cache, and writing the
 * cargo config. They live here so tests/unit/scripts/offline-bundle.test.mjs can call them directly.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep as pathSep } from "node:path";

// Version 3: package-lock.json is hashed as canonical JSON without the root project's own name and
// version. Version 2 named what it hashed ("package.json dependencies", not the whole package.json)
// and recorded the npm digest check and the longest path. A bundle of an older version is refused.
export const FORMAT_VERSION = 3;
export const DEFAULT_BUNDLE_DIR = "offline-bundle";

// What ties a bundle to the source it was made for: the name the manifest gives each part, the
// file it comes from (relative to the repo root, always with "/"), and how it is hashed. None of it
// changes when only what npm and cargo do not install changes:
//   package.json      counts for its dependency fields only: a new script or version installs nothing
//   package-lock.json counts as JSON with its keys sorted, without the root project's own name and
//                     version (`npm version` rewrites them, and no dependency changes), so key
//                     order, indentation and line endings do not matter either
//   Cargo.lock        counts as text with CRLF read as LF: a Windows working tree from before
//                     .gitattributes asked for eol=lf still has CRLF, and git does not renormalise
//                     files it has not touched
export const LOCKED = [
  { name: "package.json dependencies", file: "package.json", hash: hashDependencies },
  { name: "package-lock.json", file: "package-lock.json", hash: hashLock },
  { name: "src-tauri/Cargo.lock", file: "src-tauri/Cargo.lock", hash: hashText },
];
export const LOCKED_FILES = LOCKED.map((part) => part.name);

// What `create --force` removes from a bundle folder before it starts again, and nothing else. The
// folder also holds npm-cache, which stays: it is addressed by content and safe to reuse, so a retry
// over a bad connection does not start from zero.
export const REPLACED_PARTS = ["cargo-vendor", "bin", "MANIFEST.json"];

// A file `create` writes into the folder first thing, so that a create that stops halfway still
// leaves a folder `create --force` knows it made.
export const BUNDLE_SENTINEL = ".offline-bundle";
export const BUNDLE_SENTINEL_TEXT = "A folder made by scripts/offline-bundle.mjs create. create --force may replace what it made here.\n";

// The first line of the .cargo/config.toml that `setup` writes. Without it the file is not ours,
// and `setup` leaves it alone.
export const CARGO_CONFIG_MARKER = "# Written by scripts/offline-bundle.mjs setup";

const TOOLS = ["node", "npm", "cargo", "rustc"];

// An expected failure: the message says what to do, and is printed without a stack.
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

// create [<dir>] [--no-binaries] [--force]
export function parseCreateArgs(argv) {
  const options = { dir: null, binaries: true, force: false };
  for (const arg of argv) {
    if (arg === "--no-binaries") options.binaries = false;
    else if (arg === "--force") options.force = true;
    else options.dir = takeFolder(arg, options.dir);
  }
  return options;
}

// setup [<dir>]
export function parseSetupArgs(argv) {
  let dir = null;
  for (const arg of argv) dir = takeFolder(arg, dir);
  return { dir };
}

// verify [--skip a,b] (or --skip=a,b); `stepNames` are the steps a name may refer to.
export function parseVerifyArgs(argv, stepNames) {
  const skip = new Set();
  const addNames = (list) => {
    for (const name of list.split(",").map((part) => part.trim()).filter(Boolean)) {
      if (!stepNames.includes(name)) {
        throw new UserError(`Unknown step "${name}" for --skip. The steps are: ${stepNames.join(", ")}.`);
      }
      skip.add(name);
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip") {
      if (i + 1 >= argv.length) throw new UserError("--skip needs a list of steps, for example --skip cargo-app.");
      addNames(argv[++i]);
    } else if (arg.startsWith("--skip=")) {
      addNames(arg.slice("--skip=".length));
    } else {
      throw new UserError(`Unexpected argument "${arg}". Usage: verify [--skip a,b]`);
    }
  }
  return { skip };
}

function takeFolder(arg, current) {
  if (arg.startsWith("-")) throw new UserError(`Unknown option ${arg}. Run with --help to see the usage.`);
  if (current !== null) throw new UserError(`Only one folder can be given, but got "${current}" and "${arg}".`);
  return arg;
}

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

// The npm packages a lockfile pins that a bundle must hold: { name, version, resolved, integrity }
// once per `resolved` URL, in lockfile order. That is every platform's optional packages too
// (esbuild, rollup, @tauri-apps/cli-*), so one bundle serves Windows, Linux and macOS. Not in the
// list: the root project (""), links, and packages bundled inside another package. `skipped` names
// the installed packages (a path with node_modules in it) left out because they lack `resolved` or
// `integrity`, a git dependency for one: the bundle cannot hold them.
export function lockedPackages(lock) {
  const entries = lock?.packages;
  if (entries === null || typeof entries !== "object") {
    throw new UserError(
      'package-lock.json has no "packages" list (it needs lockfileVersion 2 or 3). Run npm install with a current npm, then try again.',
    );
  }
  const seen = new Set();
  const packages = [];
  const skipped = [];
  for (const [path, entry] of Object.entries(entries)) {
    if (path === "" || entry.link || entry.inBundle) continue;
    // The package's own name when the entry gives one (an alias is installed under another name),
    // else the last folder name under node_modules.
    const at = path.lastIndexOf("node_modules/");
    const name = entry.name ?? (at === -1 ? path : path.slice(at + "node_modules/".length));
    if (entry.resolved && entry.integrity) {
      if (seen.has(entry.resolved)) continue;
      seen.add(entry.resolved);
      packages.push({ name, version: entry.version, resolved: entry.resolved, integrity: entry.integrity });
    } else if (path.includes("node_modules/")) {
      skipped.push(packageLabel({ name, version: entry.version }));
    }
  }
  return { packages, skipped };
}

// "name@version", or the name alone when the lockfile gives no version.
function packageLabel(item) {
  return item.version ? `${item.name}@${item.version}` : item.name;
}

// "a, b and 3 more": the first `limit` names of a list.
export function describeList(names, limit = 20) {
  return names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
}

// The sha512 hashes, in hex, that a lockfile integrity lists: "sha512-<base64>", possibly several
// separated by spaces, each possibly followed by options after a "?". Not in the list: hashes of
// other kinds, and anything that is not 64 bytes long.
function sha512Digests(integrity) {
  const digests = [];
  for (const hash of String(integrity).trim().split(/\s+/)) {
    const match = /^sha512-([A-Za-z0-9+/_-]+={0,2})$/.exec(hash.split("?")[0]);
    const digest = match ? Buffer.from(match[1], "base64") : null;
    if (digest !== null && digest.length === 64) digests.push(digest.toString("hex"));
  }
  return digests;
}

// npm's cache (cacache) keeps the content of a tarball in a file named by its sha512 in hex:
// <cache>/_cacache/content-v2/sha512/ab/cd/<rest>.
function contentFile(cache, hex) {
  return join(cache, "_cacache", "content-v2", "sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
}

// Where that is for a tarball with this lockfile integrity: one path for each sha512 hash it lists
// (it may list several), none when it has no sha512.
export function cacheContentFiles(cache, integrity) {
  return sha512Digests(integrity).map((hex) => contentFile(cache, hex));
}

// The sha512 of a file, in hex, read a piece at a time: a tarball is never held whole in memory.
export function sha512OfFile(path) {
  const hash = createHash("sha512");
  const piece = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    let read;
    while ((read = readSync(fd, piece, 0, piece.length, null)) > 0) hash.update(piece.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

// What is wrong in the npm cache with the content of `packages` (from lockedPackages), whatever OS
// they are for. This looks at the cache itself, not through npm: `npm ci --offline` leaves out a
// missing optional package without a word, even the host's own, and a damaged one with only a
// warning, and exits 0 either way (it also removes the damaged content from the cache).
//   missing    no content file for any hash the integrity lists
//   corrupt    content is there, but no file hashes to the digest it is named by (cut short, or a
//              byte changed)
//   unchecked  no sha512 to look for (an old lockfile): npm keeps those under a hash the lockfile
//              does not give
// Any one listed hash with intact content is enough. Each list holds name@version, in lockfile order.
export function inspectNpmCache(cache, packages) {
  const found = { missing: [], corrupt: [], unchecked: [] };
  for (const item of packages) {
    const digests = sha512Digests(item.integrity);
    if (digests.length === 0) {
      found.unchecked.push(packageLabel(item));
      continue;
    }
    const present = digests.filter((hex) => isFile(contentFile(cache, hex)));
    if (present.length === 0) found.missing.push(packageLabel(item));
    else if (!present.some((hex) => hashesTo(contentFile(cache, hex), hex))) found.corrupt.push(packageLabel(item));
  }
  return found;
}

// True when the file's sha512 is `hex`. A file that cannot be read is no good either.
function hashesTo(file, hex) {
  try {
    return sha512OfFile(file) === hex;
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Splits `items` into groups of at most `size`, keeping each group's text under `maxChars`
// (a command line has a length limit: cmd.exe stops at 8191 characters).
export function batches(items, size = 50, maxChars = 6000) {
  const groups = [];
  let group = [];
  let chars = 0;
  for (const item of items) {
    if (group.length > 0 && (group.length >= size || chars + item.length + 1 > maxChars)) {
      groups.push(group);
      group = [];
      chars = 0;
    }
    group.push(item);
    chars += item.length + 1;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

// cmd.exe reads one command line as text: an argument with a space or a special character needs quotes.
export function quoteArg(arg) {
  return arg === "" || /[\s"&|<>^%()!]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

// How to start npm. Under `npm run`, npm_execpath is npm's own script: node runs it, with no
// shell. Otherwise npm is found on the PATH, and on Windows that is npm.cmd, which Node refuses
// to start without a shell (EINVAL since Node 18.20.2 / 20.12.2), so the command line is quoted here.
export function npmInvocation({ platform, execPath, npmExecPath }, args) {
  if (npmExecPath && /[\\/]npm-cli\.c?js$/i.test(npmExecPath)) {
    return { command: execPath, args: [npmExecPath, ...args], shell: false };
  }
  if (platform === "win32") {
    return { command: ["npm", ...args.map(quoteArg)].join(" "), args: [], shell: true };
  }
  return { command: "npm", args, shell: false };
}

// ---------------------------------------------------------------------------
// Cargo
// ---------------------------------------------------------------------------

// The number of crates.io packages a Cargo.lock pins: what `cargo vendor` must have vendored.
export function countLockedCrates(cargoLockText) {
  return (cargoLockText.match(/^source = "(?:registry|sparse)\+/gm) ?? []).length;
}

// The .cargo/config.toml `setup` writes: crates.io replaced by the vendored folder, and no network.
// The path goes in a TOML literal string ('...'), so the backslashes of a Windows path stay as
// they are. A literal string cannot hold a single quote (or a control character): such a path is refused.
export function cargoConfigText(vendorDir) {
  if (/['\u0000-\u0008\u000a-\u001f\u007f]/.test(vendorDir)) {
    throw new UserError(
      `The bundle folder's path cannot go in a cargo config file because it contains a single quote or a control character: ${JSON.stringify(vendorDir)}. Move the bundle to a folder whose path has none, then run setup again.`,
    );
  }
  return [
    CARGO_CONFIG_MARKER,
    "# Cargo builds from the vendored crates in the offline bundle and never uses the network.",
    "# Delete this file to build online again.",
    "",
    "[source.crates-io]",
    'replace-with = "vendored-sources"',
    "",
    "[source.vendored-sources]",
    `directory = '${vendorDir}'`,
    "",
    "[net]",
    "offline = true",
    "",
  ].join("\n");
}

// What setup may do with an existing .cargo/config.toml (`existing` is its text, or null when
// there is none): write it, replace the one this script wrote before, or refuse to touch it.
export function cargoConfigAction(existing) {
  if (existing === null) return "create";
  return existing.split(/\r?\n/, 1)[0].trim() === CARGO_CONFIG_MARKER ? "replace" : "refuse";
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export function sha256Text(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(path) {
  return sha256Text(readFileSync(path));
}

// name (as in LOCKED_FILES) -> hash of that part of the repo at `root`, or null when its file is missing.
export function hashLockedFiles(root) {
  const hashes = {};
  for (const { name, file, hash } of LOCKED) {
    const path = join(root, ...file.split("/"));
    hashes[name] = existsSync(path) ? hash(path) : null;
  }
  return hashes;
}

function hashText(path) {
  return sha256Text(lineFeedOnly(readFileSync(path)));
}

// package-lock.json as canonical JSON (keys sorted at every level) without the root project's name
// and version: the top-level ones, and the ones of packages[""], the root's own entry. Everything
// else stays: lockfileVersion, the root's dependency fields, and every installed package.
function hashLock(path) {
  const lock = parseJson(readFileSync(path, "utf8"), path);
  if (lock !== null && typeof lock === "object") {
    delete lock.name;
    delete lock.version;
    const root = lock.packages?.[""];
    if (root !== null && typeof root === "object") {
      delete root.name;
      delete root.version;
    }
  }
  return sha256Text(canonicalJson(lock));
}

function hashDependencies(path) {
  return sha256Text(dependencyFingerprint(readFileSync(path, "utf8"), path));
}

// The bytes with every CRLF made LF. A lone CR stays: it is content.
function lineFeedOnly(bytes) {
  const out = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue;
    out[length++] = bytes[i];
  }
  return out.subarray(0, length);
}

// The fields of package.json that decide what npm installs.
const DEPENDENCY_FIELDS = [
  "dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
  "overrides", "bundleDependencies", "bundledDependencies",
];

// Those fields of package.json (its text) as JSON with every object's keys sorted, so that neither
// the order of keys nor anything else in the file (scripts, version, formatting) changes it.
export function dependencyFingerprint(text, label = "package.json") {
  const parsed = parseJson(text, label);
  const fields = {};
  for (const field of DEPENDENCY_FIELDS) {
    if (parsed?.[field] !== undefined) fields[field] = parsed[field];
  }
  return canonicalJson(fields);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new UserError(`${label} is not valid JSON (${error.message}).`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// The manifest from MANIFEST.json's text, or a UserError that says what is wrong with it.
export function parseManifest(text, manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new UserError(`${manifestPath} is not valid JSON. The bundle is damaged: copy it again, or make a new one with create.`);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new UserError(`${manifestPath} is not a bundle manifest. Copy the bundle again, or make a new one with create.`);
  }
  if (manifest.formatVersion !== FORMAT_VERSION) {
    throw new UserError(
      `${manifestPath} has format version ${manifest.formatVersion}; this script reads version ${FORMAT_VERSION}. Use the script from the source the bundle was made from, or make a new bundle.`,
    );
  }
  if (manifest.sha256 === null || typeof manifest.sha256 !== "object") {
    throw new UserError(`${manifestPath} lists no file hashes, so it cannot be matched to this source. Make a new bundle with create.`);
  }
  return manifest;
}

// The locked files whose hash differs from the manifest's. `actual` maps each name to its sha256,
// or to null for a file that is missing here.
export function hashMismatches(recorded, actual) {
  return LOCKED_FILES.filter((name) => actual[name] !== recorded[name]);
}

export function mismatchMessage(names, manifest) {
  const commit = manifest.gitCommit ? ` (git commit ${String(manifest.gitCommit).slice(0, 12)})` : "";
  return (
    `The bundle was made for other dependencies: ${joinNames(names)} ${names.length === 1 ? "differs" : "differ"} ` +
    `from what the bundle was made from${commit}. ` +
    "Use the same source, or make a new bundle from this one on a machine with internet access (npm run offline:bundle)."
  );
}

function joinNames(names) {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Toolchain
// ---------------------------------------------------------------------------

// The first version number in a tool's --version output, or null:
// "cargo 1.94.1 (29ea6fb6a 2026-03-24)" -> "1.94.1".
export function parseVersion(text) {
  const match = /\d+\.\d+(?:\.\d+)?/.exec(text ?? "");
  return match ? match[0] : null;
}

// "22.22.2" -> "22.22"; null when there is no version.
export function majorMinor(version) {
  const match = /^v?(\d+)\.(\d+)/.exec(version ?? "");
  return match ? `${match[1]}.${match[2]}` : null;
}

function isOlder(a, b) {
  const [aMajor, aMinor] = a.split(".").map(Number);
  const [bMajor, bMinor] = b.split(".").map(Number);
  return aMajor !== bMajor ? aMajor < bMajor : aMinor < bMinor;
}

// One warning per tool whose major.minor here differs from the one that made the bundle. `made`
// and `here` map node, npm, cargo and rustc to a version, or to null for a tool that is missing.
export function toolchainWarnings(made, here) {
  const warnings = [];
  for (const tool of TOOLS) {
    const wanted = majorMinor(made?.[tool]);
    if (wanted === null) continue;
    const found = majorMinor(here?.[tool]);
    if (found === null) {
      warnings.push(`${tool} was not found on this machine; the bundle was made with ${tool} ${wanted}.`);
    } else if (found !== wanted) {
      let text = `${tool} is ${found} here; the bundle was made with ${wanted}.`;
      // The vendored crates state the oldest rustc they build with (rust-version).
      if (tool === "rustc" && isOlder(found, wanted)) {
        text += ` The vendored crates may need rustc ${wanted} or newer and refuse to build with this one: update Rust.`;
      }
      warnings.push(text);
    }
  }
  return warnings;
}

// A warning when the bundle's Linux binaries were built on a newer glibc than this machine has,
// or on a machine that has none (they link the system's libc and libssl.so.3, so they follow the
// distro), or null. `made` and `here` are glibc versions, null when unknown.
export function glibcWarning(made, here) {
  const rebuild = "If they fail, build them here with npm run build:cli and npm run build:core.";
  if (!made) return null;
  if (!here) return `The prebuilt binaries were built on glibc ${made}, and this machine's glibc could not be found, so they may not start. ${rebuild}`;
  const [madeMajor, madeMinor] = made.split(".").map(Number);
  const [hereMajor, hereMinor] = here.split(".").map(Number);
  if (hereMajor > madeMajor || (hereMajor === madeMajor && hereMinor >= madeMinor)) return null;
  return `The prebuilt binaries were built on glibc ${made}; this machine has glibc ${here}, so they may not start. ${rebuild}`;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

// A header and rows of cells as text lines, each column as wide as its longest cell.
export function formatTable(header, rows) {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((row) => String(row[i]).length)));
  const line = (row) => row.map((cell, i) => String(cell).padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// The longest path inside a bundle, relative to its folder, in characters. `create` measures it
// and writes it in the manifest; this is the estimate to use before the bundle exists, or when a
// manifest lacks it (167 in an npm cache file and 166 under cargo-vendor when it was measured).
const LONGEST_BUNDLE_PATH = 170;

// Windows stops at 260 characters (259 and the end of the string) unless long paths are enabled.
const WINDOWS_MAX_PATH = 260;

// A warning when the bundle folder's path, and the longest path inside the bundle (`longest`), add
// up to more than Windows takes, so that copying or reading some files may fail. Or null.
export function longPathWarning(dir, platform, longest = LONGEST_BUNDLE_PATH) {
  const below = Number.isFinite(longest) ? longest : LONGEST_BUNDLE_PATH;
  const total = dir.length + 1 + below;
  if (platform !== "win32" || total < WINDOWS_MAX_PATH) return null;
  return `The bundle folder's path is ${dir.length} characters long, and the longest path inside the bundle is ${below} characters, so paths reach ${total}. Windows stops at ${WINDOWS_MAX_PATH} unless long paths are enabled, so copying or reading some files may fail: use a shorter folder, such as C:\\offline-bundle.`;
}

// True when `dir` is a folder this script made: it holds the sentinel `create` writes first, or the
// MANIFEST.json of a bundle (a bundle from before the sentinel has only that): a numeric
// formatVersion and the sha256 object, which every version of the manifest has. What `create --force`
// may clear must pass this, so that --force cannot empty a folder that just has a `bin` in it.
export function isBundleFolder(dir) {
  if (isFile(join(dir, BUNDLE_SENTINEL))) return true;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8"));
    return isObject(manifest) && typeof manifest.formatVersion === "number" && isObject(manifest.sha256);
  } catch {
    return false;
  }
}

// A JSON object: not null, not a list.
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// True when `path` is `parent` itself or inside it.
export function isInsideDir(parent, path) {
  const rel = relative(parent, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + pathSep) && !isAbsolute(rel));
}
