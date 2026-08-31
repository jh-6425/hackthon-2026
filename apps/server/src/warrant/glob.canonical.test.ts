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

import { escapesWorkspace } from "./glob.js";

describe("canonicalizePath preserves absolute markers (R7-1/2)", () => {
  it("keeps a POSIX absolute path absolute (not collapsed to a relative look-alike)", () => {
    expect(canonicalizePath("/tests/evil.ts")).toBe("/tests/evil.ts");
    expect(canonicalizePath("/etc/passwd")).toBe("/etc/passwd");
    expect(escapesWorkspace(canonicalizePath("/tests/evil.ts"), false)).toBe(true);
  });
  it("resolves an in-workspace path that dots up to root to empty (root write)", () => {
    expect(canonicalizePath("tests/..")).toBe("");
    expect(canonicalizePath(".")).toBe("");
  });
  it("Windows drive/UNC stay absolute; POSIX treats C:notes.txt as a normal file", () => {
    expect(escapesWorkspace("\\\\server\\share\\evil.ts", true)).toBe(true);
    expect(escapesWorkspace("\\evil.ts", true)).toBe(true);
    expect(escapesWorkspace("C:notes.txt", true)).toBe(true); // drive-relative on Windows
    expect(escapesWorkspace("C:notes.txt", false)).toBe(false); // legal POSIX filename
  });
});
