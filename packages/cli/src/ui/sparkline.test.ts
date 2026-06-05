import { describe, expect, it } from "vitest";
import { sparkline } from "./sparkline";

describe("sparkline", () => {
  it("is empty for no values", () => {
    expect(sparkline([])).toBe("");
  });

  it("renders a flat series as the lowest block", () => {
    expect(sparkline([5, 5, 5])).toBe("▁▁▁");
  });

  it("scales across an explicit min/max", () => {
    expect(sparkline([0, 50, 100], { min: 0, max: 100 })).toBe("▁▅█");
  });

  it("spans the full glyph range when min and max differ widely", () => {
    expect(sparkline([0, 100], { min: 0, max: 100 })).toBe("▁█");
  });

  it("auto-fits to the data range when no scale is given", () => {
    // min=10 → lowest, max=20 → highest
    expect(sparkline([10, 20])).toBe("▁█");
  });

  it("clamps out-of-range values to the scale bounds", () => {
    expect(sparkline([-50, 150], { min: 0, max: 100 })).toBe("▁█");
  });
});
