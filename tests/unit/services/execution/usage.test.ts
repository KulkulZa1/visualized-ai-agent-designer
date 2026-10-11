import { describe, expect, it } from "vitest";
import { createUsageMeter, noUsage, readNodeUsage } from "@/services/execution/usage";

describe("createUsageMeter", () => {
  it("starts with nothing used and no call made", () => {
    expect(createUsageMeter().totals()).toEqual({ input: 0, output: 0, calls: 0, callsWithoutUsage: 0 });
    expect(noUsage()).toEqual(createUsageMeter().totals());
  });

  it("adds the counts of each call that carried them", () => {
    const meter = createUsageMeter();
    meter.count({ input: 100, output: 10 });
    meter.count({ input: 150, output: 20 });
    expect(meter.totals()).toEqual({ input: 250, output: 30, calls: 2, callsWithoutUsage: 0 });
  });

  it("counts a reply with no counts as a call without usage, and adds nothing for it", () => {
    const meter = createUsageMeter();
    meter.count({ input: 100, output: 10 });
    meter.count(null);
    meter.count(undefined);
    expect(meter.totals()).toEqual({ input: 100, output: 10, calls: 3, callsWithoutUsage: 2 });
  });

  it("takes counts that are not a pair of whole numbers for none, so that nothing in the total is made up", () => {
    const meter = createUsageMeter();
    for (const bad of [{ input: 1 }, { input: "1", output: 2 }, { input: -1, output: 2 }, { input: 1.5, output: 2 }, [], 3]) {
      meter.count(bad as never);
    }
    expect(meter.totals()).toEqual({ input: 0, output: 0, calls: 6, callsWithoutUsage: 6 });
  });

  it("goes on from the totals of an earlier attempt, and leaves that object as it was", () => {
    const earlier = { input: 100, output: 10, calls: 2, callsWithoutUsage: 1 };
    const meter = createUsageMeter(earlier);
    meter.count({ input: 5, output: 1 });
    expect(meter.totals()).toEqual({ input: 105, output: 11, calls: 3, callsWithoutUsage: 1 });
    expect(earlier).toEqual({ input: 100, output: 10, calls: 2, callsWithoutUsage: 1 });
  });

  it("gives totals that later calls do not change: what a node was given when it ended stays", () => {
    const meter = createUsageMeter();
    meter.count({ input: 1, output: 1 });
    const ended = meter.totals();
    meter.count({ input: 5, output: 5 }); // a call the node gave up on, answering late
    expect(ended).toEqual({ input: 1, output: 1, calls: 1, callsWithoutUsage: 0 });
  });
});

describe("readNodeUsage", () => {
  it("reads four token counts", () => {
    const usage = { input: 250, output: 30, calls: 2, callsWithoutUsage: 0 };
    expect(readNodeUsage(usage)).toEqual(usage);
    expect(readNodeUsage({ ...usage, extra: "left out" })).toEqual(usage);
  });

  it("is undefined for anything else: a record from before usage was kept, or one that was edited", () => {
    const good = { input: 250, output: 30, calls: 2, callsWithoutUsage: 0 };
    for (const bad of [
      undefined, null, 7, "x", [], {}, { input: 1, output: 2 }, { ...good, calls: undefined }, { ...good, callsWithoutUsage: "0" },
      { ...good, input: -1 }, { ...good, output: 0.5 },
    ]) {
      expect(readNodeUsage(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
