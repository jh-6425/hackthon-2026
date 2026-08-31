import { randomUUID } from "node:crypto";
import { describeAction, extractItem, itemToAction } from "./events.js";
import { applyUsage, evaluateAction } from "./policy.js";
import {
  emptyUsage,
  type AgentAction,
  type PolicyDecision,
  type RunObserver,
  type SpanKind,
  type TraceSpan,
  type Warrant,
  type WarrantUsage,
  type WarrantViolation,
} from "./types.js";

const NARRATIVE_KINDS: Record<string, SpanKind> = {
  reasoning: "reasoning",
  agent_message: "message",
};

const truncate = (value: string, limit = 400): string =>
  value.length > limit ? value.slice(0, limit) + "…" : value;

export class ConformanceMonitor implements RunObserver {
  private usage: WarrantUsage = emptyUsage();
  private readonly evaluated = new Set<string>();
  private readonly narrated = new Set<string>();
  private readonly collected: TraceSpan[] = [];
  private violationState: WarrantViolation | null = null;

  constructor(
    private readonly warrant: Warrant,
    private readonly runId: string,
    private readonly workspaceRoots: string[],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get violation(): WarrantViolation | null {
    return this.violationState;
  }

  get spans(): TraceSpan[] {
    return this.collected;
  }

  get consumption(): WarrantUsage {
    return this.usage;
  }

  observe(event: Record<string, unknown>): void {
    const item = extractItem(event);
    if (!item) return;

    const narrativeKind = NARRATIVE_KINDS[item.type];
    if (narrativeKind) {
      if (event.type !== "item.completed" || this.narrated.has(item.id)) return;
      this.narrated.add(item.id);
      const text = typeof item.raw.text === "string" ? item.raw.text : "";
      this.push(narrativeKind, item.type, truncate(text), null, "ok");
      return;
    }

    const action = itemToAction(item, this.workspaceRoots);
    if (!action) return;
    const key = action.kind + ":" + action.itemId;
    if (this.evaluated.has(key)) return;
    this.evaluated.add(key);
    this.inspect(action);
  }

  private inspect(action: AgentAction): void {
    if (this.violationState) return;
    const decision = evaluateAction(
      action,
      this.warrant,
      this.usage,
      this.clock(),
    );
    const blocked = decision.verdict === "block";
    this.push(
      action.kind,
      action.kind,
      truncate(describeAction(action)),
      decision,
      blocked ? "blocked" : "ok",
    );
    if (blocked) {
      this.violationState = { action, decision };
      return;
    }
    this.usage = applyUsage(action, this.usage);
  }

  private push(
    kind: SpanKind,
    label: string,
    detail: string,
    decision: PolicyDecision | null,
    status: TraceSpan["status"],
  ): void {
    this.collected.push({
      id: randomUUID(),
      runId: this.runId,
      agentId: this.warrant.agentId,
      warrantId: this.warrant.id,
      sequence: this.collected.length,
      kind,
      label,
      detail,
      verdict: decision?.verdict ?? null,
      clause: decision?.clause ?? null,
      reason: decision?.reason ?? null,
      status,
      createdAt: this.clock().toISOString(),
    });
  }
}
