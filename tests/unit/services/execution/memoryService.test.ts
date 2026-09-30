import { describe, it, expect } from "vitest";
import { MemoryService } from "@/services/execution/memoryService";

describe("MemoryService", () => {
  it("stores trimmed values, overwrites a key, and builds a context from the keys that are set", () => {
    const memory = new MemoryService();
    memory.write("plan", "  first  ");
    memory.write("plan", "second");
    memory.writeAll(["a", "b"], "shared");

    expect(memory.read("plan")).toBe("second");
    expect(memory.read("missing")).toBeNull();
    expect(memory.buildContext(["plan", "missing", "a"])).toBe("[memory:plan]\nsecond\n\n[memory:a]\nshared");
    expect(memory.dump()).toEqual({ plan: "second", a: "shared", b: "shared" });
  });

  describe("forget", () => {
    it("takes back what a writer wrote, and leaves what others wrote", () => {
      const memory = new MemoryService();
      memory.writeAll(["notes", "plan"], "from A", "A");
      memory.write("other", "from B", "B");

      memory.forget("A");

      expect(memory.dump()).toEqual({ other: "from B" });
      expect(memory.buildContext(["notes", "plan"])).toBe("");
    });

    it("gives a key the writer overwrote back to what the writer before it left", () => {
      const memory = new MemoryService();
      memory.write("result", "from A", "A");
      memory.write("result", "from B", "B");
      expect(memory.read("result")).toBe("from B");

      memory.forget("B");

      expect(memory.read("result")).toBe("from A");
    });

    it("keeps the order of writes: a writer that wrote again is the latest, and forgetting an earlier one changes nothing", () => {
      const memory = new MemoryService();
      memory.write("result", "A one", "A");
      memory.write("result", "B one", "B");
      memory.write("result", "A two", "A"); // A revised its answer after B wrote

      memory.forget("B");
      expect(memory.read("result")).toBe("A two");

      const other = new MemoryService();
      other.write("result", "A one", "A");
      other.write("result", "B one", "B");
      other.write("result", "A two", "A");
      other.forget("A");
      expect(other.read("result")).toBe("B one");
    });

    it("does nothing for a writer that wrote nothing", () => {
      const memory = new MemoryService();
      memory.write("k", "v", "A");

      memory.forget("nobody");

      expect(memory.dump()).toEqual({ k: "v" });
    });
  });
});
