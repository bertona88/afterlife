import { describe, expect, it } from "vitest";
import { tagsToMap, tagFirst } from "./tags";

describe("tagsToMap", () => {
  it("handles missing tags", () => {
    const map = tagsToMap(undefined);
    expect(map.size).toBe(0);
  });

  it("preserves duplicates", () => {
    const map = tagsToMap([
      { name: "Self-Id", value: "A" },
      { name: "Self-Id", value: "B" },
    ]);
    expect(map.get("Self-Id")).toEqual(["A", "B"]);
    expect(tagFirst(map, "Self-Id")).toBe("A");
  });
});

