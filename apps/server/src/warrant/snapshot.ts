import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

export type WorkspaceDigest = Record<string, string>;

// A directory digest covers regular files AND symlinks. Symlinks are digested by
// their link target string prefixed with "symlink:" so a workspace that swaps a
// file for a symlink (or repoints one) is detected as a change rather than being
// silently ignored.
async function walk(root: string, prefix = ""): Promise<Array<{ rel: string; symlink: boolean }>> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const out: Array<{ rel: string; symlink: boolean }> = [];
  for (const entry of entries) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      out.push({ rel, symlink: true });
    } else if (entry.isDirectory()) {
      out.push(...(await walk(root, rel)));
    } else if (entry.isFile()) {
      out.push({ rel, symlink: false });
    }
  }
  return out;
}

/**
 * Digest every regular file and symlink under `root`. Throws on any I/O error
 * (missing root, unreadable file, failed readdir) so callers fail closed instead
 * of treating a partial or empty read as a clean state. A genuinely empty
 * directory yields an empty object without throwing.
 */
export async function digestWorkspace(root: string): Promise<WorkspaceDigest> {
  const digest: WorkspaceDigest = {};
  const { readlink } = await import("node:fs/promises");
  const entries = await walk(root);
  for (const { rel, symlink } of entries.sort((a, b) => a.rel.localeCompare(b.rel))) {
    const key = rel.split(path.sep).join("/");
    if (symlink) {
      const target = await readlink(path.join(root, rel));
      digest[key] = "symlink:" + createHash("sha256").update(target).digest("hex");
    } else {
      const content = await readFile(path.join(root, rel));
      digest[key] = createHash("sha256").update(content).digest("hex");
    }
  }
  return digest;
}

export async function digestFileAt(
  root: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const target = path.join(root, relativePath);
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      const { readlink } = await import("node:fs/promises");
      const link = await readlink(target);
      return "symlink:" + createHash("sha256").update(link).digest("hex");
    }
    const content = await readFile(target);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

export function digestsMatch(left: WorkspaceDigest, right: WorkspaceDigest): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

/**
 * Compare a pre-run digest to the current workspace and return every path that
 * was added, removed, or changed. Used to catch out-of-band mutations (e.g. an
 * npm subprocess) that never surfaced as a file_change event.
 */
export function changedPaths(before: WorkspaceDigest, after: WorkspaceDigest): string[] {
  const changed = new Set<string>();
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) changed.add(key);
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) changed.add(key);
  }
  return [...changed].sort();
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
    try {
      // Preserve symlinks as links (verbatimSymlinks) so an escaping link is
      // captured faithfully rather than dereferenced into the snapshot.
      await cp(workspacePath, snapshotPath, { recursive: true, verbatimSymlinks: true });
      const digest = await digestWorkspace(snapshotPath);
      return new WorkspaceSnapshot(workspacePath, snapshotPath, digest);
    } catch (error) {
      // Never leave a partial snapshot behind; fail closed.
      await rm(snapshotPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  fileDigest(relativePath: string): string | null {
    return this.digest[relativePath] ?? null;
  }

  /** The current workspace state, for out-of-band change detection. */
  async currentDigest(): Promise<WorkspaceDigest> {
    return digestWorkspace(this.workspacePath);
  }

  async restore(): Promise<RollbackReport> {
    await rm(this.workspacePath, { recursive: true, force: true });
    await cp(this.snapshotPath, this.workspacePath, { recursive: true, verbatimSymlinks: true });
    const after = await digestWorkspace(this.workspacePath);
    return {
      restored: true,
      fileCount: Object.keys(after).length,
      digestMatches: digestsMatch(this.digest, after),
    };
  }

  /** Best-effort cleanup — never throws, so it cannot block final run state. */
  async discard(): Promise<void> {
    await rm(this.snapshotPath, { recursive: true, force: true }).catch(() => undefined);
  }
}
