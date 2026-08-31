import { describe, expect, it } from "vitest";
import { canonicalizePath } from "./glob.js";

describe("canonicalizePath (POSIX-correct)", () => {
  it("collapses ./ , duplicate slashes and internal ..", () => {
    expect(canonicalizePath("src/./a.ts")).toBe("src/a.ts");
    expect(canonicalizePath("src//a.ts")).toBe("src/a.ts");
    expect(canonicalizePath("src/x/../a.ts")).toBe("src/a.ts");
  });
  it("preserves a leading .. so an escape stays visible", () => {
    expect(canonicalizePath("../../a")).toBe("../../a");
  });
  it("does NOT treat a literal backslash as a separator (POSIX filename)", () => {
    // "tests\\evil.ts" is a single root-level filename, not under tests/.
    expect(canonicalizePath("tests\\evil.ts")).toBe("tests\\evil.ts");
  });
});
