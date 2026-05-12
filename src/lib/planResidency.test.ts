import { describe, expect, it } from "vitest";

import { parsePlanDataResidency } from "./planResidency";

describe("parsePlanDataResidency", () => {
  it("defaults to hybrid", () => {
    expect(parsePlanDataResidency(undefined)).toBe("hybrid");
    expect(parsePlanDataResidency("")).toBe("hybrid");
    expect(parsePlanDataResidency("nosuch")).toBe("hybrid");
  });

  it("accepts local, hybrid, cloud case-insensitively", () => {
    expect(parsePlanDataResidency("LOCAL")).toBe("local");
    expect(parsePlanDataResidency(" Hybrid ")).toBe("hybrid");
    expect(parsePlanDataResidency("cloud")).toBe("cloud");
  });
});
