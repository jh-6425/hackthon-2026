import { describe, expect, it } from "vitest";
import { itemToAction, relativizePath } from "./events.js";

describe("relativizePath", () => {
  const roots = ["/home/agent/workspaces/a", "/workspace"];

  it("relativises a path inside a workspace root", () => {
    expect(relativizePath("/workspace/tests/x.test.ts", roots)).toBe("tests/x.test.ts");
  });

  it("keeps an absolute path outside every workspace root absolute", () => {
    // Must stay absolute so the downstream escape check rejects it, rather than
    // being disguised as an in-workspace relative path.
    expect(relativizePath("/etc/passwd", roots)).toBe("/etc/passwd");
  });

  it("treats a write to the workspace root itself as an escape", () => {
    expect(relativizePath("/workspace", roots)).toBe("/workspace");
  });

  it("normalises an already-relative path", () => {
    expect(relativizePath("./src/a.ts", roots)).toBe("src/a.ts");
  });
});

describe("itemToAction: absolute-path file change", () => {
  it("surfaces an out-of-workspace absolute path so policy can block it", () => {
    const action = itemToAction(
      {
        id: "f1",
        type: "file_change",
        raw: {
          type: "file_change",
          changes: [{ path: "/etc/cron.d/evil", kind: "add" }],
        },
      },
      ["/workspace"],
    );
    expect(action).toEqual({ kind: "file_change", itemId: "f1", paths: ["/etc/cron.d/evil"] });
  });
});
