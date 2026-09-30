#!/usr/bin/env node
/**
 * offline-bundle — build and test Harness Studio on a machine with no internet.
 *
 * Usage (with npm, put -- before the options: npm run offline:bundle -- --no-binaries):
 *   node scripts/offline-bundle.mjs create [<dir>] [--no-binaries] [--force]
 *   node scripts/offline-bundle.mjs setup  [<dir>]
 *   node scripts/offline-bundle.mjs verify [--skip a,b]
 *
 * create  (on a machine with internet) puts every npm package and Rust crate the lockfiles name
 *         into <dir> (default: offline-bundle in the repo root), the prebuilt harness-run.mjs and
 *         harness-core for this OS, and MANIFEST.json, which ties the bundle to this source.
 * setup   (on the offline machine) checks the bundle was made for this source, points cargo at the
 *         vendored crates (.cargo/config.toml), installs node_modules from the bundle's npm cache,
 *         and installs the prebuilt binaries.
 * verify  runs the type check, the tests and the builds, and prints a pass/fail table.
 *
 * Node built-ins only: it spawns npm, cargo, rustc and git. The helpers that start no process are
 * in offline-bundle-lib.mjs. See tests/unit/scripts/offline-bundle.test.mjs.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_SENTINEL, BUNDLE_SENTINEL_TEXT, DEFAULT_BUNDLE_DIR, FORMAT_VERSION, LOCKED, REPLACED_PARTS, UserError,
  batches, cargoConfigAction, cargoConfigText, countLockedCrates, describeList, formatBytes, formatTable,
  glibcWarning, hashLockedFiles, hashMismatches, isBundleFolder, isInsideDir, lockedPackages, longPathWarning,
  mismatchMessage, missingFromNpmCache, npmInvocation, parseCreateArgs, parseManifest, parseSetupArgs,
  parseVerifyArgs, parseVersion, sha256File, toolchainWarnings,
} from "./offline-bundle-lib.mjs";

// The repo root: this script lives in <root>/scripts.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CARGO_MANIFEST = "src-tauri/Cargo.toml";

function usageText() {
  return `Usage: node scripts/offline-bundle.mjs <command> [options]

Build and test Harness Studio on a machine with no internet.

Commands:
  create [<dir>] [--no-binaries] [--force]
      On a machine with internet: put every npm package and Rust crate into <dir>
      (default: ${DEFAULT_BUNDLE_DIR}), plus the prebuilt binaries for this OS unless
      --no-binaries. A folder that is not empty is refused. --force replaces a bundle this
      script made (${REPLACED_PARTS.join(", ")}; its npm-cache is kept) and refuses any
      other folder.
  setup [<dir>]
      On the offline machine, from a copy of the same source: check the bundle matches it,
      point cargo at the vendored crates (.cargo/config.toml), run npm ci from the bundle,
      and install the prebuilt binaries.
  verify [--skip a,b]
      Run the type check, the tests and the builds. Steps: ${verifyStepNames().join(", ")}.
      For example --skip cargo-app on a machine without the Tauri system libraries.

With npm scripts, put -- before the options: npm run offline:bundle -- --no-binaries`;
}

// ---------------------------------------------------------------------------
// Running tools
// ---------------------------------------------------------------------------

// Everything a command needs from its surroundings, so the tests can give it a scratch repo and
// a fake `tool` instead of starting npm and cargo.
function defaultDeps() {
  return {
    root: ROOT,
    // Under npm run the working folder is the package root, wherever the person ran npm.
    cwd: process.env.INIT_CWD ?? process.cwd(),
    host: hostInfo(),
    nodeVersion: process.versions.node,
    tool: spawnTool,
    log: (line = "") => console.log(line),
    warn: (line) => console.warn(line),
    error: (line) => console.error(line),
  };
}

function hostInfo() {
  let glibc = null;
  if (process.platform === "linux") {
    // The prebuilt harness-core links the system's libc and libssl.so.3: it follows the distro.
    try {
      glibc = process.report.getReport().header.glibcVersionRuntime ?? null;
    } catch {
      glibc = null;
    }
  }
  return { platform: process.platform, arch: process.arch, glibc };
}

// Starts npm, cargo, rustc, git or node (a script run by this node) and waits for it. `mode` is
// where its output goes: "inherit" (the default) shows it, "capture" returns stdout as text and
// hides the rest, and "collect" returns stdout and stderr and shows nothing (cargo vendor writes
// a line per crate). Returns { status, signal, error, stdout, stderr }, like spawnSync.
export function spawnTool(name, args, { cwd, mode = "inherit" } = {}) {
  const start = toolInvocation(name, args);
  const stdio = mode === "capture" ? ["ignore", "pipe", "ignore"]
    : mode === "collect" ? ["ignore", "pipe", "pipe"]
    : ["ignore", "inherit", "inherit"];
  const result = spawnSync(start.command, start.args, {
    cwd,
    stdio,
    shell: start.shell,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // npm's "new version available" check is a network call, and no message from it is wanted here.
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  return { status: result.status, signal: result.signal, error: result.error, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function toolInvocation(name, args) {
  if (name === "npm") {
    return npmInvocation({ platform: process.platform, execPath: process.execPath, npmExecPath: process.env.npm_execpath }, args);
  }
  if (name === "node") return { command: process.execPath, args, shell: false };
  return { command: name, args, shell: false };
}

function succeeded(result) {
  return result.status === 0 && !result.error;
}

function describeFailure(result) {
  if (result.error) return `could not start: ${result.error.code ?? result.error.message}`;
  if (result.signal) return `stopped by ${result.signal}`;
  return `exit ${result.status}`;
}

// node is this process; the others answer --version (null when the tool is missing).
function detectToolchain(deps) {
  const versionOf = (tool) => {
    const result = deps.tool(tool, ["--version"], { mode: "capture" });
    return succeeded(result) ? parseVersion(result.stdout) : null;
  };
  return { node: deps.nodeVersion, npm: versionOf("npm"), cargo: versionOf("cargo"), rustc: versionOf("rustc") };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

// The bundle folder: <dir> as given (against the folder the command was run from), or offline-bundle in the repo root.
function bundleDirFor(deps, dirArg) {
  return dirArg === null ? join(deps.root, DEFAULT_BUNDLE_DIR) : resolve(deps.cwd, dirArg);
}

// The text of a file, or null when there is nothing to read there: no such path, a parent that is
// a file (ENOTDIR), or a folder where the file should be (EISDIR).
function readIfExists(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR") return null;
    throw error;
  }
}

// The size in bytes of the files under `dir`, and the length of the longest path below it
// (relative to `base`, the bundle folder).
function measureDir(dir, base = dir) {
  let bytes = 0;
  let longest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = measureDir(path, base);
      bytes += inner.bytes;
      longest = Math.max(longest, inner.longest);
    } else if (entry.isFile()) {
      bytes += lstatSync(path).size;
      longest = Math.max(longest, relative(base, path).length);
    }
  }
  return { bytes, longest };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export function runCreate(argv, deps) {
  const options = parseCreateArgs(argv);
  const { root, host, log, warn } = deps;
  const dir = bundleDirFor(deps, options.dir);
  const platformKey = `${host.platform}-${host.arch}`;

  // Everything that can refuse comes before the first change to the folder.
  refuseBundleDir(dir, root, options.force);
  requireSources(root);
  refuseOfflineCheckout(root);
  if (options.binaries && !existsSync(join(root, "node_modules"))) {
    throw new UserError("node_modules is missing, and the binaries are built from it. Run npm ci first, or make the bundle without binaries (--no-binaries).");
  }
  const toolchain = detectToolchain(deps);
  for (const tool of ["npm", "cargo", "rustc"]) {
    if (toolchain[tool] === null) {
      throw new UserError(`${tool} was not found on the PATH. create needs Node, npm, and Rust (cargo and rustc).`);
    }
  }
  startBundleDir(dir);
  // Before the bundle exists the longest path inside it is an estimate; the measured one follows.
  const early = longPathWarning(dir, host.platform);
  if (early) warn(`Warning: ${early}`);

  const npm = addNpmPackages(deps, dir);
  const cargoCrateCount = vendorCrates(deps, dir);
  const binaries = options.binaries ? buildBinaries(deps, dir) : [];

  const { bytes, longest } = measureDir(dir);
  const manifest = {
    formatVersion: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    gitCommit: gitCommit(deps),
    sha256: hashLockedFiles(root),
    toolchain,
    platform: host.platform,
    arch: host.arch,
    glibc: host.platform === "linux" ? host.glibc : null,
    npmTarballs: npm.tarballs,
    // The tarballs whose content is in the cache by its digest, checked without npm: every OS's
    // optional packages count. npm ci --offline installs only this platform's.
    npmDigestsPresent: npm.digests,
    npmInstallCheckedOn: platformKey,
    cargoCrates: cargoCrateCount,
    longestPathLength: longest,
    binaries,
  };
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(join(dir, "MANIFEST.json"), manifestText);
  const late = early ? null : longPathWarning(dir, host.platform, longest);
  if (late) warn(`Warning: ${late}`);

  log("");
  log(`Offline bundle ready: ${dir}`);
  log(`  size          ${formatBytes(bytes + Buffer.byteLength(manifestText))}`);
  log(`  npm packages  ${npm.tarballs} tarballs, ${npm.digests} found in the cache by digest (every OS); npm ci --offline worked for ${platformKey}`);
  log(`  rust crates   ${cargoCrateCount}`);
  log(`  binaries      ${binaries.length > 0 ? `${platformKey}: ${binaries.map((file) => basename(file.path)).join(", ")}` : "none"}`);
  log("");
  log("Next steps:");
  log(`  1. Copy the folder ${dir} and the repo source (a clone or an archive; no node_modules) to the offline machine.`);
  log(`     Put the folder at ${DEFAULT_BUNDLE_DIR} in the repo root there, or give its path to setup.`);
  log("     The source must have the same dependencies: setup refuses a bundle made for other ones (package.json's dependency fields, package-lock.json, src-tauri/Cargo.lock).");
  log("  2. There, from the repo root:  npm run offline:setup      (another folder: npm run offline:setup -- <folder>)");
  log("  3. Then:                       npm run offline:verify     (without the Tauri system libraries: npm run offline:verify -- --skip cargo-app)");
  log(`  Made with node ${toolchain.node}, npm ${toolchain.npm}, cargo ${toolchain.cargo}, rustc ${toolchain.rustc}: setup warns when the offline machine differs (rustc matters most: the crates state a minimum).`);
  return 0;
}

// Refuses a folder that already holds files, unless it is a bundle this script made and --force
// says to replace it: two bundles must not be mixed, and --force must not clear anything else.
function refuseBundleDir(dir, root, force) {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) {
    throw new UserError(`${dir} is a file, not a folder. Give create a folder that is new or empty.`);
  }
  if (readdirSync(dir).length === 0) return;
  if (!isBundleFolder(dir)) {
    throw new UserError(
      `${dir} is not empty, and is not a bundle made by this script; choose an empty folder or a new one. --force replaces only a bundle this script made.`,
    );
  }
  if (!force) {
    throw new UserError(
      `${dir} is not empty: it holds a bundle. A new bundle must not be mixed with an old one: give create a new or empty folder, or add --force to replace it (${REPLACED_PARTS.join(", ")} are removed and made again; the npm cache is kept).`,
    );
  }
  if (isInsideDir(realpathSync(dir), realpathSync(root))) {
    throw new UserError(`--force will not clear ${dir}: it is the repository, or a folder that contains it. Use a folder of its own, such as ${DEFAULT_BUNDLE_DIR}.`);
  }
}

// Makes the folder ready. The sentinel goes in first, so that a create that stops halfway leaves a
// folder --force knows it may replace. --force then removes what an earlier create made, except the
// npm cache: it is addressed by content and safe to reuse, and a retry over a bad connection should
// not start from zero (the digest check catches any gap).
function startBundleDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, BUNDLE_SENTINEL), BUNDLE_SENTINEL_TEXT);
  } catch (error) {
    throw new UserError(`Cannot make the bundle folder ${dir} (${error.code ?? error.message}). Choose a folder you can write to.`);
  }
  for (const part of REPLACED_PARTS) rmSync(join(dir, part), { recursive: true, force: true });
}

function requireSources(root) {
  for (const { file } of LOCKED) {
    if (!existsSync(join(root, ...file.split("/")))) {
      throw new UserError(`${file} was not found in ${root}. Run this from a complete checkout of the repository.`);
    }
  }
}

// After setup, cargo reads the vendored crates instead of crates.io: a bundle made now would
// come from the old bundle, not from the registry.
function refuseOfflineCheckout(root) {
  const config = readIfExists(join(root, ".cargo", "config.toml"));
  if (config !== null && cargoConfigAction(config) === "replace") {
    throw new UserError("This checkout is set up for offline builds (.cargo/config.toml was written by setup). Delete that file, then run create again on a machine with internet access.");
  }
}

// Puts every npm tarball the lockfile pins into <dir>/npm-cache, checks that the content of each
// one is there (by its digest, for every OS), then proves that npm ci works from it, offline, on
// this machine. Returns the number of tarballs, and how many of them the digest check could see.
function addNpmPackages(deps, dir) {
  const { root, log, warn } = deps;
  const lock = readJson(join(root, "package-lock.json"));
  const { packages, skipped } = lockedPackages(lock);
  if (skipped.length > 0) {
    warn(`Warning: ${skipped.length} package${skipped.length === 1 ? "" : "s"} in package-lock.json ${skipped.length === 1 ? "has" : "have"} no resolved URL or no integrity hash, so ${skipped.length === 1 ? "it is" : "they are"} left out of the bundle and npm ci --offline may fail for ${skipped.length === 1 ? "it" : "them"}: ${describeList(skipped, 5)}.`);
  }
  const cache = join(dir, "npm-cache");
  mkdirSync(cache, { recursive: true });
  const groups = batches(packages.map((item) => item.resolved));
  log(`npm cache: adding ${packages.length} packages in ${groups.length} batches ...`);
  groups.forEach((group, index) => {
    log(`npm cache: batch ${index + 1} of ${groups.length} (${group.length} packages)`);
    const result = deps.tool("npm", ["cache", "add", ...group, "--cache", cache], { cwd: root });
    if (!succeeded(result)) {
      throw new UserError(`npm cache add failed (${describeFailure(result)}) in batch ${index + 1} of ${groups.length}. Either the connection to the npm registry failed, or a URL in package-lock.json is wrong or gone (npm's message above says which). Fix that, then run create again with --force: the npm cache is kept, so what was fetched is not fetched again.`);
    }
  });
  const { missing, unchecked } = missingFromNpmCache(cache, packages);
  if (missing.length > 0) {
    // The check reads npm's cache layout (_cacache/content-v2/sha512). If it names every package, this npm may keep its cache another way.
    const layout = missing.length === packages.length && packages.length > 1 ? " It names every package: this npm may keep its cache in a layout the check does not know (it reads _cacache/content-v2/sha512)." : "";
    throw new UserError(`npm cache add finished, but the cache does not hold what package-lock.json pins for ${missing.length} package${missing.length === 1 ? "" : "s"}: ${describeList(missing)}. The registry may have served other files than the lockfile names, or a download was cut short. Run create again with --force (what is cached is kept); if it happens again, run npm ci online to see what npm says.${layout}`);
  }
  if (unchecked.length > 0) {
    warn(`Warning: ${unchecked.length} package${unchecked.length === 1 ? "" : "s"} in package-lock.json ${unchecked.length === 1 ? "has" : "have"} no sha512 integrity hash, so the digest check cannot see ${unchecked.length === 1 ? "it" : "them"}; only the npm ci --offline check on this platform covers ${unchecked.length === 1 ? "it" : "them"}: ${describeList(unchecked, 5)}.`);
  }
  checkNpmCache(deps, cache);
  // npm's logs hold this machine's paths, and are of no use to anyone else.
  rmSync(join(cache, "_logs"), { recursive: true, force: true });
  return { tarballs: packages.length, digests: packages.length - unchecked.length };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UserError(`${path} could not be read as JSON (${error.message}).`);
  }
}

// npm ci --offline from the cache, in a scratch folder that holds only the two npm files.
function checkNpmCache(deps, cache) {
  const scratch = mkdtempSync(join(tmpdir(), "offline-bundle-npm-"));
  try {
    for (const name of ["package.json", "package-lock.json"]) copyFileSync(join(deps.root, name), join(scratch, name));
    deps.log("npm cache: checking that npm ci --offline works from it ...");
    const result = deps.tool("npm", ["ci", "--offline", "--ignore-scripts", "--cache", cache, "--no-audit", "--no-fund"], { cwd: scratch });
    if (!succeeded(result)) {
      throw new UserError(`npm ci --offline failed (${describeFailure(result)}) on the new npm cache, so the bundle would not install. Read npm's message above (package.json and package-lock.json must agree: run npm ci online to see), then run create again with --force.`);
    }
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      deps.warn(`Warning: could not remove the scratch folder ${scratch}; delete it yourself.`);
    }
  }
}

// cargo vendor --locked: the crates of every platform, exactly as Cargo.lock pins them. Never
// without --locked: a bundle from a lock file that cargo would change is not the source's bundle.
function vendorCrates(deps, dir) {
  const { root, log, warn } = deps;
  const vendor = join(dir, "cargo-vendor");
  log("cargo: vendoring the crates (cargo vendor --locked); this downloads them, which can take a few minutes ...");
  const result = deps.tool("cargo", ["vendor", "--locked", "--manifest-path", CARGO_MANIFEST, vendor], { cwd: root, mode: "collect" });
  if (!succeeded(result)) {
    // cargo's own message is in the last lines, after a line per crate.
    if (result.stderr) deps.error(result.stderr.trim().split(/\r?\n/).slice(-20).join("\n"));
    throw new UserError(`cargo vendor --locked failed (${describeFailure(result)}). If cargo says the lock file needs to be updated, src-tauri/Cargo.lock is stale: update it (for example cargo check --manifest-path ${CARGO_MANIFEST}), commit it, and run create again. Do not vendor without --locked.`);
  }
  const crates = readdirSync(vendor, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  const locked = countLockedCrates(readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8"));
  if (crates !== locked) {
    warn(`Warning: ${crates} crates were vendored, but src-tauri/Cargo.lock names ${locked} from crates.io. Check cargo's output above before shipping this bundle.`);
  }
  return crates;
}

// Builds harness-run.mjs and harness-core and copies them to <dir>/bin/<platform>-<arch>/.
// Returns the manifest's list: each file's path (with "/", relative to <dir>) and sha256.
function buildBinaries(deps, dir) {
  const { root, host, log } = deps;
  for (const script of ["build:cli", "build:core"]) {
    log(`binaries: npm run ${script} ...`);
    const result = deps.tool("npm", ["run", script], { cwd: root });
    if (!succeeded(result)) {
      throw new UserError(`npm run ${script} failed (${describeFailure(result)}). Fix the build above, or make the bundle without binaries (--no-binaries): the offline machine can build them itself.`);
    }
  }
  const exe = host.platform === "win32" ? ".exe" : "";
  const files = [
    { from: join(root, "cli", "dist", "harness-run.mjs"), name: "harness-run.mjs" },
    { from: join(root, "src-tauri", "target", "release", `harness-core${exe}`), name: `harness-core${exe}` },
  ];
  const key = `${host.platform}-${host.arch}`;
  mkdirSync(join(dir, "bin", key), { recursive: true });
  return files.map(({ from, name }) => {
    if (!existsSync(from)) {
      throw new UserError(`${from} was not found after the build. If CARGO_TARGET_DIR is set, unset it: harness run looks for harness-core in src-tauri/target/release.`);
    }
    const copy = join(dir, "bin", key, name);
    copyFileSync(from, copy);
    return { path: `bin/${key}/${name}`, sha256: sha256File(copy) };
  });
}

function gitCommit(deps) {
  const result = deps.tool("git", ["rev-parse", "HEAD"], { cwd: deps.root, mode: "capture" });
  const commit = succeeded(result) ? result.stdout.trim() : "";
  return /^[0-9a-f]{40}$/.test(commit) ? commit : null;
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

// Where each prebuilt file goes in the repo (the places harness run looks in), by its name, and
// whether it is a program (executable on Unix) or a script node runs.
const BINARY_HOMES = new Map([
  ["harness-run.mjs", { dir: ["cli", "dist"], program: false }],
  ["harness-core", { dir: ["src-tauri", "target", "release"], program: true }],
  ["harness-core.exe", { dir: ["src-tauri", "target", "release"], program: true }],
]);

export function runSetup(argv, deps) {
  const { dir: dirArg } = parseSetupArgs(argv);
  const { root, log, warn } = deps;
  const dir = bundleDirFor(deps, dirArg);

  const manifestPath = join(dir, "MANIFEST.json");
  const manifestText = readIfExists(manifestPath);
  if (manifestText === null) {
    throw new UserError(`${manifestPath} was not found. ${dir} is not an offline bundle, or create did not finish: give setup the bundle's folder, or make the bundle again.`);
  }
  const manifest = parseManifest(manifestText, manifestPath);

  // 1. The bundle must have been made for this source, and be all there.
  const different = hashMismatches(manifest.sha256, hashLockedFiles(root));
  if (different.length > 0) throw new UserError(mismatchMessage(different, manifest));
  for (const part of ["npm-cache", "cargo-vendor"]) {
    if (!existsSync(join(dir, part))) throw new UserError(`${join(dir, part)} is missing, so the bundle is incomplete. Copy it again from the machine that made it.`);
  }
  // The content of every npm package the lockfile pins, for every OS: a damaged copy of the folder
  // shows here, not as a failure of npm ci half way.
  const { packages } = lockedPackages(readJson(join(root, "package-lock.json")));
  const { missing, unchecked } = missingFromNpmCache(join(dir, "npm-cache"), packages);
  if (missing.length > 0) {
    throw new UserError(`The bundle's npm cache is missing the content of ${missing.length} package${missing.length === 1 ? "" : "s"}: ${describeList(missing)}. The copy of the bundle is damaged or incomplete: copy the folder again from the machine that made it.`);
  }
  log(`npm cache: the content of ${packages.length - unchecked.length} packages is there (every OS)`);

  // Everything that can refuse comes before the first change.
  const vendorDir = join(dir, "cargo-vendor");
  const configText = cargoConfigText(vendorDir);
  const configPath = join(root, ".cargo", "config.toml");
  if (cargoConfigAction(readIfExists(configPath)) === "refuse") {
    // Only the settings: the marker line would make a file that has it look like this script's own.
    const settings = configText.slice(configText.indexOf("[source.crates-io]")).trimEnd();
    throw new UserError(
      `${configPath} exists and was not written by this script, so it is left alone. Move it away and run setup again, or add these settings to it yourself:\n\n${settings}`,
    );
  }

  // 2. A different toolchain is a warning, not a refusal, and so is a path Windows may not take.
  for (const text of toolchainWarnings(manifest.toolchain, detectToolchain(deps))) warn(`Warning: ${text}`);
  const longPath = longPathWarning(dir, deps.host.platform, manifest.longestPathLength);
  if (longPath) warn(`Warning: ${longPath}`);

  // 3. node_modules from the bundle's npm cache. Nothing is written before this works: a failed
  // npm ci must not leave the repo with the network turned off and no word about why.
  log("npm: npm ci --offline ...");
  const result = deps.tool("npm", ["ci", "--offline", "--cache", join(dir, "npm-cache"), "--no-audit", "--no-fund"], { cwd: root });
  if (!succeeded(result)) {
    throw new UserError(`npm ci --offline failed (${describeFailure(result)}), and .cargo/config.toml was not written. Read npm's message above: it says what npm cannot find or use. If the copy of the bundle may be damaged, copy the folder again from the machine that made it.`);
  }

  // 4. Cargo reads the vendored crates and stays offline.
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, configText);
  } catch (error) {
    throw new UserError(`Cannot write ${configPath} (${error.code ?? error.message}). node_modules is installed; make .cargo/config.toml writable and run setup again.`);
  }
  log(`cargo: wrote ${configPath}`);

  // 5. The prebuilt binaries for this OS.
  const binaries = installBinaries(manifest, dir, deps);

  // 6. What was done.
  log("");
  log("Offline setup done.");
  log(`  cargo     ${configPath} uses ${vendorDir} and turns the network off`);
  log(`  npm       node_modules installed from ${join(dir, "npm-cache")}`);
  for (const line of binaries) log(`  binaries  ${line}`);
  log("");
  log("Next: npm run offline:verify   (without the Tauri system libraries: npm run offline:verify -- --skip cargo-app)");
  log("Back online: delete .cargo/config.toml. If you move the bundle folder, run setup again: the config holds its absolute path.");
  return 0;
}

// Copies the bundle's binaries for this platform-arch to where harness run looks, unless a file is
// already there, after checking each against the manifest's sha256. Returns lines to report.
function installBinaries(manifest, dir, deps) {
  const { root, host } = deps;
  const key = `${host.platform}-${host.arch}`;
  const prefix = `bin/${key}/`;
  const listed = (Array.isArray(manifest.binaries) ? manifest.binaries : []).filter((entry) => typeof entry?.path === "string");
  const entries = listed.filter((entry) => entry.path.startsWith(prefix) && BINARY_HOMES.has(entry.path.slice(prefix.length)));
  if (entries.length === 0) {
    const others = [...new Set(listed.map((entry) => entry.path.split("/")[1]))];
    return [`none for ${key} in this bundle${others.length > 0 ? ` (it has ${others.join(", ")})` : ""}; build them with npm run build:cli and npm run build:core (verify does)`];
  }
  if (host.platform === "linux") {
    const warning = glibcWarning(manifest.glibc, host.glibc);
    if (warning) deps.warn(`Warning: ${warning}`);
  }
  return entries.map((entry) => {
    const name = entry.path.slice(prefix.length);
    const home = BINARY_HOMES.get(name);
    const target = join(root, ...home.dir, name);
    const shown = relative(root, target);
    if (existsSync(target)) return `kept ${shown}, already there`;
    const source = join(dir, ...entry.path.split("/"));
    if (!existsSync(source) || sha256File(source) !== entry.sha256) {
      throw new UserError(`${source} is missing or does not match its sha256 in MANIFEST.json, so the bundle is damaged. Copy it again from the machine that made it.`);
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    if (home.program && host.platform !== "win32") chmodSync(target, 0o755);
    return `installed ${shown}`;
  });
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

// The steps, in order. `command` gives the tool and its arguments, or throws a UserError when it
// cannot be found. The three node tools run from node_modules through node, as npx would but
// without npx: no shell (npx.cmd needs one on Windows) and no try at downloading a missing package.
const VERIFY_STEPS = [
  { name: "tsc", command: (root) => localBin(root, "typescript", "tsc", ["--noEmit"]) },
  { name: "vitest", command: (root) => localBin(root, "vitest", "vitest", ["run"]) },
  { name: "cargo-core", command: () => ({ tool: "cargo", args: ["test", "--manifest-path", CARGO_MANIFEST, "--no-default-features", "--features", "core"] }) },
  { name: "cargo-app", command: () => ({ tool: "cargo", args: ["test", "--manifest-path", CARGO_MANIFEST] }) },
  { name: "build-cli", command: () => ({ tool: "npm", args: ["run", "build:cli"] }) },
  { name: "build-core", command: () => ({ tool: "npm", args: ["run", "build:core"] }) },
  { name: "vite-build", command: (root) => localBin(root, "vite", "vite", ["build"]) },
];

function verifyStepNames() {
  return VERIFY_STEPS.map((step) => step.name);
}

// The command `bin` of the installed package `pkg`, started by node.
function localBin(root, pkg, bin, args) {
  const pkgDir = join(root, "node_modules", pkg);
  let declared;
  try {
    declared = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).bin;
  } catch {
    throw new UserError(`${pkg} is not installed in node_modules. Run npm run offline:setup (or npm ci) first.`);
  }
  const entry = typeof declared === "string" ? declared : declared?.[bin];
  if (!entry) throw new UserError(`node_modules/${pkg} has no "${bin}" command. Run npm run offline:setup (or npm ci) again.`);
  return { tool: "node", args: [join(pkgDir, entry), ...args] };
}

export function runVerify(argv, deps) {
  const { skip } = parseVerifyArgs(argv, verifyStepNames());
  const { log } = deps;
  const results = [];
  for (const step of VERIFY_STEPS) {
    if (skip.has(step.name)) {
      results.push({ name: step.name, result: "skipped", exit: "-", time: "-", note: "" });
      continue;
    }
    log("");
    log(`=== ${step.name} ===`);
    const started = Date.now();
    const outcome = runStep(step, deps);
    const time = `${((Date.now() - started) / 1000).toFixed(1)}s`;
    results.push({ name: step.name, result: outcome.passed ? "PASS" : "FAIL", exit: outcome.exit, time, note: outcome.note });
  }

  const failed = results.filter((row) => row.result === "FAIL");
  log("");
  for (const line of formatTable(["step", "result", "exit", "time"], results.map((row) => [row.name, row.result, row.exit, row.time]))) log(line);
  for (const row of failed) if (row.note) log(`${row.name}: ${row.note}`);
  log("");
  const skipped = results.filter((row) => row.result === "skipped").length;
  const skippedNote = skipped > 0 ? ` (${skipped} skipped)` : "";
  log(failed.length === 0
    ? `verify: every step that ran passed${skippedNote}.`
    : `verify: ${failed.length} of ${results.length} steps failed: ${failed.map((row) => row.name).join(", ")}${skippedNote}.`);
  return failed.length === 0 ? 0 : 1;
}

// Runs one step with its output shown. Returns whether it passed, its exit status for the table
// ("-" when there is none), and a note for a step that failed without an exit status.
function runStep(step, deps) {
  let command;
  try {
    command = step.command(deps.root);
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    deps.error(error.message);
    return { passed: false, exit: "-", note: "not run (see above)" };
  }
  deps.log([command.tool, ...command.args.map((arg) => (isAbsolute(arg) && isInsideDir(deps.root, arg) ? relative(deps.root, arg) : arg))].join(" "));
  const result = deps.tool(command.tool, command.args, { cwd: deps.root });
  return {
    passed: succeeded(result),
    exit: result.status === null || result.status === undefined ? "-" : String(result.status),
    note: result.error || result.signal ? describeFailure(result) : "",
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Returns the exit code: 0 when the command did what it was asked, 1 when not.
export function main(argv, deps = defaultDeps()) {
  const [command, ...rest] = argv;
  try {
    if (command === "--help" || command === "-h" || command === "help" || rest.includes("--help") || rest.includes("-h")) {
      deps.log(usageText());
      return 0;
    }
    if (command === "create") return runCreate(rest, deps);
    if (command === "setup") return runSetup(rest, deps);
    if (command === "verify") return runVerify(rest, deps);
    deps.error(usageText());
    return 1;
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    deps.error(`offline-bundle: ${error.message}`);
    return 1;
  }
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = main(process.argv.slice(2));
