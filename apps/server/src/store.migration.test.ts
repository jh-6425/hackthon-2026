import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

describe("JsonStore migration of historic data", () => {
  it("fills new nested fields on old diagnostics/containment without dropping existing ones", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "warrant-migrate-"));
    roots.push(root);
    const file = path.join(root, "launchpad.json");
    await mkdir(root, { recursive: true });
    const legacy = {
      version: 1,
      agents: [{ id: "a", name: "x", description: "", instructions: "", status: "ready", workspacePath: "/w", codexThreadId: null, lastError: null, createdAt: "t", updatedAt: "t" }],
      messages: [],
      runs: [{
        id: "r", agentId: "a", status: "blocked", prompt: "p", output: null, error: "e", usage: null, warrantId: "w",
        containment: { clause: "scope.writePaths", reason: "x", action: "a", protectedAsset: "src/a.ts", authorizedScope: ["tests/**"], beforeDigest: null, afterDigest: null, assetDigestMatches: false, recoveryFailed: false, rolledBack: true, digestMatches: true, fileCount: 1 },
        diagnostics: { outOfBandPaths: ["tests/a.ts"] },
        startedAt: "t", completedAt: "t", createdAt: "t",
      }],
      warrants: [],
      spans: [],
    };
    await writeFile(file, JSON.stringify(legacy));
    const store = new JsonStore(file);
    await store.initialize();
    const db = store.snapshot();
    const run = db.runs[0]!;
    // nested diagnostics migrated
    expect(run.diagnostics).toMatchObject({
      outOfBandPaths: ["tests/a.ts"], // preserved
      changedPaths: [], reportedPaths: [], strayPaths: [], reportedWriteCount: 0,
      reconciliationStatus: "unverifiable",
      reconciliationError: "Legacy run predates reconciliation status",
    });
    // containment gets recoveryError
    expect(run.containment).toHaveProperty("recoveryError", null);
    // agents get quarantine defaults
    expect(db.agents[0]).toMatchObject({ quarantined: false, quarantineReason: null });
  });
});

describe("JsonStore rejects/normalizes dirty nested types (R7-8)", () => {
  const load = async (run: unknown) => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(os.tmpdir() + "/warrant-dirty-");
    roots.push(root);
    const file = root + "/launchpad.json";
    await mkdir(root, { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, agents: [], messages: [], runs: [run], warrants: [], spans: [] }));
    const store = new JsonStore(file);
    await store.initialize();
    return store.snapshot().runs[0]!;
  };
  const base = { id: "r", agentId: "a", status: "failed", prompt: "p", output: null, error: "e", usage: null, warrantId: "w", startedAt: "t", completedAt: "t", createdAt: "t" };

  it("string diagnostics/containment become null (no fake evidence)", async () => {
    const run = await load({ ...base, diagnostics: "bad", containment: "bad" });
    expect(run.diagnostics).toBeNull();
    expect(run.containment).toBeNull();
  });
  it("array containment becomes null; wrong field types get safe defaults", async () => {
    const run = await load({ ...base, containment: [], diagnostics: { changedPaths: "bad", reportedWriteCount: "7", reconciliationStatus: "bogus" } });
    expect(run.containment).toBeNull();
    expect(run.diagnostics).toMatchObject({ changedPaths: [], reportedWriteCount: 0, reconciliationStatus: "unverifiable" });
  });
});
