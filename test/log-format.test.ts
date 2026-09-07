import { describe, expect, it } from "vitest";
import {
  actionsForCategory,
  logCategory,
  logDetail,
  logStatus,
} from "../src/lib/log-format";

describe("log-format (spec 0018)", () => {
  it("categorises the key onboarding/offboarding actions", () => {
    expect(logCategory("card.auto_created")).toBe("onboard");
    expect(logCategory("member.added")).toBe("onboard");
    expect(logCategory("card.offboarded")).toBe("offboard");
    expect(logCategory("member.removed")).toBe("offboard");
    expect(logCategory("vcard.published")).toBe("vcard");
    expect(logCategory("o365.sync_failed")).toBe("error");
    expect(logCategory("something.unknown")).toBe("other");
  });

  it("marks only failures as failed", () => {
    expect(logStatus("o365.sync_failed")).toBe("failed");
    expect(logStatus("card.auto_created")).toBe("success");
    expect(logStatus("member.removed")).toBe("success");
  });

  it("actionsForCategory returns the actions of a category", () => {
    const offboard = actionsForCategory("offboard");
    expect(offboard).toContain("card.offboarded");
    expect(offboard).toContain("member.removed");
    expect(offboard).not.toContain("card.auto_created");
  });

  it("pulls a friendly detail from metadata, tolerating bad JSON", () => {
    expect(logDetail('{"name":"Jane Doe","slug":"Jane_Doe"}')).toBe("Jane Doe");
    expect(logDetail('{"slug":"Jane_Doe"}')).toBe("Jane_Doe");
    expect(logDetail(null)).toBe("");
    expect(logDetail("not json")).toBe("");
  });
});
