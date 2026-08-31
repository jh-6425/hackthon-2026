import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError, WarrantViolationError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WarrantCompiler, type IntentCompiler } from "./warrant/compiler.js";
import { ConformanceMonitor } from "./warrant/monitor.js";
import { WorkspaceSnapshot } from "./warrant/snapshot.js";
import type {
  RunContainment,
  TraceSpan,
  Warrant,
} from "./warrant/types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly snapshotRoot: string;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly compiler: IntentCompiler = new WarrantCompiler(config),
  ) {
    this.snapshotRoot = path.join(config.dataDirectory, "snapshots");
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message; warrant: Warrant }> {
    if (
      this.config.runtimeProvider !== "replay" &&
      !isArkConfigured(this.config)
    ) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const agent = this.getAgent(agentId);
    if (agent.status === "stopped") {
      throw new HttpError(409, "Start the Agent before sending a message");
    }
    if (agent.status === "busy") {
      throw new HttpError(409, "This Agent is already running");
    }

    const runId = randomUUID();
    const warrant = await this.compiler.compile(agent, prompt, runId);
    const autoApprove = this.config.warrantAutoApprove;
    const timestamp = now();
    if (autoApprove) {
      warrant.status = "approved";
      warrant.decidedAt = timestamp;
    }
    const run: AgentRun = {
      id: runId,
      agentId,
      status: autoApprove ? "queued" : "awaiting-warrant",
      prompt,
      output: null,
      error: null,
      usage: null,
      warrantId: warrant.id,
      containment: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      database.warrants.push(warrant);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    if (autoApprove) {
      this.launch(agentAtStart, run, warrant);
    }
    return { run, message, warrant };
  }

  getWarrant(warrantId: string): Warrant {
    const warrant = this.store
      .snapshot()
      .warrants.find((item) => item.id === warrantId);
    if (!warrant) {
      throw new HttpError(404, "Warrant not found");
    }
    return warrant;
  }

  getWarrants(agentId: string): Warrant[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .warrants.filter((warrant) => warrant.agentId === agentId)
      .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt));
  }

  getSpans(runId: string): TraceSpan[] {
    this.getRun(runId);
    return this.store
      .snapshot()
      .spans.filter((span) => span.runId === runId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async decideWarrant(
    warrantId: string,
    approve: boolean,
  ): Promise<{ warrant: Warrant; run: AgentRun }> {
    const timestamp = now();
    const decided = await this.store.mutate((database) => {
      const warrant = database.warrants.find((item) => item.id === warrantId);
      if (!warrant) {
        throw new HttpError(404, "Warrant not found");
      }
      if (warrant.status !== "pending") {
        throw new HttpError(409, "This warrant is already " + warrant.status);
      }
      const run = database.runs.find((item) => item.id === warrant.runId);
      if (!run) {
        throw new HttpError(404, "No run is attached to this warrant");
      }
      if (run.status !== "awaiting-warrant") {
        throw new HttpError(409, "This run is no longer awaiting a warrant");
      }
      const agent = database.agents.find((item) => item.id === warrant.agentId);
      const expired = Date.parse(warrant.expiresAt) <= Date.parse(timestamp);
      if (approve && expired) {
        // Approving a warrant whose TTL already elapsed would launch a run the
        // monitor blocks on its first action; expire it cleanly instead.
        warrant.status = "expired";
        warrant.decidedAt = timestamp;
        run.status = "cancelled";
        run.error = "The execution warrant expired before it was approved";
        run.completedAt = timestamp;
        if (agent && agent.status !== "stopped") {
          agent.status = "ready";
          agent.updatedAt = timestamp;
        }
        return {
          warrant: structuredClone(warrant),
          run: structuredClone(run),
          agent: null,
        };
      }
      if (approve && agent && agent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before approving this warrant");
      }
      warrant.status = approve ? "approved" : "rejected";
      warrant.decidedAt = timestamp;
      if (approve) {
        run.status = "queued";
      } else {
        run.status = "cancelled";
        run.error = "Operator rejected the execution warrant";
        run.completedAt = timestamp;
        if (agent && agent.status !== "stopped") {
          agent.status = "ready";
          agent.updatedAt = timestamp;
        }
      }
      return {
        warrant: structuredClone(warrant),
        run: structuredClone(run),
        agent: agent ? structuredClone(agent) : null,
      };
    });
    if (approve && decided.agent) {
      this.launch(decided.agent, decided.run, decided.warrant);
    }
    return { warrant: decided.warrant, run: decided.run };
  }

  async revokeWarrant(warrantId: string): Promise<Warrant> {
    const current = this.getWarrant(warrantId);
    if (current.status === "revoked") {
      return current;
    }
    const timestamp = now();
    const revoked = await this.store.mutate((database) => {
      const warrant = database.warrants.find((item) => item.id === warrantId);
      if (!warrant) {
        throw new HttpError(404, "Warrant not found");
      }
      warrant.status = "revoked";
      warrant.decidedAt = timestamp;
      return structuredClone(warrant);
    });
    await this.cancelExecution(current.agentId);
    await this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === current.runId);
      if (run && (run.status === "awaiting-warrant" || run.status === "queued")) {
        run.status = "cancelled";
        run.error = "Operator revoked the execution warrant";
        run.completedAt = timestamp;
      }
      const agent = database.agents.find((item) => item.id === current.agentId);
      if (agent && agent.status === "busy") {
        agent.status = "ready";
        agent.updatedAt = timestamp;
      }
    });
    return revoked;
  }

  private launch(agentAtStart: Agent, run: AgentRun, warrant: Warrant): void {
    const execution = this.executeRun(agentAtStart, run, warrant);
    this.activeExecutions.set(agentAtStart.id, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentAtStart.id) === execution) {
          this.activeExecutions.delete(agentAtStart.id);
        }
      })
      .catch(() => undefined);
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    warrant: Warrant,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });

    const monitor = new ConformanceMonitor(
      warrant,
      run.id,
      [agentAtStart.workspacePath, "/workspace"],
      () => new Date(),
      () =>
        this.store.snapshot().warrants.find((item) => item.id === warrant.id)
          ?.status ?? warrant.status,
    );
    const snapshot = await this.captureSnapshot(agentAtStart, run.id);
    if (!snapshot) {
      // Fail closed: without a pre-run snapshot there is no rollback safety net,
      // so the run must not proceed.
      const failedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = "failed";
          storedRun.error = "Could not capture a workspace snapshot; run refused to protect the workspace";
          storedRun.completedAt = failedAt;
        }
        if (agent && agent.status !== "stopped") {
          agent.status = "error";
          agent.lastError = "Warrant could not snapshot the workspace before running";
          agent.updatedAt = failedAt;
        }
      });
      return;
    }

    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        observer: monitor,
      });
      await this.persistSpans(monitor.spans);
      await snapshot.discard();
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const violation = error instanceof WarrantViolationError ? error : null;
      const message = error instanceof Error ? error.message : String(error);
      const containment = violation ? await this.contain(violation, snapshot) : null;
      await this.persistSpans(monitor.spans);
      if (!violation) await snapshot.discard();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = violation
            ? "blocked"
            : cancelled
              ? "cancelled"
              : "failed";
          storedRun.error = message;
          storedRun.containment = containment;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled || violation ? "ready" : "error";
          }
          agent.lastError = cancelled || violation ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private async captureSnapshot(
    agent: Agent,
    runId: string,
  ): Promise<WorkspaceSnapshot | null> {
    try {
      return await WorkspaceSnapshot.capture(
        agent.workspacePath,
        this.snapshotRoot,
        runId,
      );
    } catch {
      return null;
    }
  }

  private async contain(
    violation: WarrantViolationError,
    snapshot: WorkspaceSnapshot | null,
  ): Promise<RunContainment> {
    const containment: RunContainment = {
      clause: violation.clause,
      reason: violation.reason,
      action: violation.action,
      rolledBack: false,
      digestMatches: false,
      fileCount: 0,
    };
    if (!snapshot) return containment;
    try {
      const report = await snapshot.restore();
      await snapshot.discard();
      return {
        ...containment,
        rolledBack: report.restored,
        digestMatches: report.digestMatches,
        fileCount: report.fileCount,
      };
    } catch {
      return containment;
    }
  }

  private async persistSpans(spans: TraceSpan[]): Promise<void> {
    if (spans.length === 0) return;
    await this.store.mutate((database) => {
      database.spans.push(...spans);
      const overflow = database.spans.length - this.config.warrantTraceLimit;
      if (overflow > 0) database.spans.splice(0, overflow);
    });
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
