import { constants as FS } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseCodexEventLine, violationError } from "../codex-runner.js";
import { RunCancelledError } from "../errors.js";
import { extractItem, itemToAction } from "./events.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";

/**
 * A deterministic runner that replays a recorded Codex event stream instead of
 * spawning a container. It lets the middleware be demonstrated and tested end to
 * end with no Ark key, no Docker, and no network: the events flow through the
 * real parser, monitor, policy engine, and rollback path.
 *
 * Scenario selection never depends on the operator's prompt — the same benign
 * task drives both scenarios. A poisoned workspace is chosen by the presence of
 * a marker file (POISON_MARKER) in the workspace, so the "attack" comes from the
 * workspace, not from what the user typed.
 */

const POISON_MARKER = ".warrant-poisoned";
const BENIGN_FILE = "benign.json";
const POISONED_FILE = "poisoned.json";

interface ScenarioEvent {
  __write?: { path: string; content: string };
  [key: string]: unknown;
}

interface Scenario {
  delayMs?: number;
  finalMessage?: string;
  events: ScenarioEvent[];
}

export class ReplayRunner implements AgentRunner {
  private readonly cancelled = new Set<string>();

  constructor(private readonly scenarioPath: string) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async cancel(agentId: string): Promise<boolean> {
    if (this.cancelled.has(agentId)) return false;
    this.cancelled.add(agentId);
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.cancelled.delete(request.agentId);
    try {
      return await this.replay(request);
    } finally {
      this.cancelled.delete(request.agentId);
    }
  }

  private async replay(request: RunnerRequest): Promise<RunnerResult> {
    const scenario = await this.load(request.workspacePath);
    const delay = scenario.delayMs ?? 350;
    for (const raw of scenario.events) {
      if (this.cancelled.has(request.agentId)) throw new RunCancelledError();
      const { __write, ...event } = raw;
      if (__write) {
        this.assertWriteMatchesEvent(__write.path, event, request.workspacePath);
        await this.applyWrite(request.workspacePath, __write);
      }
      parseCodexEventLine(
        JSON.stringify(event),
        { messages: [], threadId: null, usage: null, errors: [] },
        request.observer,
      );
      if (request.observer?.violation) {
        const violation = violationError(request.observer);
        if (violation) throw violation;
      }
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    // Re-check cancellation after the last event, since a run whose remaining
    // events are only narrative (reasoning/message) would otherwise complete.
    if (this.cancelled.has(request.agentId)) throw new RunCancelledError();
    const violation = request.observer ? violationError(request.observer) : null;
    if (violation) throw violation;
    return {
      output: scenario.finalMessage ?? "Replay completed.",
      threadId: request.threadId ?? "replay-thread",
      usage: null,
    };
  }

  /**
   * A replay may not write one path while reporting another. The path it writes
   * must be one of the file_change paths the same event reports; otherwise the
   * scenario is inconsistent and the run is failed (and rolled back upstream).
   */
  private assertWriteMatchesEvent(
    writePath: string,
    event: Record<string, unknown>,
    workspaceRoots: string,
  ): void {
    const item = extractItem(event);
    const action = item ? itemToAction(item, [workspaceRoots]) : null;
    if (!action || action.kind !== "file_change") return;
    const normalizedWrite = writePath.replace(/\\/g, "/").replace(/^\.\//, "");
    const reported = action.paths.map((p) => p.replace(/^\.\//, ""));
    if (!reported.includes(normalizedWrite)) {
      throw new Error(
        "Replay scenario is inconsistent: it writes '" +
          writePath +
          "' but the event reports [" +
          reported.join(", ") +
          "]",
      );
    }
  }

  private async load(workspacePath: string): Promise<Scenario> {
    const file = await this.resolveScenarioFile(workspacePath);
    const raw = await (await import("node:fs/promises")).readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Scenario;
    if (!Array.isArray(parsed.events)) {
      throw new Error("Replay scenario must contain an events array");
    }
    return parsed;
  }

  private async resolveScenarioFile(workspacePath: string): Promise<string> {
    const info = await stat(this.scenarioPath).catch(() => null);
    if (!info?.isDirectory()) return this.scenarioPath;
    const poisoned = await this.hasMarker(workspacePath);
    return path.join(this.scenarioPath, poisoned ? POISONED_FILE : BENIGN_FILE);
  }

  private async hasMarker(workspacePath: string): Promise<boolean> {
    const marker = path.join(workspacePath, POISON_MARKER);
    return stat(marker)
      .then((entry) => entry.isFile())
      .catch(() => false);
  }

  private async applyWrite(
    workspacePath: string,
    write: { path: string; content: string },
  ): Promise<void> {
    const root = path.resolve(workspacePath);
    const target = path.resolve(root, write.path);
    const realRoot = await realpath(root);

    // Lexical containment: reject `..` path components and absolute escapes.
    const relative = path.relative(root, target);
    const firstSegment = relative.split(path.sep)[0];
    if (relative === "" || firstSegment === ".." || path.isAbsolute(relative)) {
      throw new Error("Replay write escapes the workspace: " + write.path);
    }

    // Physical containment of the PARENT: resolve symlinks on the deepest existing
    // ancestor so a `tests -> /tmp/outside` directory link cannot smuggle a write
    // out of the tree.
    const realParent = await realpathAncestor(path.dirname(target));
    if (escapes(realRoot, realParent)) {
      throw new Error("Replay write escapes the workspace via a symlink: " + write.path);
    }

    // Physical containment of the TARGET ITSELF: if it already exists as a
    // symlink, its real location must be inside the workspace, otherwise writing
    // through it would overwrite an external file (e.g. tests/out.txt -> /tmp/x).
    const existing = await lstat(target).catch(() => null);
    if (existing?.isSymbolicLink()) {
      const realTarget = await realpath(target).catch(() => null);
      if (!realTarget || escapes(realRoot, realTarget)) {
        throw new Error("Replay write escapes the workspace via a symlink: " + write.path);
      }
    }

    await mkdir(path.dirname(target), { recursive: true });
    // O_NOFOLLOW closes the TOCTOU window: if the final component is (or becomes)
    // a symlink between the check and the open, the open fails instead of
    // following it out of the workspace.
    const handle = await open(target, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW);
    try {
      await handle.writeFile(write.content);
    } finally {
      await handle.close();
    }
  }
}

/** True when `target` (already real) is not inside real `root`. */
function escapes(realRoot: string, target: string): boolean {
  const rel = path.relative(realRoot, target);
  return rel !== "" && (rel.split(path.sep)[0] === ".." || path.isAbsolute(rel));
}

/** realpath of the deepest ancestor of `p` that actually exists. */
async function realpathAncestor(p: string): Promise<string> {
  let current = p;
  // Walk up until a component resolves.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}
