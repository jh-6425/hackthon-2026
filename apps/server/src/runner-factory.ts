import type { AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import type { AgentRunner } from "./types.js";
import { ReplayRunner } from "./warrant/replay-runner.js";

export function createRunner(config: AppConfig): AgentRunner {
  if (config.runtimeProvider === "replay") {
    if (!config.replayScenario) {
      throw new Error("RUNTIME_PROVIDER=replay requires REPLAY_SCENARIO to point at a scenario file");
    }
    return new ReplayRunner(config.replayScenario);
  }
  return config.runtimeProvider === "container"
    ? new ContainerCodexRunner(config)
    : new CodexRunner(config);
}
