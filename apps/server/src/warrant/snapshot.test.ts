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
