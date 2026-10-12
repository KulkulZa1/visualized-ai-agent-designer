// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { configDiff, configFromJson, DEFAULT_CONFIG, type EvolveConfig } from "@/evolve/config";

function configOf(raw: unknown, overrides: Partial<EvolveConfig> = {}): EvolveConfig {
  const result = configFromJson(raw, overrides);
  if ("error" in result) throw new Error(`expected a config, got the error: ${result.error}`);
  return result.config;
}

function errorOf(raw: unknown, overrides: Partial<EvolveConfig> = {}): string {
  const result = configFromJson(raw, overrides);
  if ("config" in result) throw new Error(`expected an error, got a config: ${JSON.stringify(result.config)}`);
  return result.error;
}

/** The error has a line that starts with `key:`, the way a bound's error names its key. */
const namesKey = (error: string, key: string) => new RegExp(`(^|\\n)${key}:`).test(error);

describe("DEFAULT_CONFIG", () => {
  it("holds the spec's §1 table", () => {
    expect(DEFAULT_CONFIG).toEqual({
      T: 20, k: 2, m: 2, b_min: 1, b_max: 4, w: 3, m_draft: 1, delta: null, delta_z: 2.0, calibrate: 1,
      beta0: 0.1, beta1: 40, w_s: 100, w_c: 15, w_n: 0.5, n_prune: 4, repair_rounds: 2, invalid_missing_frac: 0.15,
      n_fail_traces: 4, n_success_traces: 2,
    });
  });

  it("cannot be changed by accident", () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
  });

  it("is what an empty file gives, as a copy of its own", () => {
    const config = configOf({});

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config).not.toBe(DEFAULT_CONFIG);
    config.T = 5; // the copy is the caller's
    expect(DEFAULT_CONFIG.T).toBe(20);
  });

  it("is valid under its own bounds", () => {
    expect(configOf({ ...DEFAULT_CONFIG })).toEqual(DEFAULT_CONFIG);
  });
});

describe("configFromJson: rrsi's test_config_roundtrip, adapted", () => {
  it("takes the file's keys, lets the overrides win, and ignores an override of undefined", () => {
    // rrsi: RRSIConfig.load(path, T=None, k=5) with the file {"T": 7, "k": 3, "beta1": 12.5}.
    const config = configOf({ T: 7, k: 3, beta1: 12.5 }, { T: undefined, k: 5 });

    expect(config.T).toBe(7);
    expect(config.k).toBe(5);
    expect(config.beta1).toBe(12.5);
    expect(config.beta0).toBe(DEFAULT_CONFIG.beta0);
  });

  it("refuses an unknown key where rrsi keeps it in notes, and names it", () => {
    // rrsi: the file also has "custom": "x", which load() keeps in cfg.notes.
    const error = errorOf({ T: 7, k: 3, beta1: 12.5, custom: "x" });

    expect(error).toContain("custom");
  });

  it("names each unknown key", () => {
    const error = errorOf({ T: 7, bogus: 1, notes: {}, b_mim: 2 });

    for (const key of ["bogus", "notes", "b_mim"]) expect(error).toContain(`"${key}"`);
  });

  it("refuses a key the schema does not know even when it comes from the overrides", () => {
    expect(errorOf({}, { bogus: 1 } as unknown as Partial<EvolveConfig>)).toContain("bogus");
  });

  it("round-trips through JSON: a config written out and read back is the same", () => {
    const config = configOf({ T: 7, m: 3, m_draft: 2, delta: 0.125, beta1: 12.5, w_n: 0 });

    expect(configOf(JSON.parse(JSON.stringify(config)))).toEqual(config);
  });

  it("gives the keys in the config's own order, whatever the order in the file", () => {
    const config = configOf({ n_success_traces: 1, T: 3, beta0: 0.2 });

    expect(Object.keys(config)).toEqual(Object.keys(DEFAULT_CONFIG));
  });

  it("refuses a file that is not a JSON object", () => {
    for (const raw of [null, undefined, [], [{ T: 5 }], "T: 5", 5, true]) expect(errorOf(raw)).toContain("JSON object");
  });
});

