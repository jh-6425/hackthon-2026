import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 1,
  agents: [],
  messages: [],
  runs: [],
  warrants: [],
  spans: [],
});

const withAgentDefaults = (a: any) => ({
  quarantined: false,
  quarantineReason: null,
  ...a,
});
const isPlain = (v: any): boolean =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const strArr = (v: any): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
const bool = (v: any, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const strOrNull = (v: any): string | null => (typeof v === "string" ? v : null);
const num = (v: any, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

const migrateDiagnostics = (v: any): any => {
  if (!isPlain(v)) return null; // string/array/garbage -> no fake evidence
  const legacy = !("reconciliationStatus" in v);
  const status =
    v.reconciliationStatus === "verified" || v.reconciliationStatus === "unverifiable"
      ? v.reconciliationStatus
      : "unverifiable";
  return {
    reconciliationStatus: status,
    reconciliationError:
      strOrNull(v.reconciliationError) ??
      (legacy ? "Legacy run predates reconciliation status" : null),
    changedPaths: strArr(v.changedPaths),
    reportedPaths: strArr(v.reportedPaths),
    outOfBandPaths: strArr(v.outOfBandPaths),
    strayPaths: strArr(v.strayPaths),
    reportedWriteCount: num(v.reportedWriteCount, 0),
  };
};

const migrateContainment = (v: any): any => {
  if (!isPlain(v)) return null; // string/array/garbage -> drop
  return {
    clause: typeof v.clause === "string" ? v.clause : "unknown",
    reason: typeof v.reason === "string" ? v.reason : "",
    action: typeof v.action === "string" ? v.action : "",
    protectedAsset: strOrNull(v.protectedAsset),
    authorizedScope: strArr(v.authorizedScope),
    beforeDigest: strOrNull(v.beforeDigest),
    afterDigest: strOrNull(v.afterDigest),
    assetDigestMatches: bool(v.assetDigestMatches, false),
    recoveryFailed: bool(v.recoveryFailed, false),
    recoveryError: strOrNull(v.recoveryError),
    rolledBack: bool(v.rolledBack, false),
    digestMatches: bool(v.digestMatches, false),
    fileCount: num(v.fileCount, 0),
  };
};

const withRunDefaults = (r: any) => {
  const run = { containment: null, diagnostics: null, ...r };
  run.containment = run.containment == null ? null : migrateContainment(run.containment);
  run.diagnostics = run.diagnostics == null ? null : migrateDiagnostics(run.diagnostics);
  return run;
};

const withDefaults = (parsed: Database): Database => ({
  ...parsed,
  agents: (parsed.agents ?? []).map(withAgentDefaults),
  messages: parsed.messages ?? [],
  runs: (parsed.runs ?? []).map(withRunDefaults),
  warrants: parsed.warrants ?? [],
  spans: parsed.spans ?? [],
});

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Database;
      if (parsed.version !== 1 || !Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      this.data = withDefaults(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
