import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import path from "node:path";

// Digests are keyed by workspace-relative POSIX path. A Map (not a plain object)
// is used so path names like "__proto__" / "constructor" / "toString" cannot
// corrupt add/remove/change detection.
export type WorkspaceDigest = Map<string, string>;

/** A CONFIRMED escaping/cyclic symlink (distinct from an I/O verification error). */
export class SymlinkEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymlinkEscapeError";
  }
}

function errCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
}

/** Only a genuine ENOENT is "absent"; ELOOP / EACCES / EIO must not be swallowed. */
function isMissing(error: unknown): boolean {
  return errCode(error) === "ENOENT";
}

interface Entry {
  rel: string;
  symlink: boolean;
}

// walk does NOT follow symlinks, so a symlink cycle cannot cause infinite
// recursion here. Escaping/cyclic links are judged separately.
async function walk(root: string, prefix = ""): Promise<Entry[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const out: Entry[] = [];
  for (const entry of entries) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      out.push({ rel, symlink: true });
    } else if (entry.isDirectory()) {
      out.push(...(await walk(root, rel)));
    } else if (entry.isFile()) {
      out.push({ rel, symlink: false });
    }
    // sockets/fifos/devices are ignored by design.
  }
  return out;
}

const toPosix = (rel: string): string => rel.split(path.sep).join("/");

/**
 * Digest every regular file and symlink under `root`. Throws on any I/O error
 * (missing root, unreadable file, failed readdir) so callers fail closed instead
 * of treating a partial or empty read as a clean state. A genuinely empty
 * directory yields an empty map without throwing.
 */
export async function digestWorkspace(root: string): Promise<WorkspaceDigest> {
  const digest: WorkspaceDigest = new Map();
  const entries = await walk(root);
  for (const { rel, symlink } of entries.sort((a, b) => a.rel.localeCompare(b.rel))) {
    const key = toPosix(rel);
    if (symlink) {
      const target = await readlink(path.join(root, rel));
      digest.set(key, "symlink:" + createHash("sha256").update(target).digest("hex"));
    } else {
      const content = await readFile(path.join(root, rel));
      digest.set(key, createHash("sha256").update(content).digest("hex"));
    }
  }
  return digest;
}

export async function digestFileAt(
  root: string,
  relativePath: string,
): Promise<string | null> {
  const target = path.join(root, relativePath);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error; // EACCES/EIO must not be treated as "absent".
  }
  if (info.isSymbolicLink()) {
    const link = await readlink(target);
    return "symlink:" + createHash("sha256").update(link).digest("hex");
  }
  const content = await readFile(target);
  return createHash("sha256").update(content).digest("hex");
}

export function digestsMatch(left: WorkspaceDigest, right: WorkspaceDigest): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

/**
 * Every path that was added, removed, or changed between two digests. Used to
 * catch out-of-band mutations that never surfaced as a file_change event.
 */
export function changedPaths(before: WorkspaceDigest, after: WorkspaceDigest): string[] {
  const changed = new Set<string>();
  for (const [key, value] of after) {
    if (before.get(key) !== value) changed.add(key);
  }
  for (const key of before.keys()) {
    if (!after.has(key)) changed.add(key);
  }
  return [...changed].sort();
}

function escapesRoot(realRoot: string, target: string): boolean {
  const rel = path.relative(realRoot, target);
  return rel !== "" && (rel.split(path.sep)[0] === ".." || path.isAbsolute(rel));
}

/**
 * Throw if any symlink under `root` resolves outside `root`, cannot be resolved
 * (ELOOP / EACCES / EIO), or is otherwise unverifiable. Internal relative links
 * that resolve inside the canonical root are allowed. Dangling links are judged
 * lexically against the canonical parent; a dangling external link is rejected.
 */
export async function assertNoEscapingSymlinks(root: string): Promise<void> {
  const realRoot = await realpath(root);
  const entries = await walk(root);
  for (const { rel, symlink } of entries) {
    if (!symlink) continue;
    const abs = path.join(root, rel);
    let resolved: string;
    try {
      resolved = await realpath(abs);
    } catch (error) {
      const code = errCode(error);
      if (code === "ELOOP") {
        throw new SymlinkEscapeError("Workspace contains a cyclic symlink: " + rel);
      }
      if (code && code !== "ENOENT") {
        // EACCES / EIO / anything unverifiable -> fail closed.
        throw new Error("Workspace symlink could not be verified (" + code + "): " + rel);
      }
      // Dangling link: resolve lexically against the real directory.
      let raw: string;
      try {
        raw = await readlink(abs);
      } catch (linkError) {
        throw new Error(
          "Workspace symlink could not be read (" + (errCode(linkError) ?? "unknown") + "): " + rel,
        );
      }
      const realDir = await realpath(path.dirname(abs)).catch(() => path.dirname(abs));
      resolved = path.resolve(realDir, raw);
    }
    if (escapesRoot(realRoot, resolved)) {
      throw new SymlinkEscapeError(
        "Workspace contains a symlink that escapes the workspace: " + rel + " -> " + resolved,
      );
    }
  }
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
      // Refuse to run over a workspace that already contains an escaping symlink.
      await assertNoEscapingSymlinks(workspacePath);
      await cp(workspacePath, snapshotPath, { recursive: true, verbatimSymlinks: true });
      // Re-verify AFTER the copy to close the check->copy TOCTOU window: the
      // snapshot itself must also be free of escaping symlinks, or we fail closed.
      await assertNoEscapingSymlinks(snapshotPath);
      const digest = await digestWorkspace(snapshotPath);
      return new WorkspaceSnapshot(workspacePath, snapshotPath, digest);
    } catch (error) {
      await rm(snapshotPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  fileDigest(relativePath: string): string | null {
    return this.digest.get(toPosix(relativePath)) ?? null;
  }

  /** The current workspace state, for out-of-band change detection. */
  async currentDigest(): Promise<WorkspaceDigest> {
    return digestWorkspace(this.workspacePath);
  }

  /** Assert the (post-run) workspace still holds no escaping symlink. */
  async assertNoEscape(): Promise<void> {
    await assertNoEscapingSymlinks(this.workspacePath);
  }

  async restore(): Promise<RollbackReport> {
    await rm(this.workspacePath, { recursive: true, force: true });
    await cp(this.snapshotPath, this.workspacePath, { recursive: true, verbatimSymlinks: true });
    const after = await digestWorkspace(this.workspacePath);
    return {
      restored: true,
      fileCount: after.size,
      digestMatches: digestsMatch(this.digest, after),
    };
  }

  /** Best-effort cleanup — never throws, so it cannot block final run state. */
  async discard(): Promise<void> {
    await rm(this.snapshotPath, { recursive: true, force: true }).catch(() => undefined);
  }
}