describe("configFromJson: the overrides", () => {
  it("apply over the file, which applies over the defaults", () => {
    const config = configOf({ T: 7, k: 3, w: 5 }, { k: 4, m: 3 });

    expect(config).toEqual({ ...DEFAULT_CONFIG, T: 7, k: 4, w: 5, m: 3 });
  });

  it("apply with no file at all", () => {
    expect(configOf({}, { T: 9, delta: 0.1 })).toEqual({ ...DEFAULT_CONFIG, T: 9, delta: 0.1 });
  });

  it("ignore every key that is undefined, so a flag that was not given changes nothing", () => {
    const flags: Partial<EvolveConfig> = { T: undefined, k: undefined, m: undefined, delta: undefined, calibrate: undefined };

    expect(configOf({ T: 7, delta: 0.3 }, flags)).toEqual({ ...DEFAULT_CONFIG, T: 7, delta: 0.3 });
  });

  it("do not ignore null: delta null is the file's delta taken back", () => {
    expect(configOf({ delta: 0.3 }, { delta: null }).delta).toBeNull();
  });

  it("are held to the same bounds as the file", () => {
    expect(namesKey(errorOf({}, { T: 0 }), "T")).toBe(true);
    expect(namesKey(errorOf({ T: 5 }, { k: 1001 }), "k")).toBe(true);
  });
});

// Each key's valid edges and some values just outside. Every other key is at its default, so a value must be valid with those.
const ACCEPTED: Array<[keyof EvolveConfig, unknown[]]> = [
  ["T", [1, 1000]], ["k", [1, 1000]], ["m", [1, 8]], ["b_min", [1, 4]], ["b_max", [1, 4, 20]], ["w", [1, 50]], ["m_draft", [0, 2]],
  ["delta", [null, 0, 0.25]], ["delta_z", [0.001, 2, 10]], ["calibrate", [1, 2, 100]],
  ["beta0", [-3, 0, 7.5]], ["beta1", [-3, 0, 7.5]], ["w_s", [-3, 0, 7.5]], ["w_c", [-3, 0, 7.5]], ["w_n", [-3, 0, 7.5]],
  ["n_prune", [0, 9]], ["repair_rounds", [0, 10]], ["invalid_missing_frac", [0, 0.5, 1]], ["n_fail_traces", [0, 50]], ["n_success_traces", [0, 50]],
];
const REJECTED: Array<[keyof EvolveConfig, unknown[]]> = [
  ["T", [0, -1, 1001, 2.5, "20", null]], ["k", [0, 1001, 1.5, "2"]], ["m", [0, 9, 2.5]], ["b_min", [0, -1, 1.5]], ["b_max", [0, 21, 2.5]],
  ["w", [0, -2, 1.5]], ["m_draft", [-1, 1.5]], ["delta", [-0.01, "0.1", Number.NaN]], ["delta_z", [0, -1, Number.NaN]],
  ["calibrate", [0, 101, 1.5]],
  ["beta0", [Infinity, -Infinity, Number.NaN, "1"]], ["beta1", [Infinity, -Infinity, Number.NaN]], ["w_s", [Infinity, Number.NaN]],
  ["w_c", [-Infinity, Number.NaN]], ["w_n", [Infinity, Number.NaN, null]],
  ["n_prune", [-1, 1.5]], ["repair_rounds", [-1, 11, 0.5]], ["invalid_missing_frac", [-0.1, 1.1, Number.NaN]],
  ["n_fail_traces", [-1, 51, 1.5]], ["n_success_traces", [-1, 51, 1.5]],
];

describe("configFromJson: the bounds", () => {
  it("covers every key of the config, both ways", () => {
    expect(ACCEPTED.map(([key]) => key)).toEqual(Object.keys(DEFAULT_CONFIG));
    expect(REJECTED.map(([key]) => key)).toEqual(Object.keys(DEFAULT_CONFIG));
  });

  for (const [key, values] of ACCEPTED) {
    it(`accepts ${key} = ${values.map((v) => JSON.stringify(v)).join(", ")}`, () => {
      for (const value of values) expect(configOf({ [key]: value })[key]).toBe(value);
    });
  }

  for (const [key, values] of REJECTED) {
    it(`refuses ${key} = ${values.map(String).join(", ")}, naming the key`, () => {
      for (const value of values) {
        const error = errorOf({ [key]: value });
        expect(namesKey(error, key), `${key} = ${String(value)} gave: ${error}`).toBe(true);
      }
    });
  }

  it("takes the bounds from the file and from an override alike", () => {
    for (const [key, values] of REJECTED) {
      for (const value of values) {
        if (value === null) continue; // an override of null is only for delta
        expect(namesKey(errorOf({}, { [key]: value } as Partial<EvolveConfig>), key)).toBe(true);
      }
    }
  });

  it("reports every key that is out of bounds, one per line", () => {
    const error = errorOf({ T: 0, k: 5000, beta0: Infinity });

    expect(error.split("\n")).toHaveLength(3);
    for (const key of ["T", "k", "beta0"]) expect(namesKey(error, key)).toBe(true);
  });
});

