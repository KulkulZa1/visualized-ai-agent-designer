/**
 * The hook fingerprint as harness-core computes it, for the tests' fakes (fake-core.mjs, and
 * the engine tests' fake host). It mirrors `fingerprint_hook` in
 * src-tauri/src/commands/process_commands.rs, encoding version 1: the SHA-256, as lowercase
 * hex, of the UTF-8 text
 *
 *   harness-hook-fingerprint-v1 \n <hex SHA-256 of the script's bytes> \n <env as JSON>
 *
 * where the env is the JSON array of its [name, value] pairs sorted by name (by the UTF-8 bytes
 * of the name; no env and an empty one are both `[]`). JSON.stringify writes what serde_json
 * does: compact, non-ASCII as it is, and only `"`, `\` and the characters below U+0020 escaped.
 *
 * tests/unit/engine/hookFingerprint.test.ts pins this to the values the Rust tests pin, so that
 * a change to either encoding fails a test.
 */
import { createHash } from "node:crypto";

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const byUtf8 = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * @param {Uint8Array | string} script the script's bytes (a string is its UTF-8)
 * @param {Record<string, string> | null | undefined} env the hook's own env, as preHook.env
 * @returns {string}
 */
export function hookFingerprint(script, env) {
  const vars = env ?? {};
  const pairs = Object.keys(vars).sort(byUtf8).map((name) => [name, vars[name]]);
  return sha256Hex(`harness-hook-fingerprint-v1\n${sha256Hex(Buffer.from(script))}\n${JSON.stringify(pairs)}`);
}
