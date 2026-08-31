import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseCodexEventLine, violationError } from "../codex-runner.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";

/**
 * A deterministic runner that replays a recorded Codex event stream instead of
 * spawning a container. It exists so the middleware can be demonstrated and
 * tested end to end without an Ark key, Docker, or the Codex CLI: the events
 * flow through the real parser, monitor, policy engine, and rollback path.
 *
 * A scenario is a JSON file: { "delayMs"?: number, "events": [ { event }, ... ] }.
 * An event may carry a helper field `__write` — { path, content } — which the
 * runner applies to the workspace before emitting the event, so a file_change
 * event corresponds to a real mutation that rollback can undo.
 */

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
    const scenario = await this.load(request.prompt);
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

  private async load(prompt: string): Promise<Scenario> {
    const file = await this.resolveScenarioFile(prompt);
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Scenario;
    if (!Array.isArray(parsed.events)) {
      throw new Error("Replay scenario must contain an events array");
    }
    return parsed;
  }

  private async resolveScenarioFile(prompt: string): Promise<string> {
    const info = await stat(this.scenarioPath).catch(() => null);
    if (!info?.isDirectory()) return this.scenarioPath;
    // A prompt asking for an injection/attack task selects the poisoned stream;
    // any other task selects the benign stream. This keeps a single live-demo
    // session flowing without restarting the server.
    const attack = /inject|poison|attack|exfil|leak|malicious/i.test(prompt);
    return path.join(this.scenarioPath, attack ? "poisoned.json" : "benign.json");
  }

  private async applyWrite(
    workspacePath: string,
    write: { path: string; content: string },
  ): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const target = path.resolve(workspacePath, write.path);
    if (!target.startsWith(path.resolve(workspacePath))) {
      throw new Error("Replay write escapes the workspace: " + write.path);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, write.content);
  }
}