describe("configFromJson: the checks across keys", () => {
  it("refuses b_min above b_max, naming both", () => {
    const error = errorOf({ b_min: 5 }); // b_max is 4

    expect(error).toContain("b_min");
    expect(error).toContain("b_max");
    expect(error).toContain("5");
    expect(error).toContain("4");
  });

  it("refuses m_draft above m, naming both", () => {
    const error = errorOf({ m_draft: 3 }); // m is 2

    expect(error).toContain("m_draft");
    expect(error).toContain(" m ");
  });

  it("accepts the keys equal, and m_draft 0", () => {
    expect(configOf({ b_min: 3, b_max: 3 })).toMatchObject({ b_min: 3, b_max: 3 });
    expect(configOf({ m: 1, m_draft: 1 })).toMatchObject({ m: 1, m_draft: 1 });
    expect(configOf({ m_draft: 0 }).m_draft).toBe(0);
  });

  it("checks after the overrides: an override can break an agreement in the file", () => {
    expect(errorOf({ b_max: 2 }, { b_min: 3 })).toContain("b_min");
    expect(errorOf({ m: 2, m_draft: 2 }, { m: 1 })).toContain("m_draft");
    expect(errorOf({ b_min: 2, b_max: 2 }, { b_max: 1 })).toContain("b_max");
  });

  it("checks after the overrides: an override can repair a disagreement in the file", () => {
    expect(configOf({ b_min: 5 }, { b_max: 8 })).toMatchObject({ b_min: 5, b_max: 8 });
    expect(configOf({ m_draft: 3 }, { m: 4 })).toMatchObject({ m: 4, m_draft: 3 });
    expect(configOf({ b_max: 2 }, { b_min: 2 })).toMatchObject({ b_min: 2, b_max: 2 });
  });

  it("checks against the defaults of the keys that are not given", () => {
    expect(errorOf({}, { b_min: 5 })).toContain("b_max"); // b_max is 4
    expect(errorOf({}, { m_draft: 3 })).toContain("m_draft"); // m is 2
    expect(configOf({}, { b_max: 1 })).toMatchObject({ b_min: 1, b_max: 1 });
  });

  it("reports both disagreements when there are two", () => {
    const error = errorOf({ b_min: 5, m_draft: 3 });

    expect(error).toContain("b_min");
    expect(error).toContain("m_draft");
    expect(error.split("\n")).toHaveLength(2);
  });
});

describe("configDiff", () => {
  it("lists nothing for equal configs", () => {
    expect(configDiff(DEFAULT_CONFIG, { ...DEFAULT_CONFIG })).toEqual([]);
  });

  it("lists the keys whose values differ, in the config's order", () => {
    const changed: EvolveConfig = { ...DEFAULT_CONFIG, n_prune: 9, beta1: 12.5, T: 30 };

    expect(configDiff(DEFAULT_CONFIG, changed)).toEqual(["T", "beta1", "n_prune"]);
    expect(configDiff(changed, DEFAULT_CONFIG)).toEqual(["T", "beta1", "n_prune"]);
  });

  it("tells null from a number in delta", () => {
    expect(configDiff(DEFAULT_CONFIG, { ...DEFAULT_CONFIG, delta: 0 })).toEqual(["delta"]);
    expect(configDiff({ ...DEFAULT_CONFIG, delta: 0.1 }, { ...DEFAULT_CONFIG, delta: 0.1 })).toEqual([]);
  });

  it("lists a key an older pin does not have", () => {
    const older: Record<string, unknown> = { ...DEFAULT_CONFIG };
    delete older.calibrate;

    expect(configDiff(older as unknown as EvolveConfig, DEFAULT_CONFIG)).toEqual(["calibrate"]);
  });
});
