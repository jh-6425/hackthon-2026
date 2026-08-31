import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseCodexEventLine, violationError } from "../codex-runner.js";
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
  constructor(private readonly scenarioPath: string) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const scenario = await this.load(request.workspacePath);
    const delay = scenario.delayMs ?? 350;
    for (const raw of scenario.events) {
      const { __write, ...event } = raw;
      if (__write) {
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
    const violation = request.observer ? violationError(request.observer) : null;
    if (violation) throw violation;
    return {
      output: scenario.finalMessage ?? "Replay completed.",
      threadId: request.threadId ?? "replay-thread",
      usage: null,
    };
  }

  private async load(workspacePath: string): Promise<Scenario> {
    const file = await this.resolveScenarioFile(workspacePath);
    const raw = await readFile(file, "utf8");
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
    const { mkdir, writeFile } = await import("node:fs/promises");
    const root = path.resolve(workspacePath);
    const target = path.resolve(root, write.path);
    const relative = path.relative(root, target);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Replay write escapes the workspace: " + write.path);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, write.content);
  }
}
