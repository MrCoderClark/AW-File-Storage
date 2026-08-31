import { describe, expect, it } from "vitest";
import { formatDuration } from "../src/lib/format";

describe("formatDuration", () => {
  it("shows seconds under a minute", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(14)).toBe("14s");
    expect(formatDuration(59)).toBe("59s");
  });
  it("rounds partial seconds up", () => {
    expect(formatDuration(13.2)).toBe("14s");
    expect(formatDuration(0.1)).toBe("1s");
  });
  it("shows minutes and seconds", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(83)).toBe("1m 23s");
    expect(formatDuration(125)).toBe("2m 5s");
  });
  it("shows hours and minutes past an hour", () => {
    expect(formatDuration(3600)).toBe("1h 0m");
    expect(formatDuration(3660)).toBe("1h 1m");
  });
  it("returns '' for nonsense input so the caller can withhold it", () => {
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
    expect(formatDuration(-5)).toBe("");
  });
});
