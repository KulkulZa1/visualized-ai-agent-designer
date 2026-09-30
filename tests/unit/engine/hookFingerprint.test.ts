import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { hookFingerprint } from "../../fixtures/hookFingerprint.mjs";

/**
 * The tests' fakes (fake-core.mjs, the engine tests' fake host) answer hook_fingerprint with
 * tests/fixtures/hookFingerprint.mjs. It must be the fingerprint harness-core computes, or they
 * agree with each other and not with the engine's real backend. So the values here are the ones
 * the Rust test `the_hook_fingerprint_encoding_is_pinned` (src-tauri/src/commands/process_commands.rs)
 * pins for `fingerprint_hook`, which were computed outside that code (Python's hashlib, and
 * sha256sum). If either encoding changes, one of the two tests fails.
 */
describe("the hook fingerprint the tests' fakes compute", () => {
  /** Bytes of a string whose characters are all below U+0100, one byte each. */
  const bytes = (latin1: string) => Uint8Array.from(latin1, (c) => c.charCodeAt(0));

  it("is the Rust vector (a): the script `echo hi` and the env B=2, A=1, given in that order", () => {
    expect(hookFingerprint("echo hi\n", { B: "2", A: "1" }))
      .toBe("c664d4fa5a1f7d70399717222711718d0d5cce35df2dc5f3eb3b0c04aecf7122");
  });

  it("is the Rust vector (b): the same script with no env, or an empty one", () => {
    const bare = "2a638062e79ca4ece22f381ec451ed077e00e6522931e27b6853afdfcae3b92c";

    expect(hookFingerprint("echo hi\n", undefined)).toBe(bare);
    expect(hookFingerprint("echo hi\n", {})).toBe(bare);
    expect(hookFingerprint("echo hi\n", null)).toBe(bare);
  });

  it("is the Rust vector (c): no bytes and no env", () => {
    expect(hookFingerprint("", undefined)).toBe("916fc571515d8f38c8a9f715cf797ff32bd361cefed15ba5a35cf58376a5dbcf");
    expect(hookFingerprint(new Uint8Array(), {})).toBe("916fc571515d8f38c8a9f715cf797ff32bd361cefed15ba5a35cf58376a5dbcf");
  });

  it("is the Rust vector (d): a script that is not UTF-8, and an env that needs every kind of JSON escaping", () => {
    const script = bytes("\xff\xfe#!/bin/sh\necho \xc3\x28\n"); // 0xFF, and a lead byte with no continuation
    const env = {
      Z: 'tab\there "quoted" back\\slash',
      "\u00e9": "caf\u00e9 \u2028 \u{1F600}",
      A: "line\nbreak \r\b\f \u0001 \u001b \u007f",
    };

    expect(hookFingerprint(script, env)).toBe("c1839de3f5d130be3e306b6fe107d8d7e6cfa3849c6e0137ca4bd9d62d253fe1");
  });

  it("is the Rust vector (e): env names that sort one way by code point and another by UTF-16 unit", () => {
    // U+FF5E is one UTF-16 unit (0xFF5E) and U+1F600 two (0xD83D 0xDE00): by unit the emoji would come first,
    // and the fingerprint would be 2a0e5b2d8f722ca007450a41d76519eed4866e76b49bd853167416b76ff0bc47.
    expect(hookFingerprint("x", { "\u{1F600}": "1", "\uFF5E": "2" }))
      .toBe("b93e80432a647b56eac82834a1c205482eb98c81acd1e6a524e11074aade4aa3");
  });

  it("hashes a string as its UTF-8 bytes", () => {
    expect(hookFingerprint("h\u00e9\n", undefined)).toBe(hookFingerprint(bytes("h\xc3\xa9\n"), undefined));
  });

  it("sorts the env's names by code point, as Rust does, not by UTF-16 unit as Array.sort does", () => {
    // U+FF5E is one UTF-16 unit (0xFF5E), U+1F600 two (0xD83D 0xDE00): sorted as UTF-16, the emoji would come first.
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const scriptHash = sha("x");
    const expected = sha(`harness-hook-fingerprint-v1\n${scriptHash}\n[["\uFF5E","2"],["\u{1F600}","1"]]`);

    expect(hookFingerprint("x", { "\u{1F600}": "1", "\uFF5E": "2" })).toBe(expected);
  });
});
