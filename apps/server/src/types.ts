import type {
  RunContainment,
  RunObserver,
  TraceSpan,
  Warrant,
} from "./warrant/types.js";

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "awaiting-warrant"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  quarantined: boolean;
  quarantineReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  warrantId: string | null;
  containment: RunContainment | null;
  diagnostics: RunDiagnostics | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  warrants: Warrant[];
  spans: TraceSpan[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  observer?: RunObserver | undefined;
}

export interface RunDiagnostics {
  // In-scope, within-budget writes that were not reported as file_change events.
  outOfBandPaths: string[];
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
  // Optional: resolves only once every child process / background task the run
  // spawned has terminated. Finalization awaits this before reconciling so a
  // post-return write cannot escape the safety check. Runners that fully await
  // their work (the container and replay runners) may omit it.
  settled?(agentId: string): Promise<void>;
}
