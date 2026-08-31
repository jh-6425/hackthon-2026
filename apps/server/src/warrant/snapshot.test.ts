import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceSnapshot, digestWorkspace, digestsMatch } from "./snapshot.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeWorkspace(): Promise<{ workspace: string; snapshots: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "warrant-snapshot-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const snapshots = path.join(root, "snapshots");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "protected asset\n");
  await writeFile(path.join(workspace, "src", "index.ts"), "export const a = 1;\n");
  return { workspace, snapshots };
}

describe("WorkspaceSnapshot", () => {
  it("restores the workspace exactly after a malicious run mutates it", async () => {
    const { workspace, snapshots } = await makeWorkspace();
    const snapshot = await WorkspaceSnapshot.capture(workspace, snapshots, "run-1");

    await writeFile(path.join(workspace, "README.md"), "tampered\n");
    await writeFile(path.join(workspace, "exfiltrated.txt"), "secret\n");
    await rm(path.join(workspace, "src", "index.ts"));

    const report = await snapshot.restore();

    expect(report.restored).toBe(true);
    expect(report.digestMatches).toBe(true);
    expect(report.fileCount).toBe(2);
    const entries = await readdir(workspace);
    expect(entries.sort()).toEqual(["README.md", "src"]);
    expect(await digestWorkspace(workspace)).toEqual(snapshot.digest);
  });

  it("detects that a digest changed when the workspace is not restored", async () => {
    const { workspace, snapshots } = await makeWorkspace();
    const snapshot = await WorkspaceSnapshot.capture(workspace, snapshots, "run-2");

    await writeFile(path.join(workspace, "README.md"), "tampered\n");

    expect(digestsMatch(snapshot.digest, await digestWorkspace(workspace))).toBe(false);
  });

  it("removes the snapshot directory when discarded", async () => {
    const { workspace, snapshots } = await makeWorkspace();
    const snapshot = await WorkspaceSnapshot.capture(workspace, snapshots, "run-3");
    await snapshot.discard();

    expect(await readdir(snapshots)).toEqual([]);
  });
});

describe("digestWorkspace fail-closed and change detection", () => {
  it("throws when the root cannot be read (no false empty digest)", async () => {
    await expect(digestWorkspace(path.join(tmpdir(), "warrant-does-not-exist-" + Math.random()))).rejects.toBeTruthy();
  });

  it("reports added, changed, and removed paths", async () => {
    const { changedPaths } = await import("./snapshot.js");
    const before = new Map([["a.ts", "1"], ["b.ts", "2"]]);
    const after = new Map([["a.ts", "1"], ["b.ts", "9"], ["c.ts", "3"]]);
    expect(changedPaths(before, after)).toEqual(["b.ts", "c.ts"]);
  });
});

describe("WorkspaceSnapshot symlink awareness", () => {
  it("captures an in-workspace symlink by target and detects a repoint as a change", async () => {
    const { mkdir, symlink, rm, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "warrant-symlink-"));
    roots.push(root);
    const ws = path.join(root, "ws");
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, "a.txt"), "a");
    await writeFile(path.join(ws, "b.txt"), "b");
    await symlink("a.txt", path.join(ws, "link")); // relative, in-workspace
    const snap = await WorkspaceSnapshot.capture(ws, path.join(root, "snaps"), "run");
    expect(snap.digest.get("link")).toMatch(/^symlink:/);
    await rm(path.join(ws, "link"));
    await symlink("b.txt", path.join(ws, "link"));
    const { digestWorkspace: dw } = await import("./snapshot.js");
    expect((await dw(ws)).get("link")).not.toBe(snap.digest.get("link"));
  });

  it("P0-2: refuses to snapshot a workspace with a symlink escaping the workspace", async () => {
    const { mkdir, symlink, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "warrant-escape-"));
    roots.push(root);
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "SECRET");
    const ws = path.join(root, "ws", "tests");
    await mkdir(ws, { recursive: true });
    await symlink(outside, path.join(ws, "link")); // absolute escape
    await expect(
      WorkspaceSnapshot.capture(path.join(root, "ws"), path.join(root, "snaps"), "run"),
    ).rejects.toThrow(/escapes the workspace/);
  });
});

describe("digest special filenames and links (round 4)", () => {
  it("F17: detects add/change/remove for __proto__ / constructor / toString names", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "warrant-proto-"));
    roots.push(root);
    const ws = path.join(root, "ws");
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, "__proto__"), "a");
    await writeFile(path.join(ws, "constructor"), "b");
    const before = await digestWorkspace(ws);
    await writeFile(path.join(ws, "__proto__"), "CHANGED");
    await writeFile(path.join(ws, "toString"), "new");
    const { changedPaths } = await import("./snapshot.js");
    const after = await digestWorkspace(ws);
    expect(changedPaths(before, after).sort()).toEqual(["__proto__", "toString"]);
  });

  it("F16: rejects a cyclic symlink at snapshot time", async () => {
    const { mkdir, symlink } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "warrant-cycle-"));
    roots.push(root);
    const ws = path.join(root, "ws");
    await mkdir(ws, { recursive: true });
    await symlink("b", path.join(ws, "a"));
    await symlink("a", path.join(ws, "b"));
    await expect(
      WorkspaceSnapshot.capture(ws, path.join(root, "snaps"), "run"),
    ).rejects.toThrow(/cyclic|could not be verified|escapes/);
  });

  it("F16: allows an internal relative symlink and rejects a dangling external one", async () => {
    const { mkdir, symlink, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "warrant-int-"));
    roots.push(root);
    const ws = path.join(root, "ws");
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, "real.txt"), "x");
    await symlink("real.txt", path.join(ws, "inside")); // internal, resolves
    const snap = await WorkspaceSnapshot.capture(ws, path.join(root, "ok"), "run");
    expect(snap.digest.get("inside")).toMatch(/^symlink:/);

    await symlink("/tmp/definitely-missing-" + Math.random(), path.join(ws, "outside"));
    await expect(
      WorkspaceSnapshot.capture(ws, path.join(root, "bad"), "run2"),
    ).rejects.toThrow(/escapes/);
  });
});
