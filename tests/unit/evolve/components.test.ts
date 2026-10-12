// Ported from RRSI (Apache License 2.0) and changed: see src/evolve/NOTICE.md.
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isComponent, K, K_STR, mostStructural, novelty, PRECEDENCE } from "@/evolve/components";

describe("K, K_STR and PRECEDENCE", () => {
  it("lists the components of the spec's §2, in the order the exploration text uses", () => {
    expect(K).toEqual(["prompt", "config", "control_flow", "context_mgmt", "memory", "client_tool", "subagent"]);
  });

  it("has PRECEDENCE holding the same components as K, each once", () => {
    expect([...PRECEDENCE].sort()).toEqual([...K].sort());
    expect(new Set(PRECEDENCE).size).toBe(K.length);
  });

  it("orders PRECEDENCE from the most structural to the least", () => {
    expect(PRECEDENCE).toEqual(["subagent", "memory", "client_tool", "control_flow", "context_mgmt", "config", "prompt"]);
  });

  it("has the structural components in K, and they are the three that add machinery", () => {
    expect(K_STR).toEqual(["memory", "client_tool", "subagent"]);
    for (const c of K_STR) expect(K).toContain(c);
  });

  it("puts every structural component before every other in PRECEDENCE", () => {
    const firstOther = PRECEDENCE.findIndex((c) => !K_STR.includes(c));
    for (const c of K_STR) expect(PRECEDENCE.indexOf(c)).toBeLessThan(firstOther);
  });
});

describe("isComponent", () => {
  it("is true for the components of K only", () => {
    for (const c of K) expect(isComponent(c)).toBe(true);
    for (const x of ["skill", "output_plumbing", "Prompt", "", "constructor", "__proto__", null, undefined, 3, ["prompt"]]) {
      expect(isComponent(x)).toBe(false);
    }
  });
});

describe("mostStructural", () => {
  it("gives the first of PRECEDENCE that is in the list, whatever the order of the list", () => {
    expect(mostStructural(["prompt", "subagent"])).toBe("subagent");
    expect(mostStructural(["subagent", "prompt"])).toBe("subagent");
    expect(mostStructural(["prompt", "config", "context_mgmt"])).toBe("context_mgmt");
    expect(mostStructural(["config", "client_tool", "control_flow"])).toBe("client_tool");
    expect(mostStructural(["prompt", "memory", "client_tool"])).toBe("memory");
  });

  it("gives the component itself for a list of one, and for repeats", () => {
    for (const c of K) expect(mostStructural([c])).toBe(c);
    expect(mostStructural(["config", "config"])).toBe("config");
  });

  it("gives null for an empty list, and for names that are not components", () => {
    expect(mostStructural([])).toBeNull();
    expect(mostStructural(["skill", "output_plumbing"])).toBeNull();
  });

  it("ignores a name that is not a component next to one that is", () => {
    expect(mostStructural(["skill", "prompt"])).toBe("prompt");
  });
});

describe("novelty", () => {
  it("counts the structural components with no accepted edit in the incumbent", () => {
    expect(novelty(["subagent", "prompt"], { prompt: 1 })).toBe(1);
    expect(novelty(["memory", "client_tool", "subagent"], {})).toBe(3);
  });

  it("is 0 for a structural component the incumbent already has", () => {
    expect(novelty(["client_tool"], { client_tool: 2 })).toBe(0);
    expect(novelty(["memory", "subagent"], { memory: 1, subagent: 4 })).toBe(0);
  });

  it("counts a component with a count of 0 and one with no count alike", () => {
    expect(novelty(["memory"], { memory: 0 })).toBe(1);
    expect(novelty(["memory"], {})).toBe(1);
  });

  it("never counts a component that is not structural", () => {
    expect(novelty(["prompt", "config", "control_flow", "context_mgmt"], {})).toBe(0);
  });

  it("counts a component once, however many edits touch it", () => {
    expect(novelty(["memory", "memory", "memory"], {})).toBe(1);
  });

  it("counts none for an empty list, and ignores names that are not components", () => {
    expect(novelty([], {})).toBe(0);
    expect(novelty(["skill", "output_plumbing", "constructor"], {})).toBe(0);
  });
});
