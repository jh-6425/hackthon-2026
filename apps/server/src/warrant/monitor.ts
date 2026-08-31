import { randomUUID } from "node:crypto";
import { describeAction, extractItem, itemToAction } from "./events.js";
import { applyUsage, evaluateAction } from "./policy.js";
import { canonicalizePath } from "./glob.js";
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
  private readonly evaluatedPaths = new Map<string, Set<string>>();
  private readonly narrated = new Set<string>();
  private readonly collected: TraceSpan[] = [];
  private violationState: WarrantViolation | null = null;
  private noIdSeq = 0;

  constructor(
    private readonly warrant: Warrant,
    private readonly runId: string,
    private readonly workspaceRoots: string[],
    private readonly clock: () => Date = () => new Date(),
    private readonly liveStatus: () => Warrant["status"] = () => warrant.status,
  ) {}

  get violation(): WarrantViolation | null {
    // Return a defensive deep copy so a Runner holding the observer cannot mutate
    // the recorded violation (clause/subject/paths) and poison containment.
    return this.violationState ? structuredClone(this.violationState) : null;
  }

  get spans(): TraceSpan[] {
    return structuredClone(this.collected);
  }

  get consumption(): WarrantUsage {
    return { ...this.usage };
  }

  /** Every file path the Agent reported via a file_change event. */
  get reportedPaths(): Set<string> {
    const all = new Set<string>();
    for (const set of this.evaluatedPaths.values()) {
      for (const p of set) if (p !== "") all.add(p);
    }
    return all;
  }

  observe(event: Record<string, unknown>): void {
    const item = extractItem(event);
    if (!item) return;

    const narrativeKind = NARRATIVE_KINDS[item.type];
    if (narrativeKind) {
      const narrKey = item.id ?? "__noid_" + this.noIdSeq++;
      if (event.type !== "item.completed" || this.narrated.has(narrKey)) return;
      this.narrated.add(narrKey);
      const text = typeof item.raw.text === "string" ? item.raw.text : "";
      this.push(narrativeKind, item.type, truncate(text), null, "ok");
      return;
    }

    const action = itemToAction(item, this.workspaceRoots);
    if (!action) return;
    // A missing item id must NOT be de-duplicated by a shared fallback (that
    // would let two real writes count once). Give each id-less item a unique key.
    const itemKey = item.id ?? "__noid_" + this.noIdSeq++;

    if (action.kind === "file_change") {
      // Canonicalize and de-duplicate BEFORE counting so tests/a.ts and
      // tests/./a.ts (or a path repeated within one event) are one write.
      const canonical: string[] = [];
      const local = new Set<string>();
      for (const raw of action.paths) {
        const key = canonicalizePath(raw);
        if (!local.has(key)) {
          local.add(key);
          canonical.push(key);
        }
      }
      const seen = this.evaluatedPaths.get(itemKey) ?? new Set<string>();
      const fresh = canonical.filter((path) => !seen.has(path));
      if (fresh.length === 0) return;
      for (const path of fresh) seen.add(path);
      this.evaluatedPaths.set(itemKey, seen);
      this.inspect({ kind: "file_change", itemId: itemKey, paths: fresh });
      return;
    }

    const key = action.kind + ":" + itemKey;
    if (this.evaluated.has(key)) return;
    this.evaluated.add(key);
    this.inspect(action);
  }

  private inspect(action: AgentAction): void {
    if (this.violationState) return;
    // Re-read the warrant status from the source of truth so a revocation or
    // expiry that lands mid-run is enforced on the next action, not just by the
    // container teardown.
    const current: Warrant = { ...this.warrant, status: this.liveStatus() };
    const decision = evaluateAction(action, current, this.usage, this.clock());
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
