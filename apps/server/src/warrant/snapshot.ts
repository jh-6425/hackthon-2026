import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

export type WorkspaceDigest = Record<string, string>;

async function walk(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walk(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

export async function digestWorkspace(root: string): Promise<WorkspaceDigest> {
  const digest: WorkspaceDigest = {};
  let files: string[];
  try {
    files = await walk(root);
  } catch {
    return digest;
  }
  for (const relative of files.sort()) {
    const content = await readFile(path.join(root, relative));
    digest[relative.split(path.sep).join("/")] = createHash("sha256")
      .update(content)
      .digest("hex");
  }
  return digest;
}

const DIGEST_ABSENT = null;

export async function digestFileAt(
  root: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const content = await readFile(path.join(root, relativePath));
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return DIGEST_ABSENT;
  }
}

export function digestsMatch(left: WorkspaceDigest, right: WorkspaceDigest): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

export interface RollbackReport {
  restored: boolean;
  fileCount: number;
  digestMatches: boolean;
}

export class WorkspaceSnapshot {
  private constructor(
    private readonly workspacePath: string,
    private readonly snapshotPath: string,
    readonly digest: WorkspaceDigest,
  ) {}

  static async capture(
    workspacePath: string,
    snapshotRoot: string,
    runId: string,
  ): Promise<WorkspaceSnapshot> {
    const snapshotPath = path.join(snapshotRoot, runId);
    await rm(snapshotPath, { recursive: true, force: true });
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await cp(workspacePath, snapshotPath, { recursive: true });
    const digest = await digestWorkspace(snapshotPath);
    return new WorkspaceSnapshot(workspacePath, snapshotPath, digest);
  }

  fileDigest(relativePath: string): string | null {
    return this.digest[relativePath] ?? null;
  }

  async restore(): Promise<RollbackReport> {
    await rm(this.workspacePath, { recursive: true, force: true });
    await cp(this.snapshotPath, this.workspacePath, { recursive: true });
    const after = await digestWorkspace(this.workspacePath);
    return {
      restored: true,
      fileCount: Object.keys(after).length,
      digestMatches: digestsMatch(this.digest, after),
    };
  }

  async discard(): Promise<void> {
    await rm(this.snapshotPath, { recursive: true, force: true });
  }
}
