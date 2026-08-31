export type WarrantStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "revoked"
  | "expired";

export type Verdict = "allow" | "block";

export type ActionKind = "command" | "file_change" | "tool_call";

export interface WarrantScope {
  writePaths: string[];
  commands: string[];
  denyCommands: string[];
  tools: string[];
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
  compiledBy: "model" | "local" | "fallback";
  issuedAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

export type AgentAction =
  | { kind: "command"; itemId: string; command: string }
  | { kind: "file_change"; itemId: string; paths: string[] }
  | { kind: "tool_call"; itemId: string; tool: string };

export interface WarrantUsage {
  commands: number;
  fileWrites: number;
}

export interface PolicyDecision {
  verdict: Verdict;
  clause: string;
  reason: string;
  subject: string | null;
}

export type SpanKind = ActionKind | "run" | "reasoning" | "message";

export type SpanStatus = "ok" | "error" | "blocked";

export interface TraceSpan {
  id: string;
  runId: string;
  agentId: string;
  warrantId: string | null;
  sequence: number;
  kind: SpanKind;
  label: string;
  detail: string;
  verdict: Verdict | null;
  clause: string | null;
  reason: string | null;
  status: SpanStatus;
  createdAt: string;
}

export interface WarrantViolation {
  action: AgentAction;
  decision: PolicyDecision;
}

export interface RunObserver {
  observe(event: Record<string, unknown>): void;
  readonly violation: WarrantViolation | null;
}

export interface RunContainment {
  clause: string;
  reason: string;
  action: string;
  protectedAsset: string | null;
  authorizedScope: string[];
  beforeDigest: string | null;
  afterDigest: string | null;
  assetDigestMatches: boolean;
  recoveryFailed: boolean;
  recoveryError: string | null;
  rolledBack: boolean;
  digestMatches: boolean;
  fileCount: number;
}

export const emptyUsage = (): WarrantUsage => ({ commands: 0, fileWrites: 0 });
