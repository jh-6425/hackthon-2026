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

describe("itemToAction: command field variations", () => {
  const roots = ["/workspace"];
  const cmd = (raw: Record<string, unknown>) =>
    itemToAction({ id: "c1", type: "command_execution", raw }, roots);

  it("reads a string command", () => {
    expect(cmd({ command: "npm test" })).toEqual({
      kind: "command",
      itemId: "c1",
      command: "npm test",
    });
  });

  it("reads an array command", () => {
    expect(cmd({ command: ["bash", "-lc", "npm test"] })?.command).toBe("bash -lc npm test");
  });

  it("falls back to cmd / parsed_cmd when command is absent", () => {
    expect(cmd({ cmd: "ls -la" })?.command).toBe("ls -la");
    expect(cmd({ parsed_cmd: ["git", "status"] })?.command).toBe("git status");
  });

  it("returns null when no command field is present", () => {
    expect(cmd({ status: "completed" })).toBeNull();
  });
});

describe("itemToAction: file_change field variations", () => {
  const roots = ["/workspace"];
  const fc = (raw: Record<string, unknown>) =>
    itemToAction({ id: "f1", type: "file_change", raw }, roots);

  it("reads changes[].path", () => {
    expect(fc({ changes: [{ path: "/workspace/a.ts", kind: "add" }] })?.paths).toEqual([
      "a.ts",
    ]);
  });

  it("reads alternative path field names", () => {
    expect(fc({ changes: [{ file_path: "/workspace/b.ts" }] })?.paths).toEqual(["b.ts"]);
    expect(fc({ changes: [{ absolute_file_path: "/workspace/c.ts" }] })?.paths).toEqual([
      "c.ts",
    ]);
  });

  it("reads a changes object keyed by path", () => {
    expect(fc({ changes: { "src/x.ts": { kind: "modify" } } })?.paths).toEqual(["src/x.ts"]);
  });

  it("reads a files array and a bare string entry", () => {
    expect(fc({ files: ["tests/y.test.ts"] })?.paths).toEqual(["tests/y.test.ts"]);
  });
});
