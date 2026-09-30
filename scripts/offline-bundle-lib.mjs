/**
 * Helpers for scripts/offline-bundle.mjs that need no process and no network: reading the
 * lockfiles, comparing a bundle's manifest with a checkout, and writing the cargo config.
 * They live here so tests/unit/scripts/offline-bundle.test.mjs can call them directly.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep as pathSep } from "node:path";

export const FORMAT_VERSION = 1;
export const DEFAULT_BUNDLE_DIR = "offline-bundle";

// The files whose sha256 ties a bundle to the source it was made for (paths are relative to the
// repo root, always with "/").
export const LOCKED_FILES = ["package.json", "package-lock.json", "src-tauri/Cargo.lock"];

// What `create` writes into the bundle folder. `create --force` removes these and nothing else.
export const BUNDLE_PARTS = ["npm-cache", "cargo-vendor", "bin", "MANIFEST.json"];

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

// The `resolved` URL of every npm package the lockfile pins, once each, in lockfile order. That is
// every platform's optional packages too (esbuild, rollup, @tauri-apps/cli-*), so one bundle
// serves Windows, Linux and macOS. Skipped: the root project (""), links, packages bundled inside
// another package, and entries without both `resolved` and `integrity`.
export function npmTarballs(lock) {
  const packages = lock?.packages;
  if (packages === null || typeof packages !== "object") {
    throw new UserError(
      'package-lock.json has no "packages" list (it needs lockfileVersion 2 or 3). Run npm install with a current npm, then try again.',
    );
  }
  const urls = new Set();
  for (const [path, entry] of Object.entries(packages)) {
    if (path === "" || entry.link || entry.inBundle) continue;
    if (entry.resolved && entry.integrity) urls.add(entry.resolved);
  }
  return [...urls];
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
    `from the file${names.length === 1 ? "" : "s"} the bundle was made from${commit}. ` +
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

// The longest path inside a bundle, relative to its folder, is about 158 characters (an npm cache
// file), and Windows stops at 260 unless long paths are enabled.
const LONGEST_BUNDLE_PATH = 160;
const WINDOWS_MAX_PATH = 260;

// A warning when the bundle folder's path is long enough that Windows may refuse the files inside
// it (copying the folder is where it shows first), or null.
export function longPathWarning(dir, platform) {
  if (platform !== "win32" || dir.length + 1 + LONGEST_BUNDLE_PATH < WINDOWS_MAX_PATH) return null;
  return `The bundle folder's path is ${dir.length} characters long, and the bundle holds files with paths up to ${LONGEST_BUNDLE_PATH} characters longer. Windows stops at ${WINDOWS_MAX_PATH} characters unless long paths are enabled, so copying or reading them may fail: use a shorter folder, such as C:\\offline-bundle.`;
}

// True when `path` is `parent` itself or inside it.
export function isInsideDir(parent, path) {
  const rel = relative(parent, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + pathSep) && !isAbsolute(rel));
}
