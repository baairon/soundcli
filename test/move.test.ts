import { describe, it, expect } from "vitest";
import { wrapStep } from "../src/ui/move";

describe("wrapStep", () => {
  it("steps normally inside the list", () => {
    expect(wrapStep(1, 1, 5)).toBe(2);
    expect(wrapStep(3, -1, 5)).toBe(2);
  });

  it("wraps from the top to the bottom", () => {
    expect(wrapStep(0, -1, 5)).toBe(4);
  });

  it("wraps from the bottom to the top", () => {
    expect(wrapStep(4, 1, 5)).toBe(0);
  });

  it("stays put on a single-row list", () => {
    expect(wrapStep(0, 1, 1)).toBe(0);
    expect(wrapStep(0, -1, 1)).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(wrapStep(0, 1, 0)).toBe(0);
    expect(wrapStep(3, -1, 0)).toBe(0);
  });
});
