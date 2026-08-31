export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "awaiting-warrant"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export type WarrantStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "revoked"
  | "expired";

export interface WarrantScope {
  writePaths: string[];
  commands: string[];
  denyCommands: string[];
  networkEgress: boolean;
  maxFileWrites: number;
  maxCommands: number;
}

export interface Warrant {
  id: string;
  agentId: string;
  runId: string | null;
  intent: string;
  summary: string;
  scope: WarrantScope;
  status: WarrantStatus;
  compiledBy: "model" | "fallback";
  issuedAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

export interface RunContainment {
  clause: string;
  reason: string;
  action: string;
  rolledBack: boolean;
  digestMatches: boolean;
  fileCount: number;
}

export interface TraceSpan {
  id: string;
  runId: string;
  agentId: string;
  warrantId: string | null;
  sequence: number;
  kind: "command" | "file_change" | "tool_call" | "run" | "reasoning" | "message";
  label: string;
  detail: string;
  verdict: "allow" | "block" | null;
  clause: string | null;
  reason: string | null;
  status: "ok" | "error" | "blocked";
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  warrantId: string | null;
  containment: RunContainment | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
