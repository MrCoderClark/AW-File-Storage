import { describe, expect, it } from "vitest";
import { fileCategory } from "../src/lib/file-type";

describe("fileCategory", () => {
  it("classifies by extension (case-insensitive)", () => {
    expect(fileCategory("Q3_Report.pdf")).toBe("pdf");
    expect(fileCategory("Team_Photo.PNG")).toBe("image");
    expect(fileCategory("Specs.docx")).toBe("document");
    expect(fileCategory("Backup.zip")).toBe("archive");
    expect(fileCategory("Jay_Clark.vcf")).toBe("vcard");
    expect(fileCategory("firmware.bin")).toBe("other");
    expect(fileCategory("noextension")).toBe("other");
  });

  it("treats kind=vcard as a contact card regardless of name", () => {
    expect(fileCategory("weird-name", "text/plain", "vcard")).toBe("vcard");
  });

  it("falls back to the content type when the extension is unknown", () => {
    expect(fileCategory("blob", "image/jpeg")).toBe("image");
    expect(fileCategory("blob", "application/pdf")).toBe("pdf");
    expect(fileCategory("blob", "application/zip")).toBe("archive");
    expect(fileCategory("blob", "text/csv")).toBe("document");
  });
});
